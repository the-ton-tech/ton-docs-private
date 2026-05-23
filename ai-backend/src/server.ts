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
import { timingSafeEqual } from "node:crypto";
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
import { cacheKey, getCached, interceptAndCache, replayCached } from "./cache.js";
import { hashIp, logChat } from "./telemetry.js";

const app = new Hono();

// Reject obviously-oversized payloads before parsing. nginx also caps the body
// (client_max_body_size); this is defense in depth for non-nginx deployments.
const MAX_BODY_BYTES = 64 * 1024;
// Upper bound on conversation length handed to the model.
const MAX_MESSAGES = 50;

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

  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return c.json({ error: "payload_too_large" }, 413);
  }

  if (!allowPerIp(clientIp(c))) {
    return c.json({ error: "rate_limited" }, 429);
  }

  return next();
});

// --- Health -----------------------------------------------------------------
//
// Public response is intentionally minimal: leaking the live daily counter
// lets an attacker time floods against the 00:00 UTC reset. Operators read
// the live counter from /api/internal/stats with the STATS_TOKEN bearer.
app.get("/api/health", (c) => c.json({ ok: true }));

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
  return c.json({ ok: true, dailyUsed: daily.used, dailyCap: daily.cap });
});

// --- Chat -------------------------------------------------------------------
app.post("/api/chat", async (c) => {
  const startedAt = Date.now();
  const ip = clientIp(c);
  const ipHash = hashIp(ip);
  let cacheHit = false;
  let refunded = false;
  let status = 200;

  const finish = (statusCode: number): void => {
    status = statusCode;
    logChat({
      ipHash,
      status,
      durationMs: Date.now() - startedAt,
      cacheHit,
      refunded,
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

  // Cache lookup happens BEFORE tryConsume — a hit must not burn a slot.
  const key = cacheKey(messages);
  if (key) {
    const hit = getCached(key);
    if (hit) {
      cacheHit = true;
      finish(hit.status);
      return replayCached(hit);
    }
  }

  // Consume one daily slot — but only now that the request is valid, so
  // malformed requests cannot burn quota. tryConsume is atomic (check +
  // increment) and also enforces the per-IP daily cap.
  const consumed = tryConsume(ip);
  if (consumed !== "ok") {
    finish(429);
    return c.json({ error: consumed }, 429);
  }

  try {
    const result = await runChat(messages, c.req.raw.signal);
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
    const wrapped = key ? interceptAndCache(response, key) : response;
    finish(wrapped.status);
    return wrapped;
  } catch (err) {
    // Synchronous construction errors must not crash the process either.
    console.error("[chat] Error handling chat request:", err);
    refund(ip);
    refunded = true;
    finish(502);
    return c.json({ error: "chat_failed" }, 502);
  }
});

// --- Startup ----------------------------------------------------------------
serve(
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
