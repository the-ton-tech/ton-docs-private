/**
 * In-memory documentation search index.
 *
 * Fetches the Fumadocs `llms-full.txt` (all doc pages concatenated), parses it
 * into page records, and builds a FlexSearch Document index over title +
 * content. The index is built in the background on startup and refreshed
 * periodically; the chat tool queries it via searchDocs().
 */

import { Document } from "flexsearch";
import { config } from "./config.js";

// --- Types ------------------------------------------------------------------

interface DocPage {
  id: number;
  title: string;
  url: string;
  content: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

// FlexSearch document shape. Indexed fields are searched; stored fields are
// returned with enriched results.
interface IndexedDoc {
  id: number;
  title: string;
  url: string;
  content: string;
  [key: string]: string | number;
}

// --- Module state -----------------------------------------------------------

let index: Document<IndexedDoc> | null = null;
let pages: DocPage[] = [];
let pagesById = new Map<number, DocPage>();

// Matches a page heading line: "# {Title} (/url/path)".
const HEADING_RE = /^# (.+) \((\/[^()]*)\)\s*$/;

const SNIPPET_MAX = 600;
// How far left of the query hit the snippet window is biased — not a minimum
// length; the window itself is always SNIPPET_MAX-wide.
const SNIPPET_LEFT_BIAS = 400;

/** Number of pages currently indexed (for the health endpoint). */
export function indexedPageCount(): number {
  return pages.length;
}

// --- Parsing ----------------------------------------------------------------

/**
 * Parse the raw llms-full.txt into page records. A page block starts at a
 * heading line and runs until the next heading or end of file.
 */
export function parseLlmsFull(raw: string): DocPage[] {
  const lines = raw.split(/\r?\n/);
  const result: DocPage[] = [];
  let current: { title: string; url: string; body: string[] } | null = null;
  let nextId = 0;

  const flush = (): void => {
    if (current) {
      result.push({
        id: nextId++,
        title: current.title,
        url: current.url,
        content: current.body.join("\n").trim(),
      });
    }
  };

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      flush();
      current = { title: match[1].trim(), url: match[2].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();

  return result;
}

// --- Index building ---------------------------------------------------------

function buildIndex(parsed: DocPage[]): Document<IndexedDoc> {
  const doc = new Document<IndexedDoc>({
    tokenize: "forward",
    document: {
      id: "id",
      index: ["title", "content"],
      store: ["title", "url", "content"],
    },
  });

  for (const page of parsed) {
    doc.add({
      id: page.id,
      title: page.title,
      url: page.url,
      content: page.content,
    });
  }

  return doc;
}

/**
 * Fetch the docs file and (re)build the index. On any failure the previous
 * index is kept and a warning is logged.
 */
export async function refreshIndex(): Promise<void> {
  try {
    const res = await fetch(config.docsLlmsUrl, {
      headers: { "User-Agent": "ton-docs-ai/1.0" },
    });
    if (!res.ok) {
      console.warn(
        `[search] Failed to fetch docs index (${res.status} ${res.statusText}) from ${config.docsLlmsUrl}. Keeping existing index (${pages.length} pages).`,
      );
      return;
    }

    const raw = await res.text();
    const parsed = parseLlmsFull(raw);

    if (parsed.length === 0) {
      console.warn(
        `[search] Docs index fetched but yielded 0 pages. Keeping existing index (${pages.length} pages).`,
      );
      return;
    }

    index = buildIndex(parsed);
    pages = parsed;
    pagesById = new Map(parsed.map((p) => [p.id, p]));
    console.log(`[search] Docs index built: ${parsed.length} pages.`);
  } catch (err) {
    console.warn(
      `[search] Error refreshing docs index: ${(err as Error).message}. Keeping existing index (${pages.length} pages).`,
    );
  }
}

/**
 * Kick off the initial index build in the background and schedule periodic
 * refreshes. Does not block the caller.
 */
export function startIndexing(): void {
  void refreshIndex();

  const intervalMs = config.docsIndexRefreshMinutes * 60_000;
  const timer = setInterval(() => {
    void refreshIndex();
  }, intervalMs);
  timer.unref();
}

// --- Querying ---------------------------------------------------------------

/** Build a snippet of ~400-600 chars around the first query hit. */
function makeSnippet(content: string, query: string): string {
  if (content.length <= SNIPPET_MAX) return content;

  const lowerContent = content.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  let hit = -1;
  for (const term of terms) {
    const idx = lowerContent.indexOf(term);
    if (idx !== -1 && (hit === -1 || idx < hit)) hit = idx;
  }

  if (hit === -1) {
    return content.slice(0, SNIPPET_MAX - 3).trimEnd() + "...";
  }

  // Center a window on the hit. Reserve 6 chars so leading/trailing ellipses
  // keep the final string within SNIPPET_MAX.
  const window = SNIPPET_MAX - 6;
  const half = Math.floor(SNIPPET_LEFT_BIAS / 2);
  let start = Math.max(0, hit - half);
  let end = Math.min(content.length, start + window);
  start = Math.max(0, end - window);

  let snippet = content.slice(start, end).trim();
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  return snippet;
}

/**
 * Search the docs index. Returns up to `limit` hits with a snippet each.
 * Resolves to an empty array when the index is empty or not yet built.
 */
export async function searchDocs(query: string, limit = 8): Promise<SearchHit[]> {
  if (!index || pages.length === 0) return [];

  const trimmed = query.trim();
  if (!trimmed) return [];

  const results = await index.searchAsync(trimmed, {
    limit,
    enrich: true,
  });

  // Results are grouped by field (title, content); dedupe by page id while
  // preserving first-seen order.
  const seen = new Set<number>();
  const hits: SearchHit[] = [];

  for (const group of results) {
    for (const entry of group.result) {
      const id = typeof entry.id === "number" ? entry.id : Number(entry.id);
      if (seen.has(id)) continue;
      seen.add(id);

      const page = pagesById.get(id);
      if (!page) continue;

      hits.push({
        title: page.title,
        url: page.url,
        snippet: makeSnippet(page.content, trimmed),
      });

      if (hits.length >= limit) return hits;
    }
  }

  return hits;
}
