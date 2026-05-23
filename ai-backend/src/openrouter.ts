/**
 * OpenRouter provider instance for the AI SDK.
 *
 * The HTTP-Referer and X-Title headers are OpenRouter's recommended
 * attribution headers — they identify this app in OpenRouter's dashboard.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "./config.js";

const UPSTREAM_TIMEOUT_MS = 60_000;

// Bound end-to-end stream wall time at 60s; nginx's 300s ceiling is too loose
// to protect the daily cap against a stalled upstream.
const boundedFetch: typeof fetch = (input, init) => {
  const timeoutSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const incoming = init?.signal ?? undefined;
  const signal = incoming ? AbortSignal.any([incoming, timeoutSignal]) : timeoutSignal;
  return globalThis.fetch(input, { ...init, signal });
};

export const openrouter = createOpenRouter({
  apiKey: config.openrouterKey,
  headers: {
    "HTTP-Referer": "https://docs.ton.org",
    "X-Title": "TON Docs Assistant",
  },
  fetch: boundedFetch,
});
