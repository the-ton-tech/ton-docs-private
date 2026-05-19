import {visibleSource} from "@/lib/source"
import {createFromSource} from "fumadocs-core/search/server"

export const revalidate = false

/**
 * Long prose sections (TON whitepapers, TVM spec, …) emit multi-KB index
 * blocks whose tail almost never decides a match. Capping block length keeps
 * the client-side Orama index small (faster parse + query) without dropping
 * whole sections from search. ~2000 chars ≈ a long paragraph group.
 */
const MAX_BLOCK_CHARS = 2000

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

export const {staticGET: GET} = createFromSource(visibleSource, {
  // Orama's sorter store is only consumed by `sortBy` queries. Fumadocs search
  // never sorts (it groups by page and ranks by relevance), so disabling the
  // sorter removes the single largest dead-weight branch of the exported index.
  sort: {enabled: false},
  // Index-time English stemming. `language` MUST live inside the tokenizer
  // config (not top-level) — Orama rejects a top-level `language` alongside a
  // custom tokenizer (NO_LANGUAGE_WITH_CUSTOM_TOKENIZER). This MUST stay in
  // sync with the query-time tokenizer in components/search.tsx, or stemmed
  // query terms miss the index and recall silently collapses.
  components: {tokenizer: {language: "english", stemming: true}},
  async buildIndex(page) {
    const sd = await resolveStructuredData(page.data)
    return {
      title: page.data.title ?? "",
      description: page.data.description,
      url: page.url,
      id: page.url,
      structuredData: {
        headings: sd.headings,
        contents: sd.contents.map(c =>
          c.content.length > MAX_BLOCK_CHARS
            ? {heading: c.heading, content: c.content.slice(0, MAX_BLOCK_CHARS)}
            : c,
        ),
      },
    }
  },
})
