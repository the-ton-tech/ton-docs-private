/**
 * Rate limiting for POST /api/chat.
 *
 *  1. Per-IP limiter: token bucket with capacity 5 and a refill rate of
 *     1 token per 2 seconds (0.5 req/s sustained, with a small burst).
 *  2. Global daily cap: a process-wide counter that resets at 00:00 UTC,
 *     protecting the OpenRouter free-tier quota.
 *  3. Per-IP daily cap: stops one client from draining the global cap.
 *
 * Daily counters are persisted to `config.statePath` so a restart cannot
 * reset the rate-limit state (Restart=always in the systemd unit makes a
 * crash-loop trivial otherwise). The token-bucket state is in-memory only.
 */

import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";

const BUCKET_CAPACITY = 5;
const REFILL_MS_PER_TOKEN = 2000;
const PRUNE_INTERVAL_MS = 60_000;
// Drop per-IP entries that have been idle for this long.
const STALE_AFTER_MS = 60_000;

// --- Per-IP limiter (token bucket) ------------------------------------------

interface Bucket {
  tokens: number;
  updatedAt: number;
}
const lastSeen = new Map<string, Bucket>();

/**
 * Resolve the real client IP for rate limiting.
 *
 * Priority:
 *  1. `X-Real-IP` — nginx sets this to `$remote_addr`, overwriting any value
 *     the client sent, so it cannot be forged.
 *  2. The LAST entry of `X-Forwarded-For` — nginx appends the real socket
 *     address last; the FIRST entry is whatever the client sent and is
 *     attacker-controlled, so it must never be trusted for rate limiting.
 *  3. The remote socket address (direct connections, no proxy in front).
 */
export function clientIp(c: Context): string {
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;

  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const last = parts.at(-1);
    if (last) return last;
  }

  try {
    const address = getConnInfo(c).remote.address;
    if (address) return address;
  } catch {
    // getConnInfo can throw if the underlying socket is unavailable.
  }
  return "unknown";
}

/**
 * Returns true if this IP has a token to spend. Bucket holds up to
 * BUCKET_CAPACITY tokens and refills at one token per REFILL_MS_PER_TOKEN.
 */
export function allowPerIp(ip: string): boolean {
  const now = Date.now();
  const bucket = lastSeen.get(ip);
  if (!bucket) {
    lastSeen.set(ip, { tokens: BUCKET_CAPACITY - 1, updatedAt: now });
    return true;
  }
  // Clamp at 0 so an NTP step backwards (now < bucket.updatedAt) cannot
  // produce a negative refill that decreases the available token count.
  const refill = Math.max(0, (now - bucket.updatedAt) / REFILL_MS_PER_TOKEN);
  const tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + refill);
  if (tokens < 1) {
    bucket.tokens = tokens;
    bucket.updatedAt = now;
    return false;
  }
  bucket.tokens = tokens - 1;
  bucket.updatedAt = now;
  return true;
}

// Periodically prune stale entries so the map cannot grow unbounded.
const pruneTimer = setInterval(() => {
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const [ip, bucket] of lastSeen) {
    if (bucket.updatedAt < cutoff) lastSeen.delete(ip);
  }
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

// --- Daily caps -------------------------------------------------------------
//
// Two counters reset at 00:00 UTC: a global cap (protects the whole OpenRouter
// free-tier quota) and a per-IP cap (stops one client from draining the global
// budget — at 1 req/sec a single IP could otherwise burn the day's quota in
// well under a minute).

function utcDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

let dailyKey = utcDayKey();
let dailyUsed = 0;
const ipDaily = new Map<string, number>();

// --- Persistence ------------------------------------------------------------

interface PersistedState {
  dailyKey: string;
  dailyUsed: number;
  ipDaily: Record<string, number>;
}

function loadState(): void {
  try {
    const raw = readFileSync(config.statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (
      typeof parsed.dailyKey !== "string" ||
      typeof parsed.dailyUsed !== "number" ||
      typeof parsed.ipDaily !== "object" ||
      parsed.ipDaily === null
    ) {
      return;
    }
    // Discard persisted counters from a previous UTC day.
    if (parsed.dailyKey !== utcDayKey()) return;
    dailyKey = parsed.dailyKey;
    dailyUsed = Math.max(0, Math.floor(parsed.dailyUsed));
    for (const [ip, count] of Object.entries(parsed.ipDaily)) {
      if (typeof count === "number" && count > 0) {
        ipDaily.set(ip, Math.floor(count));
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[ratelimit] Failed to load persisted state: ${(err as Error).message}`);
    }
  }
}

try {
  mkdirSync(dirname(config.statePath), { recursive: true });
} catch (err) {
  console.warn(`[ratelimit] Failed to ensure state dir: ${(err as Error).message}`);
}
loadState();

let persistInflight: Promise<void> = Promise.resolve();

function snapshot(): string {
  const ipObj: Record<string, number> = {};
  for (const [ip, count] of ipDaily) ipObj[ip] = count;
  return JSON.stringify({ dailyKey, dailyUsed, ipDaily: ipObj });
}

function persist(): void {
  const payload = snapshot();
  const target = config.statePath;
  const tmp = `${target}.tmp`;
  // Serialise writes so concurrent persist() calls cannot interleave
  // writeFile/rename and corrupt the file.
  persistInflight = persistInflight
    .catch(() => undefined)
    .then(async () => {
      try {
        await writeFile(tmp, payload, "utf8");
        await rename(tmp, target);
      } catch (err) {
        console.warn(`[ratelimit] Failed to persist state: ${(err as Error).message}`);
      }
    });
}

function rollDayIfNeeded(): void {
  const today = utcDayKey();
  if (today !== dailyKey) {
    dailyKey = today;
    dailyUsed = 0;
    ipDaily.clear();
    persist();
  }
}

export type ConsumeResult = "ok" | "daily_limit" | "ip_daily_limit";

/**
 * Atomically check the global and per-IP daily caps and, if both have room,
 * consume one slot from each. Synchronous and run-to-completion, so concurrent
 * requests cannot overshoot a cap between the check and the increment.
 *
 * `ipDaily` is bounded: entries are only added while `dailyUsed` is below the
 * global cap, so it never holds more than `dailyRequestCap` entries per day.
 */
export function tryConsume(ip: string): ConsumeResult {
  rollDayIfNeeded();
  if (dailyUsed >= config.dailyRequestCap) return "daily_limit";
  const ipUsed = ipDaily.get(ip) ?? 0;
  if (ipUsed >= config.perIpDailyCap) return "ip_daily_limit";
  dailyUsed += 1;
  ipDaily.set(ip, ipUsed + 1);
  persist();
  return "ok";
}

/**
 * Return one previously-consumed slot to the global and per-IP daily counters,
 * clamped at 0. Call when an upstream failure means the slot delivered no
 * value to the user (OpenRouter 5xx/429/timeout). Safe to call after a day
 * rollover — the rolled-over counters simply stay at 0.
 */
export function refund(ip: string): void {
  rollDayIfNeeded();
  if (dailyUsed > 0) dailyUsed -= 1;
  const ipUsed = ipDaily.get(ip);
  if (ipUsed !== undefined) {
    if (ipUsed <= 1) ipDaily.delete(ip);
    else ipDaily.set(ip, ipUsed - 1);
  }
  persist();
}

/** Current daily usage, for the health endpoint. */
export function dailyStats(): { used: number; cap: number } {
  rollDayIfNeeded();
  return { used: dailyUsed, cap: config.dailyRequestCap };
}
