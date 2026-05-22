/**
 * Documentation search backed by the standalone Orama service.
 *
 * The `search` tool calls searchDocs(), which queries the Orama search
 * service over HTTP (GET /search?q=) and maps its flat result list into
 * per-page hits with snippets. The Orama service (see orama-server/) runs
 * separately and owns the index; this module is just a thin HTTP client.
 */

import { config } from "./config.js";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * One entry in the Orama service's flat result list. A `page` entry carries
 * the page title in `content`; the `heading`/`text` entries that follow it
 * carry the matched body content.
 */
interface OramaResult {
  type: "page" | "heading" | "text";
  content: string;
  url: string;
}

// Upper bound on the joined snippet length handed to the model.
const SNIPPET_MAX = 600;
// Abort the search request if the Orama service does not answer in time.
const SEARCH_TIMEOUT_MS = 5000;

/**
 * Search the TON docs via the Orama service. Returns up to `limit` page hits,
 * each with a snippet built from that page's matched content blocks. Resolves
 * to an empty array on any failure (service down, timeout, bad response) so a
 * search outage degrades to "no results" instead of failing the chat turn.
 */
export async function searchDocs(query: string, limit = 8): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const endpoint = `${config.oramaSearchUrl}/search?q=${encodeURIComponent(trimmed)}`;

  let results: OramaResult[];
  try {
    const res = await fetch(endpoint, {
      headers: { "User-Agent": "ton-docs-ai/1.0" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[search] Orama service returned ${res.status} ${res.statusText}.`);
      return [];
    }
    const body = (await res.json()) as { results?: OramaResult[] };
    results = Array.isArray(body.results) ? body.results : [];
  } catch (err) {
    console.warn(`[search] Orama search request failed: ${(err as Error).message}`);
    return [];
  }

  // The result list is flat: each `page` entry starts a new page, and the
  // `heading`/`text` entries that follow it (until the next `page`) are that
  // page's matched content blocks. Regroup into pages, stopping at `limit`.
  const hits: SearchHit[] = [];
  let current: { title: string; url: string; parts: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    const joined = current.parts.join(" ").trim();
    const snippet =
      joined.length > SNIPPET_MAX
        ? joined.slice(0, SNIPPET_MAX - 3).trimEnd() + "..."
        : joined;
    hits.push({ title: current.title, url: current.url, snippet });
    current = null;
  };

  for (const entry of results) {
    if (entry.type === "page") {
      flush();
      if (hits.length >= limit) return hits;
      current = { title: entry.content, url: entry.url, parts: [] };
    } else if (current && entry.content) {
      current.parts.push(entry.content);
    }
  }
  flush();

  return hits;
}
