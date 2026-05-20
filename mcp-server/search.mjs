// search_ton_docs tool: thin proxy to the standalone Orama backend.
//
// We hit /search?q=... on the local Orama service and reformat the
// {term, results[]} payload into a markdown-ish text block that an LLM can
// digest. Results are already grouped page-then-hits by the backend, so we
// preserve that order and surface page url + title + best hits.

const ORAMA_BASE = process.env.ORAMA_URL ?? "http://127.0.0.1:7700"
const SITE_BASE = process.env.SITE_BASE_URL ?? "https://docs-ton.space"
const MAX_PAGES = Number(process.env.SEARCH_MAX_PAGES ?? 12)
const MAX_HITS_PER_PAGE = Number(process.env.SEARCH_MAX_HITS ?? 3)

function fullUrl(urlOrPath) {
  if (!urlOrPath) return SITE_BASE
  if (urlOrPath.startsWith("http")) return urlOrPath
  const clean = urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`
  return `${SITE_BASE}${clean}`
}

function clipSnippet(text, max = 280) {
  if (!text) return ""
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

function format({term, results}) {
  if (!Array.isArray(results) || results.length === 0) {
    return `No results for "${term}".`
  }

  const groups = []
  let current
  for (const r of results) {
    if (r.type === "page") {
      current = {page: r, hits: []}
      groups.push(current)
    } else if (current) {
      current.hits.push(r)
    }
  }

  const lines = [`Found ${groups.length} page${groups.length === 1 ? "" : "s"} for "${term}".`, ""]

  for (const {page, hits} of groups.slice(0, MAX_PAGES)) {
    const title = page.content || page.url
    lines.push(`## ${title}`)
    lines.push(fullUrl(page.url))
    if (Array.isArray(page.breadcrumbs) && page.breadcrumbs.length > 0) {
      lines.push(`Breadcrumbs: ${page.breadcrumbs.join(" › ")}`)
    }
    for (const hit of hits.slice(0, MAX_HITS_PER_PAGE)) {
      const label = hit.type === "heading" ? "Heading" : "Snippet"
      const snippet = clipSnippet(hit.content)
      if (snippet) lines.push(`- ${label}: ${snippet}`)
    }
    lines.push("")
  }

  if (groups.length > MAX_PAGES) {
    lines.push(`… ${groups.length - MAX_PAGES} more pages omitted. Refine your query for fewer, more specific results.`)
  }

  return lines.join("\n").trimEnd()
}

export async function searchTonDocs(query) {
  const q = String(query ?? "").trim()
  if (!q) return `Empty query — provide a search term.`

  const url = `${ORAMA_BASE}/search?q=${encodeURIComponent(q)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(url, {signal: ctrl.signal})
    if (!res.ok) return `[orama backend error: HTTP ${res.status}]`
    const data = await res.json()
    return format(data)
  } catch (err) {
    if (err.name === "AbortError") return `[orama backend timeout]`
    return `[orama backend error: ${err.message}]`
  } finally {
    clearTimeout(timer)
  }
}
