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
  /** Page title. */
  title: string;
  /** Absolute, canonical documentation URL — cite this verbatim. */
  url: string;
  /** Navigation trail, e.g. "Smart contracts › Blueprint › Testing". */
  breadcrumbs: string;
  /** Matched content from the page; may be truncated (see SNIPPET_MAX). */
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
  breadcrumbs?: string[];
}

// Upper bound on the joined snippet length handed to the model. Generous
// enough to carry real explanatory context — when even this is not enough,
// the model can call `fetch_page` to read the whole page.
const SNIPPET_MAX = 1500;
// Abort the search request if the Orama service does not answer in time.
const SEARCH_TIMEOUT_MS = 5000;

/**
 * Search the TON docs via the Orama service. Returns up to `limit` page hits,
 * each with a snippet built from that page's matched content blocks.
 *
 * Throws on infrastructure failure (service down, timeout, malformed
 * response) so the caller can tell the model the search is unavailable —
 * distinct from a successful search that genuinely matched nothing, which
 * resolves to an empty array.
 */
export async function searchDocs(query: string, limit = 8): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const endpoint = `${config.oramaSearchUrl}/search?q=${encodeURIComponent(trimmed)}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      headers: { "User-Agent": "ton-docs-ai/1.0" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Orama search request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`Orama service returned ${res.status} ${res.statusText}.`);
  }

  let results: OramaResult[];
  try {
    const body = (await res.json()) as { results?: OramaResult[] };
    results = Array.isArray(body.results) ? body.results : [];
  } catch (err) {
    throw new Error(`Orama search returned a malformed response: ${(err as Error).message}`);
  }

  // The result list is flat: each `page` entry starts a new page, and the
  // `heading`/`text` entries that follow it (until the next `page`) are that
  // page's matched content blocks. Regroup into pages, stopping at `limit`.
  const hits: SearchHit[] = [];
  let current: { title: string; url: string; breadcrumbs: string; parts: string[] } | null =
    null;

  const flush = (): void => {
    if (!current) return;
    const joined = current.parts.join(" ").trim();
    const snippet =
      joined.length > SNIPPET_MAX
        ? joined.slice(0, SNIPPET_MAX - 1).trimEnd() + "…"
        : joined;
    hits.push({
      title: current.title,
      url: current.url,
      breadcrumbs: current.breadcrumbs,
      snippet,
    });
    current = null;
  };

  for (const entry of results) {
    if (entry.type === "page") {
      flush();
      if (hits.length >= limit) return hits;
      current = {
        title: entry.content,
        // Build the absolute, canonical URL once here so the model never has
        // to concatenate strings (and cannot mangle the path when citing).
        url: `${config.docsBaseUrl}${entry.url}`,
        breadcrumbs: Array.isArray(entry.breadcrumbs) ? entry.breadcrumbs.join(" › ") : "",
        parts: [],
      };
    } else if (current && entry.content) {
      current.parts.push(entry.content);
    }
  }
  flush();

  return hits;
}
