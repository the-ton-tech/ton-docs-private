/**
 * Per-page content client for the Orama service.
 *
 * `search` returns ranked pages; for each one we pull the page's full
 * Markdown from the Orama service's `/page` endpoint. Orama serves it from
 * rendered docs files on the same VPS, so this is a localhost request — no
 * external fetch and no extra model round-trip.
 */

import { config } from "./config.js";

// Abort the request if the Orama service does not answer quickly (it is a
// localhost call serving from memory, so this only trips on real trouble).
const FETCH_TIMEOUT_MS = 4000;
// Upper bound on one page's Markdown handed to the model. A few docs pages
// (long glossaries, specs) exceed this; the tail is then truncated.
const CONTENT_MAX = 20000;

/**
 * Fetch one page's full Markdown by its doc path (e.g.
 * "/blockchain-basics/tvm/overview"). Resolves to null when the page has no
 * stored content or the request fails — the caller then falls back to the
 * search snippet, so a content outage degrades gracefully.
 */
export async function fetchPageContent(path: string): Promise<string | null> {
  const endpoint = `${config.oramaSearchUrl}/page?url=${encodeURIComponent(path)}`;

  try {
    const res = await fetch(endpoint, {
      headers: { "User-Agent": "ton-docs-ai/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { content?: unknown };
    if (typeof body.content !== "string") return null;

    const content = body.content.trim();
    if (content.length === 0) return null;
    return content.length > CONTENT_MAX
      ? content.slice(0, CONTENT_MAX).trimEnd() + "\n\n…[page truncated]"
      : content;
  } catch {
    return null;
  }
}
