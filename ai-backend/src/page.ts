/**
 * Full-page fetch for the `fetch_page` tool.
 *
 * `search` returns short snippets; when a snippet is not enough to answer
 * accurately, the model calls `fetch_page` with a page URL. fetchDocPage()
 * reads that page's full Markdown from the docs site's per-page export
 * (`<docsBaseUrl>/llms.mdx/<path>.md`) — the same clean Markdown, including
 * code blocks and OpenAPI sections, that the docs site serves to LLMs.
 */

import { config } from "./config.js";

export interface PageContent {
  /** Absolute, canonical URL of the fetched page. */
  url: string;
  /** Full page Markdown (possibly truncated — see CONTENT_MAX). */
  content: string;
}

// Abort the page fetch if the docs site does not answer in time.
const FETCH_TIMEOUT_MS = 8000;
// Upper bound on the page Markdown handed to the model. A few docs pages
// (glossaries, long specs) exceed this; the tail is then truncated.
const CONTENT_MAX = 16000;

/**
 * Reduce an arbitrary URL or path to a safe documentation path such as
 * `/blockchain-basics/tvm/overview`, or null if the input is not usable.
 *
 * Only the pathname is ever kept — the host is discarded and replaced with
 * the configured docs origin, and the path is restricted to plain slug
 * segments. This is the SSRF guard: the model cannot point `fetch_page` at
 * an arbitrary host or traverse outside the docs.
 */
function toDocPath(input: string): string | null {
  let path: string;
  try {
    path = input.startsWith("http") ? new URL(input).pathname : input;
  } catch {
    return null;
  }
  path = path.trim();
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+$/, ""); // trailing slashes
  path = path.replace(/\.(mdx?|html?)$/i, ""); // any extension the model appended
  if (path === "" || path === "/") return null;
  // Allow only plain docs paths: slash-separated slug segments. Rejects "..",
  // encoded characters, query strings, whitespace — anything unexpected.
  if (!/^(\/[a-zA-Z0-9_-]+)+$/.test(path)) return null;
  return path;
}

/**
 * Fetch the full Markdown of one documentation page. Throws on a bad input
 * URL or any fetch failure, so the `fetch_page` tool can report the problem
 * to the model — which still has the search snippet to fall back on.
 */
export async function fetchDocPage(url: string): Promise<PageContent> {
  const path = toDocPath(url);
  if (!path) {
    throw new Error(
      `"${url}" is not a valid documentation page URL. Pass a url returned by the search tool.`,
    );
  }

  // The docs site exports each page as Markdown at /llms.mdx/<path>.md.
  const endpoint = `${config.docsBaseUrl}/llms.mdx${path}.md`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      headers: { "User-Agent": "ton-docs-ai/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Could not reach the documentation page: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`Documentation page not available (HTTP ${res.status}) for ${path}.`);
  }

  let content = (await res.text()).trim();
  if (content.length > CONTENT_MAX) {
    content = content.slice(0, CONTENT_MAX).trimEnd() + "\n\n…[page truncated]";
  }

  return { url: `${config.docsBaseUrl}${path}`, content };
}
