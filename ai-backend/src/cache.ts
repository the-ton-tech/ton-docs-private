/**
 * In-memory LRU cache for streamed chat responses.
 *
 * Keyed on a SHA-256 of (model, normalized-messages-json, currentPageUrl).
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

interface CacheEntry {
  chunks: Uint8Array[];
  headers: Record<string, string>;
  status: number;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

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
        const data = (part as { data?: unknown }).data;
        parts.push({ type: "data-client", data });
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
    messages: normaliseMessages(messages),
  });
  return createHash("sha256").update(payload).digest("hex");
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
 * are cached; the buffered copy is discarded on stream error.
 */
export function interceptAndCache(response: Response, key: string): Response {
  if (!response.body || response.status < 200 || response.status >= 300) {
    return response;
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

  void (async () => {
    const reader = toCache.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const now = Date.now();
      evictExpired(now);
      evictLruIfFull();
      store.set(key, {
        chunks,
        headers,
        status,
        expiresAt: now + config.cacheTtlMs,
      });
    } catch (err) {
      console.warn(`[cache] failed to buffer stream: ${(err as Error).message}`);
    }
  })();

  const clientHeaders = new Headers(response.headers);
  clientHeaders.set("x-cache", "MISS");
  return new Response(toClient, {
    status,
    statusText: response.statusText,
    headers: clientHeaders,
  });
}
