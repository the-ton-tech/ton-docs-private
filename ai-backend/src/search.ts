/**
 * Documentation search backed by the standalone Orama service.
 *
 * `searchDocs` queries the Orama search service (GET /search?q=) for ranked
 * pages and returns the matched section snippets (heading + body excerpts)
 * for each page — not the full page Markdown. Section chunks keep the
 * context window small; if the model needs a whole page it should call the
 * `fetch_page` tool. The Orama service (see orama-server/) runs separately
 * and owns both the index and the page content; this module is just a thin
 * HTTP client.
 */

import { config } from "./config.js";

export interface SearchHit {
  /** Page title. */
  title: string;
  /** Absolute, canonical documentation URL — cite this verbatim. */
  url: string;
  /** Navigation trail, e.g. "Smart contracts › Blueprint › Testing". */
  breadcrumbs: string;
  /** Matched section snippets joined with separators, or a fallback snippet. */
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

// Upper bound on a single hit's joined section content. The whole page is
// available on demand via `fetch_page`; here we just hand the model the
// matched sections so the context stays tight across many results.
const HIT_CONTENT_MAX = 3000;
// Fallback length cap for pages with zero section hits — we then have only
// the matched terms, not a whole structured page, so this stays small.
const SNIPPET_MAX = 1500;
// Abort the search request if the Orama service does not answer in time.
const SEARCH_TIMEOUT_MS = 5000;

/**
 * Search the TON docs and return up to `limit` pages, each carrying the
 * matched section snippets (heading + body, capped per hit).
 *
 * Throws on search-infrastructure failure (service down, timeout, malformed
 * response) so the caller can tell the model the search is unavailable —
 * distinct from a successful search that genuinely matched nothing, which
 * resolves to an empty array. A page with no section hits falls back to a
 * compact snippet built from whatever text the index returned.
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
  interface Section {
    heading: string | null;
    parts: string[];
  }
  interface Grouped {
    title: string;
    path: string;
    breadcrumbs: string;
    sections: Section[];
  }
  const groups: Grouped[] = [];
  let current: Grouped | null = null;
  let currentSection: Section | null = null;

  for (const entry of results) {
    if (entry.type === "page") {
      if (groups.length >= limit) break;
      current = {
        title: entry.content,
        path: entry.url,
        breadcrumbs: Array.isArray(entry.breadcrumbs) ? entry.breadcrumbs.join(" › ") : "",
        sections: [],
      };
      currentSection = null;
      groups.push(current);
    } else if (current) {
      if (entry.type === "heading") {
        currentSection = { heading: entry.content?.trim() || null, parts: [] };
        current.sections.push(currentSection);
      } else if (entry.type === "text" && entry.content) {
        if (!currentSection) {
          currentSection = { heading: null, parts: [] };
          current.sections.push(currentSection);
        }
        currentSection.parts.push(entry.content);
      }
    }
  }

  return groups.map((group): SearchHit => {
    const sectionContent = renderSections(group.sections);
    return {
      title: group.title,
      // Build the absolute, canonical URL once here so the model never has
      // to concatenate strings (and cannot mangle the path when citing).
      url: `${config.docsBaseUrl}${group.path}`,
      breadcrumbs: group.breadcrumbs,
      content: sectionContent || snippetFallback(group.sections),
    };
  });
}

/**
 * Render matched sections as a compact, model-friendly excerpt:
 *   ## Heading
 *   body…
 *
 *   ---
 *
 *   ## Next heading
 *   body…
 * Truncated to HIT_CONTENT_MAX characters in total.
 */
function renderSections(sections: { heading: string | null; parts: string[] }[]): string {
  const blocks: string[] = [];
  for (const section of sections) {
    const body = section.parts.join("\n").trim();
    if (!section.heading && !body) continue;
    const head = section.heading ? `## ${section.heading}` : "";
    blocks.push([head, body].filter(Boolean).join("\n"));
  }
  if (blocks.length === 0) return "";
  const joined = blocks.join("\n\n---\n\n");
  return joined.length > HIT_CONTENT_MAX
    ? joined.slice(0, HIT_CONTENT_MAX - 1).trimEnd() + "…"
    : joined;
}

/** Fallback for pages with no structured section hits. */
function snippetFallback(sections: { heading: string | null; parts: string[] }[]): string {
  const flat = sections
    .flatMap((s) => [s.heading ?? "", ...s.parts])
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!flat) return "";
  return flat.length > SNIPPET_MAX ? flat.slice(0, SNIPPET_MAX - 1).trimEnd() + "…" : flat;
}
