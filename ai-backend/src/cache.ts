/**
 * In-memory LRU cache for streamed chat responses.
 *
 * Keyed on a SHA-256 of (model, normalized-messages-json, promptVersion).
 * On a hit we replay the buffered stream chunks; on a miss we tee the live
 * stream into the LRU so subsequent identical conversations replay instead
 * of burning a daily slot against the OpenRouter free tier.
 *
 * Normalization strips message `id`s (which vary per turn) and keeps only
 * the `role` and the `parts` the model actually sees (text + data-client).
 * Caching is skipped if no recoverable user message is present.
 */

import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import { config } from "./config.js";
import { SYSTEM_PROMPT } from "./chat.js";

export interface CacheEntry {
  chunks: Uint8Array[];
  headers: Record<string, string>;
  status: number;
  expiresAt: number;
  staleAt: number;
}

const HARD_TTL_MS = 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT_VERSION = createHash("sha256")
  .update(SYSTEM_PROMPT)
  .digest("hex")
  .slice(0, 12);

const store = new Map<string, CacheEntry>();
// Single-flight: dedupe concurrent identical requests so only one upstream
// call burns a daily slot; the rest await the buffered entry.
const inflight = new Map<string, Promise<CacheEntry | null>>();

function evictExpired(now: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

function evictLruIfFull(): void {
  while (store.size >= config.cacheMaxEntries) {
    // Map iteration order is insertion order — the oldest key is first.
    const firstKey = store.keys().next().value;
    if (firstKey === undefined) break;
    store.delete(firstKey);
  }
}

interface NormalisedPart {
  type: string;
  text?: string;
  data?: unknown;
}

interface NormalisedMessage {
  role: string;
  parts: NormalisedPart[];
}

function normaliseMessages(messages: UIMessage[]): NormalisedMessage[] {
  return messages.map((message) => {
    const parts: NormalisedPart[] = [];
    for (const part of message.parts ?? []) {
      if (part.type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") parts.push({ type: "text", text });
      } else if (part.type === "data-client") {
        const data = (part as { data?: { location?: unknown } }).data;
        const location = typeof data?.location === "string" ? data.location : null;
        parts.push({ type: "data-client", data: { location } });
      }
    }
    return { role: message.role, parts };
  });
}

function hasUserMessage(messages: UIMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts ?? []) {
      if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Compute the cache key for a chat turn, or `null` if the conversation is
 * not cacheable (no recoverable user message). The normalised messages
 * already include the `data-client` part the chat layer reads currentPageUrl
 * from, so it does not need to be passed in separately.
 */
export function cacheKey(messages: UIMessage[]): string | null {
  if (!hasUserMessage(messages)) return null;
  const payload = JSON.stringify({
    model: config.model,
    promptVersion: SYSTEM_PROMPT_VERSION,
    messages: normaliseMessages(messages),
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** True when the entry has crossed its soft TTL but is still within the hard expiry. */
export function isStale(entry: CacheEntry, now: number): boolean {
  return entry.staleAt <= now && entry.expiresAt > now;
}

/** Look up a cached response. Returns `null` on miss or expiry. */
export function getCached(key: string): CacheEntry | null {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    store.delete(key);
    return null;
  }
  // Touch: re-insert to move to the MRU end.
  store.delete(key);
  store.set(key, entry);
  return entry;
}

/**
 * If an identical request is already streaming, return its in-flight promise
 * so callers can await the buffered entry instead of firing a duplicate
 * OpenRouter call. Resolves to null when the in-flight stream produced no
 * cacheable entry (error, abort, non-2xx).
 */
export function getOrAwait(key: string): Promise<CacheEntry | null> | null {
  return inflight.get(key) ?? null;
}

/** Build a Response that replays a cached stream entry. */
export function replayCached(entry: CacheEntry): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of entry.chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    status: entry.status,
    headers: { ...entry.headers, "x-cache": "HIT" },
  });
}

/**
 * Wrap a streaming Response so its body is tee'd: one branch goes to the
 * client, the other accumulates into the LRU under `key`. Only 2xx responses
 * are cached; the buffered copy is discarded on stream error or client
 * abort. `abortSignal` lets the caller (server) signal a disconnect; on
 * abort `onAbort` fires exactly once and the in-flight promise resolves to
 * null. Partial chunks are never written to the LRU.
 *
 * Returns the response to hand to the client AND a `settled` promise that
 * resolves once the buffering loop finishes (success or abort). The server
 * awaits `settled` so per-request telemetry spans the full stream lifetime
 * and the SIGTERM drain can wait for live streams to finish.
 */
export function interceptAndCache(
  response: Response,
  key: string,
  abortSignal?: AbortSignal,
  onAbort?: () => void,
): { response: Response; settled: Promise<void> } {
  if (!response.body || response.status < 200 || response.status >= 300) {
    // Non-2xx / bodyless responses skip caching; `settled` resolves immediately
    // so callers can uniformly `await settled` without special-casing.
    return { response, settled: Promise.resolve() };
  }
  const [toClient, toCache] = response.body.tee();

  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    // Drop hop-by-hop / framing headers that must not be replayed verbatim.
    const lower = name.toLowerCase();
    if (lower === "content-length" || lower === "transfer-encoding") return;
    headers[lower] = value;
  });
  const status = response.status;

  let resolveInflight: (entry: CacheEntry | null) => void = () => {};
  const inflightPromise = new Promise<CacheEntry | null>((resolve) => {
    resolveInflight = resolve;
  });
  inflight.set(key, inflightPromise);

  let resolveSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  void (async () => {
    const reader = toCache.getReader();
    const chunks: Uint8Array[] = [];
    let aborted = false;
    let onAbortFired = false;
    let listenerAttached = false;
    const handleAbort = () => {
      if (onAbortFired) return;
      onAbortFired = true;
      aborted = true;
      onAbort?.();
      // Cancel the reader so the upstream tee can release resources.
      reader.cancel().catch(() => undefined);
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        handleAbort();
      } else {
        abortSignal.addEventListener("abort", handleAbort, { once: true });
        listenerAttached = true;
      }
    }
    try {
      while (true) {
        if (abortSignal?.aborted) {
          handleAbort();
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      if (aborted) {
        resolveInflight(null);
        return;
      }
      // Remove the abort listener BEFORE committing the entry, so a late
      // abort (signal fires after we've decided to cache) cannot trigger
      // `onAbort` and double-refund a slot we just successfully spent.
      if (listenerAttached && abortSignal) {
        abortSignal.removeEventListener("abort", handleAbort);
        listenerAttached = false;
      }
      const now = Date.now();
      evictExpired(now);
      evictLruIfFull();
      const entry: CacheEntry = {
        chunks,
        headers,
        status,
        staleAt: now + config.cacheTtlMs,
        expiresAt: now + HARD_TTL_MS,
      };
      store.set(key, entry);
      resolveInflight(entry);
    } catch (err) {
      console.warn(`[cache] failed to buffer stream: ${(err as Error).message}`);
      resolveInflight(null);
    } finally {
      if (listenerAttached && abortSignal) {
        abortSignal.removeEventListener("abort", handleAbort);
      }
      if (inflight.get(key) === inflightPromise) inflight.delete(key);
      // Resolve last so server.ts's `await settled` observes a fully cleaned-
      // up state (inflight map cleared, listener removed).
      resolveSettled();
    }
  })();

  const clientHeaders = new Headers(response.headers);
  clientHeaders.set("x-cache", "MISS");
  const wrapped = new Response(toClient, {
    status,
    statusText: response.statusText,
    headers: clientHeaders,
  });
  return { response: wrapped, settled };
}
