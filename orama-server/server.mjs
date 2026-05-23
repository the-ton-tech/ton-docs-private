// Standalone Orama search service for ton-docs.
//
// Loads the static index JSON once at startup, then serves ranked search
// results over HTTP. Also serves full per-page Markdown (the `/page`
// endpoint) from a local content directory, so the AI backend can read whole
// pages without an external request. `/page` accepts an optional `anchor`
// query param; when set, only that heading's section is returned (falls
// back to the full page if the anchor is unknown). nginx terminates TLS and
// reverse-proxies to us on 127.0.0.1, so we bind locally only.

import {createServer} from "node:http"
import {readFile, readdir, stat} from "node:fs/promises"
import {dirname, join, relative, sep} from "node:path"
import {load} from "@orama/orama"
import {createClientDB, runRankedSearch, slugify, anchorFromHeadingText} from "./search-core.mjs"

const INDEX_PATH = process.env.ORAMA_INDEX_PATH ?? "/opt/orama-search/index.json"
const PORT = Number(process.env.PORT ?? 7700)
const HOST = process.env.HOST ?? "127.0.0.1"

// Directory of rendered per-page Markdown (next/out/llms.mdx/<path>.md),
// shipped next to the index at deploy time. Defaults beside the index file so
// it follows ORAMA_INDEX_PATH without extra configuration.
const LLMS_CONTENT_DIR =
  process.env.LLMS_CONTENT_DIR ?? join(dirname(INDEX_PATH), "llms-content")

const t0 = Date.now()
const stats = await stat(INDEX_PATH)
console.log(`[orama] loading index ${INDEX_PATH} (${(stats.size / 1e6).toFixed(1)} MB)`)
const indexJson = JSON.parse(await readFile(INDEX_PATH, "utf8"))
const db = createClientDB()
load(db, indexJson)
console.log(`[orama] index loaded in ${Date.now() - t0} ms`)

// --- Per-page content -------------------------------------------------------
// Preload every page's Markdown into memory at startup, keyed by doc path
// ("/blockchain-basics/tvm/overview"). A missing/empty directory is not fatal:
// `/page` then just returns 404 and the caller falls back to search snippets.

const pageContent = new Map()
// pageSections[pageKey] → Map<anchorSlug, {heading, body}>. Sections are cut
// at every Markdown heading (# …) regardless of level, so each heading owns
// the lines up to the next heading.
const pageSections = new Map()

function buildSections(markdown) {
  const sections = new Map()
  // GitHub-slugger-style de-dup: first occurrence keeps the base slug, every
  // repeat appends `-1`, `-2`, ... so two `## Examples` on one page do not
  // overwrite each other (and match the ids the docs site renders).
  const seen = new Map()
  const lines = markdown.split("\n")
  let current = null
  // Track fenced code blocks so a `# foo` line inside ``` ... ``` or ~~~ ... ~~~
  // is NOT mis-parsed as a Markdown heading. The fence delimiter lines stay
  // in the current section's body verbatim.
  let inFence = false
  const flush = () => {
    if (!current) return
    // Symbol-only headings slug to "" under the github-slugger rule; they are
    // unreachable via a URL anchor, so we skip pushing them rather than
    // collapsing every such heading onto the same empty key.
    if (current.slug === "") return
    let key = current.slug
    const prior = seen.get(current.slug) ?? 0
    if (prior > 0) key = `${current.slug}-${prior}`
    seen.set(current.slug, prior + 1)
    sections.set(key, {heading: current.heading, body: current.body.join("\n")})
  }
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      if (current) current.body.push(line)
      continue
    }
    const m = !inFence && /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (m) {
      flush()
      const heading = line
      // The MDX corpus uses fumadocs' explicit-id form `## Title [#explicit-id]`
      // (5,876 occurrences). Slugifying the raw text including the `[#…]`
      // suffix yields keys like `installation-installation` that no anchor
      // ever lands on; `anchorFromHeadingText` strips/uses the explicit id
      // so the keys round-trip with what the docs site renders.
      const slug = anchorFromHeadingText(m[1])
      current = {slug, heading, body: []}
    } else if (current) {
      current.body.push(line)
    }
  }
  flush()
  return sections
}

async function loadPageContent() {
  let entries
  try {
    entries = await readdir(LLMS_CONTENT_DIR, {recursive: true, withFileTypes: true})
  } catch (err) {
    console.warn(`[orama] page content dir unavailable (${LLMS_CONTENT_DIR}): ${err.message}`)
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const full = join(entry.parentPath ?? entry.path ?? LLMS_CONTENT_DIR, entry.name)
    const key = "/" + relative(LLMS_CONTENT_DIR, full).slice(0, -3).split(sep).join("/")
    try {
      const md = await readFile(full, "utf8")
      pageContent.set(key, md)
      pageSections.set(key, buildSections(md))
    } catch {
      // Skip an unreadable file rather than failing the whole load.
    }
  }
  console.log(`[orama] loaded ${pageContent.size} page content files from ${LLMS_CONTENT_DIR}`)
}

await loadPageContent()

/** Reduce an arbitrary url or path to a lookup key like "/foundations/glossary". */
function normalizePagePath(raw) {
  if (!raw) return null
  let p = raw.trim()
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname
    } catch {
      return null
    }
  }
  // Strip any URL fragment before normalizing — callers commonly pass
  // section-anchored URLs and we must not let "#section" leak into the key.
  const hashAt = p.indexOf("#")
  if (hashAt >= 0) p = p.slice(0, hashAt)
  if (!p.startsWith("/")) p = `/${p}`
  p = p.replace(/\/+$/, "").replace(/\.mdx?$/i, "")
  return p || null
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(buf.length),
    ...CORS_HEADERS,
  })
  res.end(buf)
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }
    const url = new URL(req.url ?? "/", "http://localhost")

    if (url.pathname === "/health") {
      json(res, 200, {ok: true, loadedAt: new Date(t0).toISOString(), pages: pageContent.size})
      return
    }

    if (url.pathname === "/search" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? ""
      if (!q.trim()) {
        json(res, 200, {term: "", results: []})
        return
      }
      const started = Date.now()
      const out = await runRankedSearch(db, q)
      const elapsed = Date.now() - started
      res.setHeader("x-orama-ms", String(elapsed))
      json(res, 200, out)
      return
    }

    // Full Markdown of one page. Lookups hit the in-memory map only — an
    // unknown key simply 404s, so there is no path-traversal surface. When
    // `anchor` is provided, slice to that heading's section; unknown anchor
    // falls back to the full page so the ai-backend's retry path is unneeded
    // for that case.
    if (url.pathname === "/page" && req.method === "GET") {
      const key = normalizePagePath(url.searchParams.get("url") ?? "")
      const content = key ? pageContent.get(key) : undefined
      if (content === undefined) {
        json(res, 404, {error: "page not found"})
        return
      }
      const anchorRaw = url.searchParams.get("anchor")
      // An empty slug (e.g. symbol-only `anchor=???`) cannot address any
      // real section and would collide on the same empty key; treat it as
      // "no anchor" and fall through to the full-page response.
      const anchorSlug = anchorRaw ? slugify(anchorRaw) : ""
      if (anchorSlug) {
        const section = pageSections.get(key)?.get(anchorSlug)
        if (section) {
          json(res, 200, {
            url: key,
            anchor: anchorRaw,
            content: `${section.heading}\n${section.body}`,
          })
          return
        }
      }
      json(res, 200, {url: key, content})
      return
    }

    json(res, 404, {error: "not found"})
  } catch (err) {
    console.error("[orama] request error", err)
    json(res, 500, {error: "internal"})
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[orama] listening on http://${HOST}:${PORT}`)
})

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[orama] ${sig} received, shutting down`)
    server.close(() => process.exit(0))
  })
}
