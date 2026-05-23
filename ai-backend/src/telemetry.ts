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
