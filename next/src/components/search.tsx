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

async function inflateGzip(gzip: ArrayBuffer): Promise<string> {
  if (typeof DecompressionStream === "undefined")
    throw new Error("Search unavailable: this browser has no DecompressionStream (gzip).")
  const stream = new Blob([gzip]).stream().pipeThrough(new DecompressionStream("gzip"))
  return new Response(stream).text()
}

/**
 * Production: the gzip-split artifact emitted by
 * scripts/optimize-search-index.mjs. Dev (`next dev`): the live uncompressed
 * route, since the post-build optimizer hasn't run.
 */
async function fetchIndexData(): Promise<RawData> {
  const manifestRes = await fetch("/api/search-index/manifest.json")
  if (manifestRes.ok) {
    const manifest = (await manifestRes.json()) as {segments: string[]}
    const parts = await Promise.all(
      manifest.segments.map(name =>
        fetch(`/api/search-index/${name}`).then(res => {
          if (!res.ok) throw new Error(`failed to fetch search segment ${name}`)
          return res.arrayBuffer()
        }),
      ),
    )
    const gz = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
    let offset = 0
    for (const part of parts) {
      gz.set(new Uint8Array(part), offset)
      offset += part.byteLength
    }
    // `gz` owns a freshly allocated, exactly-sized ArrayBuffer (offset 0).
    return JSON.parse(await inflateGzip(gz.buffer as ArrayBuffer)) as RawData
  }

  const res = await fetch("/api/search")
  if (!res.ok) throw new Error("failed to load search index (no static artifact, no dev route)")
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
      // A transient segment-fetch failure must not permanently disable search;
      // clear the memo so the next query retries instead of reusing a rejection.
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

const MAX_RESULTS = 60

/**
 * Faithful re-implementation of fumadocs-core's internal `searchAdvanced`
 * (dist/advanced-*.js) on top of public APIs only, plus the two UX levers the
 * stock static client never sets: `tolerance: 1` (typo tolerance) and the
 * coordinated stemming tokenizer (recall). Result shape matches `SortedResult`
 * exactly so the stock SearchDialog UI renders unchanged.
 *
 * Perf: on a 48k-record index a broad query yields hundreds of groups. We
 * stop collecting once `MAX_RESULTS` is reached and run the remark-based
 * `highlightMarkdown` only on the entries we actually return — highlighting
 * every hit first (then slicing) froze the main thread for tens of seconds.
 */
async function runSearch(query: string): Promise<SortedResult[]> {
  if (query.trim().length === 0) return []
  const db = await getDB()
  const result = await search(db, {
    term: query,
    tolerance: 1,
    limit: MAX_RESULTS,
    properties: ["content"],
    groupBy: {properties: ["page_id"], maxResult: 8},
  })

  type RawResult = Omit<SortedResult, "content"> & {content: string}
  const raw: RawResult[] = []
  outer: for (const group of result.groups ?? []) {
    const pageId = String(group.values[0])
    const page = getByID(db, pageId) as IndexedDoc | undefined
    if (!page) continue
    raw.push({id: pageId, type: "page", content: page.content, breadcrumbs: page.breadcrumbs, url: page.url})
    for (const hit of group.result) {
      const doc = hit.document as IndexedDoc
      if (doc.type === "page") continue
      raw.push({
        id: String(doc.id),
        type: doc.type,
        content: doc.content,
        breadcrumbs: doc.breadcrumbs,
        url: doc.url,
      })
      if (raw.length >= MAX_RESULTS) break outer
    }
    if (raw.length >= MAX_RESULTS) break
  }

  const highlighter = createContentHighlighter(query)
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
