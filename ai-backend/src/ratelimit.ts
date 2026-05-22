/**
 * Rate limiting for POST /api/chat.
 *
 *  1. Per-IP limiter: at most 1 request per second per client IP.
 *  2. Global daily cap: a process-wide counter that resets at 00:00 UTC,
 *     protecting the OpenRouter free-tier quota.
 *  3. Per-IP daily cap: stops one client from draining the global cap.
 *
 * All limiters live in process memory — fine for a single-instance VPS
 * deployment behind nginx.
 */

import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "./config.js";

const PER_IP_WINDOW_MS = 1000;
const PRUNE_INTERVAL_MS = 60_000;
// Drop per-IP entries that have been idle for this long.
const STALE_AFTER_MS = 60_000;

// --- Per-IP limiter ---------------------------------------------------------

const lastSeen = new Map<string, number>();

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

/** Returns true if this IP is within its 1 req/sec budget. */
export function allowPerIp(ip: string): boolean {
  const now = Date.now();
  const previous = lastSeen.get(ip);
  lastSeen.set(ip, now);
  if (previous !== undefined && now - previous < PER_IP_WINDOW_MS) {
    return false;
  }
  return true;
}

// Periodically prune stale entries so the map cannot grow unbounded.
const pruneTimer = setInterval(() => {
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const [ip, ts] of lastSeen) {
    if (ts < cutoff) lastSeen.delete(ip);
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

function rollDayIfNeeded(): void {
  const today = utcDayKey();
  if (today !== dailyKey) {
    dailyKey = today;
    dailyUsed = 0;
    ipDaily.clear();
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
  return "ok";
}

/** Current daily usage, for the health endpoint. */
export function dailyStats(): { used: number; cap: number } {
  rollDayIfNeeded();
  return { used: dailyUsed, cap: config.dailyRequestCap };
}
