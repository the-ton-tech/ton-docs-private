import {visibleSource} from "@/lib/source"
import {createFromSource} from "fumadocs-core/search/server"

export const revalidate = false

/**
 * Long prose sections (TON whitepapers, TVM spec, …) emit multi-KB index
 * blocks whose tail used to be silently dropped by a hard slice. We now
 * chunk such blocks into overlapping windows so the index keeps every part
 * of the section searchable while staying small (each window is a separate
 * row and ranks independently). MAX_BLOCK_CHARS is the threshold above
 * which a block is split; below it the block is emitted verbatim.
 */
const MAX_BLOCK_CHARS = 2000
/** Target chunk size for split blocks (window length, not a hard cap). */
const CHUNK_TARGET_CHARS = 1500
/** Overlap between consecutive chunks — preserves terms straddling boundaries. */
const CHUNK_OVERLAP_CHARS = 200
/** Search radius around the target window edge when picking a clean break. */
const CHUNK_BOUNDARY_RADIUS = 200

/**
 * If a chunk would end inside an open Markdown fence, extend `cut` past the
 * next closing fence line so neither this chunk nor the next one carries
 * orphaned fence content (which pollutes BM25 with code tokens attributed
 * to prose, or vice versa). Returns `cut` unchanged when the slice has
 * balanced fences.
 */
function balanceFences(text: string, start: number, cut: number): number {
  let inFence = false
  let i = start
  while (i < cut) {
    const nl = text.indexOf("\n", i)
    const lineEnd = nl < 0 ? cut : Math.min(nl, cut)
    if (/^(```|~~~)/.test(text.slice(i, lineEnd))) inFence = !inFence
    if (nl < 0 || nl >= cut) break
    i = nl + 1
  }
  if (!inFence) return cut
  let j = cut
  while (j < text.length) {
    const nl = text.indexOf("\n", j)
    const lineEnd = nl < 0 ? text.length : nl
    if (/^(```|~~~)/.test(text.slice(j, lineEnd))) {
      return nl < 0 ? text.length : nl + 1
    }
    if (nl < 0) return text.length
    j = nl + 1
  }
  return cut
}

/**
 * Split a long content block into ~CHUNK_TARGET_CHARS windows with
 * CHUNK_OVERLAP_CHARS overlap so the tail of an oversized section is no
 * longer dropped. Prefers a paragraph (`\n\n`) breakpoint within
 * ±CHUNK_BOUNDARY_RADIUS of the target window edge; falls back to a
 * sentence boundary (`. `) in the same radius; absolute fallback is a
 * hard char split at the target edge. After picking a boundary, any cut
 * that would land inside an open Markdown fence is extended past the
 * closing fence so per-window BM25 stays clean. Returns the input as a
 * single window when it already fits under MAX_BLOCK_CHARS.
 *
 * Why overlap: a multi-word phrase or co-occurrence pattern that straddles
 * a chunk boundary would otherwise be unindexable; the overlap restores
 * it on the following window. Per-window BM25 is bounded by the small
 * window length, so chunking does not let long pages dominate ranking
 * the way a single giant document would.
 */
function chunkBlockContent(text: string): string[] {
  if (text.length <= MAX_BLOCK_CHARS) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const remaining = text.length - start
    if (remaining <= CHUNK_TARGET_CHARS) {
      chunks.push(text.slice(start))
      break
    }
    const targetEnd = start + CHUNK_TARGET_CHARS
    const lo = Math.max(start + 1, targetEnd - CHUNK_BOUNDARY_RADIUS)
    const hi = Math.min(text.length, targetEnd + CHUNK_BOUNDARY_RADIUS)
    // Paragraph break first: pick the occurrence nearest the target edge.
    let cut = -1
    let bestDist = Infinity
    for (let i = lo; i < hi - 1; i++) {
      if (text.charCodeAt(i) === 10 && text.charCodeAt(i + 1) === 10) {
        const d = Math.abs(i + 2 - targetEnd)
        if (d < bestDist) {
          bestDist = d
          cut = i + 2
        }
      }
    }
    // Sentence break fallback.
    if (cut < 0) {
      bestDist = Infinity
      for (let i = lo; i < hi - 1; i++) {
        if (text.charCodeAt(i) === 46 && text.charCodeAt(i + 1) === 32) {
          const d = Math.abs(i + 2 - targetEnd)
          if (d < bestDist) {
            bestDist = d
            cut = i + 2
          }
        }
      }
    }
    // Hard fallback: target edge exactly.
    if (cut < 0) cut = targetEnd
    cut = balanceFences(text, start, cut)
    chunks.push(text.slice(start, cut))
    const nextStart = cut - CHUNK_OVERLAP_CHARS
    // Guard forward progress: overlap must not stall on the same start index.
    start = nextStart > start ? nextStart : cut
  }
  return chunks
}

/**
 * Per-page cap for the synthetic "code symbols" block. Fumadocs' structured
 * data extraction skips fenced/inline code, so identifiers that appear ONLY
 * in code (`OP_SENDMSG`, `loadUint`, `op::transfer`, get-method names) were
 * unsearchable — the single biggest measured gap on developer queries. We
 * mine just the symbol-like tokens (not whole listings) so the index gains
 * findability without the BM25 dilution / size blow-up of indexing all code.
 */
const MAX_CODE_CHARS = 2500

type StructuredData = {
  headings: {id: string; content: string}[]
  contents: {heading: string | undefined; content: string}[]
}

async function resolveStructuredData(data: unknown): Promise<StructuredData> {
  const d = data as {
    structuredData?: StructuredData | (() => Promise<StructuredData>)
    load?: () => Promise<{structuredData: StructuredData}>
  }
  if (d.structuredData)
    return typeof d.structuredData === "function" ? d.structuredData() : d.structuredData
  if (typeof d.load === "function") return (await d.load()).structuredData
  throw new Error("Cannot find structured data from page for search index")
}

const FENCED_CODE = /```[^\n]*\n([\s\S]*?)```/g
const INLINE_CODE = /`([^`\n]+)`/g

/** Keep a token only if it *looks* like a code symbol, not prose/keywords. */
function isSymbolLike(t: string): boolean {
  if (t.length < 2 || t.length > 40) return false
  if (/^\d+$/.test(t)) return false
  return (
    t.includes("_") || // snake_case, OP_SENDMSG
    t.includes("::") || // FunC/C++ scope, op::transfer
    /[a-z][A-Z]/.test(t) || // camelCase, loadUint
    /^[A-Z][A-Z0-9]{1,}$/.test(t) || // ALLCAPS opcode, SENDRAWMSG
    /[a-zA-Z]\d|\d[a-zA-Z]/.test(t) // alnum mix, int257 / wallet v3
  )
}

/**
 * Mine distinct code-symbol tokens from a page's raw MDX. Order-preserving,
 * de-duplicated, length-capped — a compact "symbol bag" per page rather than
 * verbatim code.
 */
function extractCodeSymbols(raw: string): string {
  let code = ""
  for (const m of raw.matchAll(FENCED_CODE)) code += m[1] + "\n"
  for (const m of raw.matchAll(INLINE_CODE)) code += m[1] + "\n"
  if (code.length === 0) return ""
  const seen = new Set<string>()
  let out = ""
  for (const tok of code.split(/[^A-Za-z0-9_:]+/)) {
    const t = tok.replace(/^:+|:+$/g, "")
    if (!t || seen.has(t) || !isSymbolLike(t)) continue
    seen.add(t)
    out += (out ? " " : "") + t
    if (out.length >= MAX_CODE_CHARS) break
  }
  return out
}

export const {staticGET: GET} = createFromSource(visibleSource, {
  // Orama's sorter store is only consumed by `sortBy` queries. Fumadocs search
  // never sorts (it groups by page and ranks by relevance), so disabling the
  // sorter removes the single largest dead-weight branch of the exported index.
  sort: {enabled: false},
  // Index-time English stemming. `language` MUST live inside the tokenizer
  // config (not top-level) — Orama rejects a top-level `language` alongside a
  // custom tokenizer (NO_LANGUAGE_WITH_CUSTOM_TOKENIZER). This MUST stay in
  // sync with the query-time tokenizer in lib/search-core.ts, or stemmed
  // query terms miss the index and recall silently collapses.
  //
  // allowDuplicates:true restores real BM25 term-frequency (Orama's tokenizer
  // dedupes per field by default → tf capped at 1, flattening tf·idf to just
  // idf). Now that the BM25 blend is active (`bm25Weight=2.5` in
  // DEFAULT_TUNING), true tf is what `bm25/maxBm25` is supposed to be
  // ranging over. Must match the query-time tokenizer config in
  // lib/search-core.ts.
  components: {tokenizer: {language: "english", stemming: true, allowDuplicates: true}},
  async buildIndex(page) {
    const sd = await resolveStructuredData(page.data)
    // Chunk oversized blocks into overlapping windows so the tail of a
    // long section stays indexable (was previously truncated to
    // MAX_BLOCK_CHARS). Each window is emitted as its own `{heading,
    // content}` entry; the shared heading text remains the same so the
    // search-result grouping by `page_id` still places them under the
    // correct section.
    const contents: {heading: string | undefined; content: string}[] = []
    for (const c of sd.contents) {
      for (const window of chunkBlockContent(c.content)) {
        contents.push({heading: c.heading, content: window})
      }
    }

    // Curated synonyms: the `keywords` frontmatter (terms a reader would type
    // that don't appear verbatim on the page — "fungible token", "seed
    // phrase", …). Indexed as a content block so the page becomes a candidate
    // for those queries. This is the safe synonym mechanism — per-page and
    // editor-controlled — unlike query-time expansion, which regressed.
    const keywords = page.data as {keywords?: unknown}
    if (Array.isArray(keywords.keywords) && keywords.keywords.length > 0) {
      contents.push({
        heading: "Keywords",
        content: keywords.keywords.filter(k => typeof k === "string").join(" "),
      })
    }

    // Frontmatter `description` — the short editor-curated summary that
    // appears in nav cards and as the canonical SEO blurb. Promotes the
    // page as a candidate for queries that paraphrase the description's
    // verbs/nouns even when the body text uses different phrasing
    // ("Run a validator node…" → matches query "running validator"). Stored
    // as a separate content block (not merged into body) so its presence
    // can be diagnosed via the same `#Description` URL-fragment trick used
    // for `#Keywords`. Empty/missing → skipped (most pages have non-empty
    // descriptions; the few empty ones just don't contribute this signal).
    const desc = (page.data as {description?: unknown}).description
    if (typeof desc === "string" && desc.trim().length > 0) {
      contents.push({heading: "Description", content: desc.trim()})
    }

    // Code symbols mined from raw MDX (see extractCodeSymbols). `getText` is
    // the fumadocs-mdx accessor; guard it so a page type without it degrades
    // gracefully to no code block rather than failing the whole index build.
    const getText = (page.data as {getText?: (t: "raw" | "processed") => Promise<string>}).getText
    if (typeof getText === "function") {
      const symbols = extractCodeSymbols(await getText.call(page.data, "raw"))
      if (symbols.length > 0) contents.push({heading: "Code symbols", content: symbols})
    }

    // R4: frontmatter `tag` (e.g. `"deprecated"` on tact.mdx, subsecond.mdx,
    // webhooks.mdx) flows through fumadocs' buildDocuments onto every row
    // of this page as `tags: [tag]`. The score function in search-core
    // reads it to down-rank deprecated pages by 0.5×, so the most relevant
    // deprecated page still wins among its peers but sinks below
    // comparably-relevant non-deprecated alternatives.
    const tagRaw = (page.data as {tag?: unknown}).tag
    const tag =
      typeof tagRaw === "string"
        ? tagRaw
        : Array.isArray(tagRaw)
          ? tagRaw.filter((t): t is string => typeof t === "string")
          : undefined

    return {
      title: page.data.title ?? "",
      description: page.data.description,
      url: page.url,
      // fumadocs' buildDocuments emits sub-docs as `${id}-${N}`. Using the
      // raw URL collides when two pages exist as `foo` and `foo-1` (OpenAPI
      // generator sometimes emits both): the first page's 2nd sub-doc id
      // (`foo-1`) clashes with the second page's primary id. Appending `#`
      // — which cannot appear in a fumadocs path URL — keeps page ids and
      // sub-doc ids in disjoint key spaces.
      id: `${page.url}#`,
      ...(tag !== undefined ? {tag} : {}),
      structuredData: {headings: sd.headings, contents},
    }
  },
})
