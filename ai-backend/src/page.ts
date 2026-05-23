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

// Discriminated result so the caller can distinguish a 404 (worth retrying
// without an anchor — the model may have hallucinated the fragment) from an
// empty body or a network error (both terminal).
type PageResult =
  | { kind: "ok"; content: string }
  | { kind: "not_found" }
  | { kind: "empty" }
  | { kind: "error" };

async function requestPage(path: string, anchor?: string): Promise<PageResult> {
  let endpoint = `${config.oramaSearchUrl}/page?url=${encodeURIComponent(path)}`;
  if (anchor) endpoint += `&anchor=${encodeURIComponent(anchor)}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      headers: { "User-Agent": "ton-docs-ai/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return { kind: "error" };
  }
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) return { kind: "error" };

  let body: { content?: unknown };
  try {
    body = (await res.json()) as { content?: unknown };
  } catch {
    return { kind: "error" };
  }
  if (typeof body.content !== "string") return { kind: "empty" };

  const content = body.content.trim();
  if (content.length === 0) return { kind: "empty" };
  const truncated =
    content.length > CONTENT_MAX
      ? content.slice(0, CONTENT_MAX).trimEnd() + "\n\n…[page truncated]"
      : content;
  return { kind: "ok", content: truncated };
}

/**
 * Fetch one page's full Markdown by its doc path (e.g.
 * "/blockchain-basics/tvm/overview"). When `anchor` is provided, the Orama
 * service slices the response to that section. Resolves to null when the
 * page has no stored content or the request fails — the caller then falls
 * back to the search snippet, so a content outage degrades gracefully.
 *
 * Only a true 404 on the anchored request triggers a retry without the
 * anchor (the model may have hallucinated the fragment). An empty body or
 * a network error returns null directly — retrying wouldn't change anything.
 */
export async function fetchPageContent(path: string, anchor?: string): Promise<string | null> {
  const first = await requestPage(path, anchor);
  if (first.kind === "ok") return first.content;
  if (first.kind === "not_found" && anchor) {
    const retry = await requestPage(path);
    return retry.kind === "ok" ? retry.content : null;
  }
  return null;
}
