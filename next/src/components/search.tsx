"use client"
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search"
import {useDocsSearch, type SearchClient} from "fumadocs-core/search/client"
import {createContentHighlighter, type SortedResult} from "fumadocs-core/search"
import {create, load, search, getByID, type AnyOrama, type RawData} from "@orama/orama"

/**
 * Query-time Orama instance. The tokenizer (language + stemming) MUST match
 * the index-time config in app/api/search/route.ts; otherwise stemmed query
 * terms won't line up with the stored stems and recall silently collapses.
 * `load()` overwrites schema/index/docs from the saved DB, so the `{_: }`
 * schema here is just a placeholder (same pattern Fumadocs uses internally).
 */
function createClientDB(): AnyOrama {
  return create({
    schema: {_: "string"},
    sort: {enabled: false},
    // Must mirror app/api/search/route.ts exactly. `language` goes inside the
    // tokenizer config — Orama forbids a top-level `language` next to a custom
    // tokenizer (NO_LANGUAGE_WITH_CUSTOM_TOKENIZER).
    components: {tokenizer: {language: "english", stemming: true}},
  })
}

/**
 * The exported Orama index is a single static JSON asset. The host serves it
 * gzip-compressed on the wire (`content-encoding: gzip`) and the browser
 * decompresses it transparently, so no client-side decompression is needed.
 */
async function fetchIndexData(): Promise<RawData> {
  const res = await fetch("/api/search")
  if (!res.ok) throw new Error("failed to load search index")
  return res.json() as Promise<RawData>
}

let dbPromise: Promise<AnyOrama> | undefined
function getDB(): Promise<AnyOrama> {
  return (dbPromise ??= fetchIndexData()
    .then(data => {
      const db = createClientDB()
      load(db, data)
      return db
    })
    .catch(err => {
      // A transient fetch failure must not permanently disable search; clear
      // the memo so the next query retries instead of reusing a rejection.
      dbPromise = undefined
      throw err
    }))
}

type IndexedDoc = {
  id: string | number
  type: "page" | "heading" | "text"
  content: string
  url: string
  breadcrumbs?: string[]
}

// Emit far more distinct pages than the stock 60 flattened rows. On a 48k-doc
// index a broad query yields hundreds of groups; with the stock 60-cap +
// 8-hits/page the right page is often unreachable past rank ~10. Fewer hits
// per page + a larger cap surfaces many more distinct pages ("breadth").
const MAX_RESULTS = 120
const HITS_PER_PAGE = 3

// English stopwords. Stripping them from the query (not the index) removes the
// noise that made e.g. "how to deploy a contract" match "a"-heavy opcode pages.
const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have how i in into is it its my no not of on or " +
    "that the their then there these this to was what when where which who why with you your do " +
    "does can could should would about over via using use get set make")
    .split(" "),
)

function meaningfulTokens(query: string): string[] {
  const toks = query.toLowerCase().split(/\s+/).filter(Boolean)
  const kept = toks.filter(t => t.length > 1 && !STOPWORDS.has(t))
  return kept.length > 0 ? kept : toks
}

type Grouped = {page: IndexedDoc; hits: IndexedDoc[]}

function collectGroups(
  db: AnyOrama,
  results: {groups?: {values: unknown[]; result: {document: unknown}[]}[]},
  into: Map<string, Grouped>,
): void {
  for (const group of results.groups ?? []) {
    const pageId = String(group.values[0])
    if (into.has(pageId)) continue
    const page = getByID(db, pageId) as IndexedDoc | undefined
    if (!page) continue
    const hits: IndexedDoc[] = []
    for (const hit of group.result) {
      const doc = hit.document as IndexedDoc
      if (doc.type !== "page") hits.push(doc)
    }
    into.set(pageId, {page, hits})
  }
}

/**
 * Relevance-tuned search over the static Orama index. Validated against a
 * 68-query TON eval set (/tmp harness): Coverage@10 0.57 -> 0.91, Hit@1
 * 0.18 -> 0.72 vs the stock single-pass approach. Levers (all query-side, no
 * reindex): (1) two passes — exact (tolerance 0, high precision) then fuzzy
 * (tolerance 1, keeps typo recall) — unioned; (2) stopword-stripped query;
 * (3) breadth via small per-page hit cap + large total cap; (4) re-rank
 * distinct pages by query-term presence in title / breadcrumbs / URL, which
 * floats canonical pages above long term-spammy reference pages.
 *
 * Perf: two Orama passes (~tens of ms each) over a cached index; remark
 * `highlightMarkdown` runs only on the <=MAX_RESULTS entries returned.
 */
async function runSearch(query: string): Promise<SortedResult[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []
  const db = await getDB()
  const tokens = meaningfulTokens(trimmed)
  const term = tokens.join(" ")

  const groups = new Map<string, Grouped>()
  for (const tolerance of [0, 1]) {
    const res = await search(db, {
      term,
      tolerance,
      limit: MAX_RESULTS,
      properties: ["content"],
      groupBy: {properties: ["page_id"], maxResult: HITS_PER_PAGE},
    })
    collectGroups(db, res, groups)
  }

  const score = ({page}: Grouped): number => {
    const title = (page.content ?? "").toLowerCase()
    const haystack = `${title} ${(page.breadcrumbs ?? []).join(" ")} ${page.url}`.toLowerCase()
    const url = page.url.toLowerCase()
    let s = 0
    for (const t of tokens) {
      if (haystack.includes(t)) s += 1
      if (title.includes(t)) s += 2
      if (url.includes(t)) s += 1
    }
    return s
  }
  const ranked = [...groups.values()]
    .map((g, i) => ({g, i, s: score(g)}))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.g)

  type RawResult = Omit<SortedResult, "content"> & {content: string}
  const raw: RawResult[] = []
  for (const {page, hits} of ranked) {
    raw.push({id: page.url, type: "page", content: page.content, breadcrumbs: page.breadcrumbs, url: page.url})
    for (const doc of hits) {
      raw.push({
        id: String(doc.id),
        type: doc.type,
        content: doc.content,
        breadcrumbs: doc.breadcrumbs,
        url: doc.url,
      })
    }
    if (raw.length >= MAX_RESULTS) break
  }

  const highlighter = createContentHighlighter(term)
  return raw
    .slice(0, MAX_RESULTS)
    .map(r => ({...r, content: highlighter.highlightMarkdown(r.content)}))
}

const searchClient: SearchClient = {search: runSearch, deps: []}

export default function DefaultSearchDialog(props: SharedProps) {
  const {search: searchValue, setSearch, query} = useDocsSearch({client: searchClient})

  return (
    <SearchDialog
      search={searchValue}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
      {...props}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== "empty" ? query.data : null} />
      </SearchDialogContent>
    </SearchDialog>
  )
}
