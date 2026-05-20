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

/**
 * Remote Orama backend (server.mjs in /opt/orama-search). Browser sends the
 * query, server runs the full ranking pipeline against an in-memory index and
 * returns the ranked rows. Single source of truth: the server reuses the
 * identical algorithm shipped in `src/lib/search-core.ts`, so the offline
 * eval-harness rankings still describe what users see.
 *
 * Default points at the standalone deployment (docs-ton.space). Override via
 * `NEXT_PUBLIC_ORAMA_SEARCH_URL` for local dev or staging.
 */
const SEARCH_BASE =
  process.env.NEXT_PUBLIC_ORAMA_SEARCH_URL?.replace(/\/+$/, "") ?? "https://docs-ton.space"

type RemoteResult = {
  id: string
  type: "page" | "heading" | "text"
  content: string
  url: string
  breadcrumbs?: string[]
}

async function runSearch(query: string): Promise<SortedResult[]> {
  const q = query.trim()
  if (q.length === 0) return []
  const res = await fetch(`${SEARCH_BASE}/search?q=${encodeURIComponent(q)}`)
  if (!res.ok) throw new Error(`search backend returned ${res.status}`)
  const {term, results} = (await res.json()) as {term: string; results: RemoteResult[]}
  if (results.length === 0) return []
  const highlighter = createContentHighlighter(term)
  return results.map(r => ({...r, content: highlighter.highlightMarkdown(r.content)}))
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
          <SearchDialogClose className="max-md:hidden" />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== "empty" ? query.data : null} />
      </SearchDialogContent>
    </SearchDialog>
  )
}
