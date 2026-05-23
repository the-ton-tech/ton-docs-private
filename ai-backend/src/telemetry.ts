/**
 * Structured per-request telemetry. One JSON line per `/api/chat` so
 * journalctl can be filtered with jq. Raw IPs are never logged — we hash
 * them with a process-startup-random salt so the same client is consistent
 * within a process lifetime but un-correlatable across restarts.
 */

import { createHash, randomBytes } from "node:crypto";

const ipSalt = randomBytes(32);

/** Stable per-process opaque identifier for an IP. */
export function hashIp(ip: string): string {
  return createHash("sha256").update(ipSalt).update(ip).digest("hex").slice(0, 16);
}

export interface ChatTelemetry {
  ipHash: string;
  status: number;
  durationMs: number;
  cacheHit: boolean;
  refunded: boolean;
  requestId?: string;
  tokensIn?: number;
  tokensOut?: number;
  upstreamMs?: number;
  finishReason?: string;
  toolCalls?: number;
  model?: string;
  searchQueries?: string[];
  retrievedUrls?: string[];
  fetchedUrls?: string[];
  citedUrls?: string[];
  noAnswer?: boolean;
}

/** Emit one JSON log line for a completed /api/chat request. */
export function logChat(event: ChatTelemetry): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      kind: "chat",
      ...event,
    }),
  );
}

export interface FeedbackTelemetry {
  ipHash: string;
  requestId?: string;
  verdict: "up" | "down";
  reason?: string;
}

/** Emit one JSON log line for a /api/feedback submission. */
export function logFeedback(event: FeedbackTelemetry): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      kind: "feedback",
      ...event,
    }),
  );
}

// --- In-process latency histogram ------------------------------------------
//
// Fixed bucket boundaries (ms). Index `i` counts durations in
// (buckets[i-1], buckets[i]]; the final overflow bucket counts everything
// above the last boundary.

const BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];
const counts = new Array<number>(BUCKETS.length + 1).fill(0);
let totalCount = 0;

export function recordLatency(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  let idx = BUCKETS.length;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (ms <= BUCKETS[i]) {
      idx = i;
      break;
    }
  }
  counts[idx] += 1;
  totalCount += 1;
}

function quantile(q: number): number {
  if (totalCount === 0) return 0;
  const target = Math.ceil(totalCount * q);
  let cumulative = 0;
  for (let i = 0; i < counts.length; i++) {
    cumulative += counts[i];
    if (cumulative >= target) {
      // Cap at the last finite boundary instead of returning +Infinity, which
      // JSON-serialises to `null` and confuses dashboards. The separate
      // `overflowCount` field in latencySnapshot() exposes whether the cap
      // was hit so operators can spot saturated p99 vs genuine >30s requests.
      return i < BUCKETS.length ? BUCKETS[i] : BUCKETS[BUCKETS.length - 1];
    }
  }
  return 0;
}

export function latencySnapshot(): {
  p50: number;
  p95: number;
  p99: number;
  count: number;
  overflowCount: number;
} {
  return {
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
    count: totalCount,
    overflowCount: counts[BUCKETS.length],
  };
}
