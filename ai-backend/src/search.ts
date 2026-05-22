/**
 * Documentation search backed by the standalone Orama service.
 *
 * The `search` tool calls searchDocs(): it queries the Orama search service
 * (GET /search?q=) for ranked pages, then pulls each page's full Markdown
 * from the same service (GET /page?url=). The model therefore gets complete
 * pages in one tool call — no follow-up tool and no extra model round-trip.
 * The Orama service (see orama-server/) runs separately and owns both the
 * index and the page content; this module is just a thin HTTP client.
 */

import { config } from "./config.js";
import { fetchPageContent } from "./page.js";

export interface SearchHit {
  /** Page title. */
  title: string;
  /** Absolute, canonical documentation URL — cite this verbatim. */
  url: string;
  /** Navigation trail, e.g. "Smart contracts › Blueprint › Testing". */
  breadcrumbs: string;
  /** The page's full Markdown, or a matched snippet if content is unavailable. */
  content: string;
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

// Fallback snippet length, used only when a page's full content cannot be
// loaded from the Orama `/page` endpoint.
const SNIPPET_MAX = 1500;
// Abort the search request if the Orama service does not answer in time.
const SEARCH_TIMEOUT_MS = 5000;

/**
 * Search the TON docs and return up to `limit` pages, each with its full
 * Markdown content.
 *
 * Throws on search-infrastructure failure (service down, timeout, malformed
 * response) so the caller can tell the model the search is unavailable —
 * distinct from a successful search that genuinely matched nothing, which
 * resolves to an empty array. A page whose full content cannot be loaded
 * still appears, carrying the matched snippet instead.
 */
export async function searchDocs(query: string, limit = 6): Promise<SearchHit[]> {
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
  interface Grouped {
    title: string;
    path: string;
    breadcrumbs: string;
    parts: string[];
  }
  const groups: Grouped[] = [];
  let current: Grouped | null = null;

  for (const entry of results) {
    if (entry.type === "page") {
      if (groups.length >= limit) break;
      current = {
        title: entry.content,
        path: entry.url,
        breadcrumbs: Array.isArray(entry.breadcrumbs) ? entry.breadcrumbs.join(" › ") : "",
        parts: [],
      };
      groups.push(current);
    } else if (current && entry.content) {
      current.parts.push(entry.content);
    }
  }

  // Pull each page's full Markdown from the Orama `/page` endpoint in
  // parallel. A page whose content cannot be loaded falls back to the
  // matched snippet, so the model always has something to ground on.
  return Promise.all(
    groups.map(async (group): Promise<SearchHit> => {
      const full = await fetchPageContent(group.path);
      return {
        title: group.title,
        // Build the absolute, canonical URL once here so the model never has
        // to concatenate strings (and cannot mangle the path when citing).
        url: `${config.docsBaseUrl}${group.path}`,
        breadcrumbs: group.breadcrumbs,
        content: full ?? snippetOf(group.parts),
      };
    }),
  );
}

/** Join a page's matched blocks into a length-capped fallback snippet. */
function snippetOf(parts: string[]): string {
  const joined = parts.join(" ").trim();
  return joined.length > SNIPPET_MAX
    ? joined.slice(0, SNIPPET_MAX - 1).trimEnd() + "…"
    : joined;
}
