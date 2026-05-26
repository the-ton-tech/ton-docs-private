/**
 * CORS origin allowlist logic.
 *
 * Allowed:
 *  - exact https://docs.ton.org
 *  - Vercel previews matching ^https://([a-z0-9-]+-)?topteam\.vercel\.app$
 *  - any extra exact origins supplied via the ALLOWED_ORIGINS env var
 *
 * A disallowed Origin yields `null`, which tells hono/cors not to emit an
 * Access-Control-Allow-Origin header.
 */

import { config } from "./config.js";

const DOCS_ORIGIN = "https://docs.ton.org";

// Anchored regex for topteam Vercel preview deployments.
const VERCEL_PREVIEW_RE = /^https:\/\/([a-z0-9-]+-)?topteam\.vercel\.app$/;

/**
 * Returns the origin string if it is allowed, otherwise null.
 * Suitable as the `origin` callback for hono/cors.
 */
export function resolveOrigin(origin: string | undefined | null): string | null {
  if (!origin) return null;
  // The literal string "null" (sent by sandboxed iframes / file:// pages) is
  // not in any allowlist below and therefore falls through to rejection.
  if (origin === DOCS_ORIGIN) return origin;
  if (VERCEL_PREVIEW_RE.test(origin)) return origin;
  if (config.allowedOrigins.includes(origin)) return origin;
  return null;
}
