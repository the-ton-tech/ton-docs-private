/**
 * HTTP entrypoint: Hono app with CORS, rate limiting, the chat and health
 * routes, and the docs index bootstrap.
 *
 * Architecture: browser (docs site) -> nginx -> this service -> OpenRouter.
 * Binds to 127.0.0.1 only; nginx terminates TLS and proxies /api/.
 */

// Load .env for local runs (`npm run dev` / `npm start`). In production the
// systemd unit supplies the environment; dotenv does not override existing vars.
import "dotenv/config";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { UIMessage } from "ai";
import { config } from "./config.js";
import { resolveOrigin } from "./cors.js";
import { runChat } from "./chat.js";
import {
  allowPerIp,
  clientIp,
  dailyStats,
  refund,
  tryConsume,
} from "./ratelimit.js";
import {
  cacheKey,
  getCached,
  getOrAwait,
  interceptAndCache,
  replayCached,
} from "./cache.js";
import { hashIp, latencySnapshot, logChat, logFeedback, recordLatency } from "./telemetry.js";

const app = new Hono();

// Reject obviously-oversized payloads before parsing. nginx also caps the body
// (client_max_body_size); this is defense in depth for non-nginx deployments.
const MAX_BODY_BYTES = 64 * 1024;
// Upper bound on conversation length handed to the model.
const MAX_MESSAGES = 20;
// Per-message and per-conversation text-part length caps.
const MAX_TEXT_PART_CHARS = 4096;
const MAX_TOTAL_TEXT_CHARS = 16384;
// Grace period for in-flight chats during shutdown drain.
const DRAIN_TIMEOUT_MS = 30_000;

// --- Shutdown drain ---------------------------------------------------------
let draining = false;
// We track stream-settled promises (not handler IIFE promises) so a SIGTERM
// drain waits for in-flight streams to finish rather than just for TTFB.
const inflightChats = new Set<Promise<unknown>>();

// --- Prompt-injection scrub -------------------------------------------------
//
// Strip well-known instruction markers from user text so retrieval-tool
// envelopes cannot be closed early by a crafted prompt. Conservative on
// purpose — only literal tokens, no creative regex.
const INJECTION_MARKERS = [
  /<\/?system>/gi,
  /\[INST\]/g,
  /<\|im_start\|>/g,
  /<\|im_end\|>/g,
  /<\|endoftext\|>/gi,
  // chat.ts wraps tool output in <doc>…</doc> and escapes literal </doc>
  // inside tool content, but user-supplied text is never scrubbed. A user
  // sending a literal <doc …> or </doc> could otherwise spoof a doc envelope.
  /<\s*doc\b[^>]*>/gi,
  /<\/\s*doc\s*>/gi,
];
function scrubUserText(text: string): string {
  let out = text;
  for (const re of INJECTION_MARKERS) out = out.replace(re, "");
  return out;
}
function scrubMessages(messages: UIMessage[]): void {
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const part of message.parts ?? []) {
      if (part.type !== "text") continue;
      const p = part as { text?: unknown };
      if (typeof p.text === "string") p.text = scrubUserText(p.text);
    }
  }
}

// --- CORS (preflight + actual requests) for the API surface -----------------
app.use(
  "/api/*",
  cors({
    origin: (origin) => resolveOrigin(origin),
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    credentials: false,
  }),
);

// --- Per-IP rate limit + body-size guard, applied only to POST /api/chat ----
app.use("/api/chat", async (c, next) => {
  if (c.req.method !== "POST") return next();

  if (draining) {
    return c.json({ error: "shutting_down" }, 503);
  }

  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return c.json({ error: "payload_too_large" }, 413);
  }

  if (!allowPerIp(clientIp(c))) {
    c.header("Retry-After", "60");
    return c.json({ error: "rate_limited" }, 429);
  }

  return next();
});

function secondsUntilNextUtcMidnight(now = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

// --- Health -----------------------------------------------------------------
//
// Public response is intentionally minimal: leaking the live daily counter
// lets an attacker time floods against the 00:00 UTC reset. Operators read
// the live counter from /api/internal/stats with the STATS_TOKEN bearer.
app.get("/api/health", (c) => {
  if (draining) return c.json({ ok: false, draining: true }, 503);
  return c.json({ ok: true });
});

// --- Internal stats ---------------------------------------------------------
//
// 404 when STATS_TOKEN is unset, so the route does not exist for the public.
// When set, requires `Authorization: Bearer <token>`; compared in constant
// time to defeat timing-based token recovery.
app.get("/api/internal/stats", (c) => {
  const expected = config.statsToken;
  if (!expected) return c.notFound();

  const header = c.req.header("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  const expectedBuf = Buffer.from(expected, "utf8");
  const presentedBuf = Buffer.from(presented, "utf8");
  if (
    expectedBuf.length !== presentedBuf.length ||
    !timingSafeEqual(expectedBuf, presentedBuf)
  ) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const daily = dailyStats();
  return c.json({
    ok: true,
    dailyUsed: daily.used,
    dailyCap: daily.cap,
    latency: latencySnapshot(),
  });
});

// --- Chat -------------------------------------------------------------------
app.post("/api/chat", async (c) => {
  const requestId = randomUUID();
  c.header("x-request-id", requestId);

  const startedAt = Date.now();
  const ip = clientIp(c);
  const ipHash = hashIp(ip);
  let cacheHit = false;
  let refunded = false;
  let status = 200;
  let usageInfo: {
    tokensIn?: number;
    tokensOut?: number;
    finishReason?: string;
    toolCalls?: number;
  } = {};
  let turnInfo: {
    searchQueries?: string[];
    retrievedUrls?: string[];
    fetchedUrls?: string[];
    citedUrls?: string[];
    noAnswer?: boolean;
  } = {};

  const finish = (statusCode: number): void => {
    status = statusCode;
    const durationMs = Date.now() - startedAt;
    recordLatency(durationMs);
    logChat({
      ipHash,
      status,
      durationMs,
      cacheHit,
      refunded,
      requestId,
      model: config.model,
      ...usageInfo,
      ...turnInfo,
    });
  };

  let messages: UIMessage[];
  try {
    const body = (await c.req.json()) as { messages?: UIMessage[] };
    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      body.messages.length > MAX_MESSAGES
    ) {
      finish(400);
      return c.json({ error: "invalid_request" }, 400);
    }
    messages = body.messages;
  } catch {
    finish(400);
    return c.json({ error: "invalid_request" }, 400);
  }

  // Per-message + per-conversation text-part length caps.
  let totalChars = 0;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== "text") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      if (text.length > MAX_TEXT_PART_CHARS) {
        finish(413);
        return c.json({ error: "payload_too_large" }, 413);
      }
      totalChars += text.length;
      if (totalChars > MAX_TOTAL_TEXT_CHARS) {
        finish(413);
        return c.json({ error: "payload_too_large" }, 413);
      }
    }
  }

  scrubMessages(messages);

  // Cache lookup happens BEFORE tryConsume — a hit must not burn a slot.
  const key = cacheKey(messages);
  if (key) {
    const hit = getCached(key);
    if (hit) {
      cacheHit = true;
      finish(hit.status);
      return replayCached(hit);
    }
    // Single-flight: if an identical request is already streaming, await its
    // buffered entry instead of starting (and paying for) a fresh stream.
    const pending = getOrAwait(key);
    if (pending) {
      // Race the leader against (a) this follower's own client disconnect and
      // (b) a hard 30s ceiling, so a stalled leader cannot wedge followers
      // indefinitely. On signal abort or timeout we fall through to a fresh
      // tryConsume path; the leader keeps running in the background.
      const signal = c.req.raw.signal;
      const FOLLOWER_TIMEOUT_MS = 30_000;
      const ABORT = Symbol("follower-abort");
      const TIMEOUT = Symbol("follower-timeout");
      const signalPromise = new Promise<typeof ABORT>((resolve) => {
        if (signal.aborted) {
          resolve(ABORT);
          return;
        }
        signal.addEventListener("abort", () => resolve(ABORT), { once: true });
      });
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
        timeoutId = setTimeout(() => resolve(TIMEOUT), FOLLOWER_TIMEOUT_MS);
      });
      const raceResult = await Promise.race([pending, signalPromise, timeoutPromise]);
      if (timeoutId) clearTimeout(timeoutId);
      if (raceResult === ABORT) {
        // Client disconnected while waiting for the leader — no point doing
        // any more work. tryConsume hasn't run, so no slot to refund.
        // 499 is nginx's "client closed request"; Hono's status union is
        // narrow, so we build the Response directly.
        finish(499);
        return new Response(null, { status: 499 });
      }
      if (raceResult === TIMEOUT) {
        // Leader is stalled; fall through to a fresh attempt for this follower.
      } else {
        const entry = raceResult;
        if (entry) {
          cacheHit = true;
          finish(entry.status);
          return replayCached(entry);
        }
        // Pending stream failed/aborted — fall through to a fresh attempt.
      }
    }
  }

  // Consume one daily slot — but only now that the request is valid, so
  // malformed requests cannot burn quota. tryConsume is atomic (check +
  // increment) and also enforces the per-IP daily cap.
  const consumed = tryConsume(ip);
  if (consumed !== "ok") {
    c.header("Retry-After", String(secondsUntilNextUtcMidnight()));
    finish(429);
    return c.json({ error: consumed }, 429);
  }

  // Promise that resolves only when the stream has fully finished (or the
  // construction path threw). Tracked for the SIGTERM drain — the handler
  // IIFE itself resolves at TTFB, which is too early to wait on.
  let resolveStreamSettled: () => void = () => {};
  const streamSettled = new Promise<void>((resolve) => {
    resolveStreamSettled = resolve;
  });
  inflightChats.add(streamSettled);
  streamSettled.finally(() => inflightChats.delete(streamSettled));

  const handler = (async (): Promise<Response> => {
    try {
      const result = await runChat(messages, c.req.raw.signal, {
        onFinish: (info) => {
          usageInfo = {
            tokensIn: info.tokensIn,
            tokensOut: info.tokensOut,
            finishReason: info.finishReason,
            toolCalls: info.toolCalls,
          };
        },
        onTelemetry: (snap) => {
          turnInfo = {
            searchQueries: snap.searchQueries,
            retrievedUrls: snap.retrievedUrls,
            fetchedUrls: snap.fetchedUrls,
            citedUrls: snap.citedUrls,
            noAnswer: snap.noAnswer,
          };
        },
      });
      // Stream errors (OpenRouter 429/402/etc.) surface here, not as a throw —
      // log them and hand the client a generic message instead of crashing.
      // The slot also gets refunded so a failed upstream call costs us nothing.
      const response = result.toUIMessageStreamResponse({
        onError: (error: unknown) => {
          console.error("[chat] Stream error:", error);
          if (!refunded) {
            refund(ip);
            refunded = true;
          }
          return "An error occurred while generating the response.";
        },
      });
      let wrapped: Response;
      let settled: Promise<void>;
      if (key) {
        const intercepted = interceptAndCache(response, key, c.req.raw.signal, () => {
          if (!refunded) {
            refund(ip);
            refunded = true;
          }
        });
        wrapped = intercepted.response;
        settled = intercepted.settled;
      } else {
        wrapped = response;
        // Nothing to await — but still record latency once headers are out.
        settled = Promise.resolve();
      }
      // Defer finish() until the stream has fully drained so telemetry
      // captures full duration AND the usageInfo populated by onFinish.
      void settled.finally(() => {
        finish(wrapped.status);
        resolveStreamSettled();
      });
      return wrapped;
    } catch (err) {
      // Synchronous construction errors must not crash the process either.
      console.error("[chat] Error handling chat request:", err);
      refund(ip);
      refunded = true;
      finish(502);
      resolveStreamSettled();
      return c.json({ error: "chat_failed" }, 502);
    }
  })();

  return handler;
});

// --- Feedback ---------------------------------------------------------------
app.post("/api/feedback", async (c) => {
  const ip = clientIp(c);
  if (!allowPerIp(ip)) {
    c.header("Retry-After", "60");
    return c.json({ error: "rate_limited" }, 429);
  }

  let body: { requestId?: unknown; verdict?: unknown; reason?: unknown };
  try {
    body = (await c.req.json()) as { requestId?: unknown; verdict?: unknown; reason?: unknown };
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }

  if (body.verdict !== "up" && body.verdict !== "down") {
    return c.json({ error: "invalid_request" }, 400);
  }
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500)) {
    return c.json({ error: "invalid_request" }, 400);
  }
  if (
    body.requestId !== undefined &&
    (typeof body.requestId !== "string" || body.requestId.length > 100)
  ) {
    return c.json({ error: "invalid_request" }, 400);
  }

  logFeedback({
    ipHash: hashIp(ip),
    requestId: body.requestId as string | undefined,
    verdict: body.verdict,
    reason: body.reason as string | undefined,
  });

  return c.json({ ok: true });
});

// --- Startup ----------------------------------------------------------------
const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: "127.0.0.1",
  },
  () => {
    console.log(`[server] TON Docs AI listening on http://127.0.0.1:${config.port}`);
    console.log(`[server] Model: ${config.model}`);
    console.log(`[server] Orama search: ${config.oramaSearchUrl}`);
    console.log(
      `[server] Allowed origins: https://docs.ton.org, topteam Vercel previews` +
        (config.allowedOrigins.length > 0
          ? `, ${config.allowedOrigins.join(", ")}`
          : ""),
    );
    console.log(`[server] Daily request cap: ${config.dailyRequestCap}`);
  },
);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (draining) return;
  draining = true;
  console.log(`[server] ${signal} received; draining ${inflightChats.size} in-flight chats`);

  const drain = Promise.allSettled([...inflightChats]);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS));
  await Promise.race([drain, timeout]);

  try {
    const closer = (server as unknown as { close?: (cb?: () => void) => void }).close;
    if (typeof closer === "function") {
      await new Promise<void>((resolve) => closer.call(server, () => resolve()));
    }
  } catch (err) {
    console.warn(`[server] close error: ${(err as Error).message}`);
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
