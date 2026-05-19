/**
 * Shared corpus loader. Builds a `PageInfo` for every .mdx under
 * `next/content/docs/` — title, description, breadcrumbs, first H2/H3 list,
 * served URL — using the URL-mapping rule confirmed during the heuristic
 * miner work (URL = "/" + path-under-content/docs sans ".mdx"; `index`
 * basenames collapse to the parent; `overview` is a literal segment).
 *
 * Everything downstream (mining, LLM prompts, aggregation) imports this so
 * URL/title strings are consistent across the harness.
 */
import {readFileSync, readdirSync, statSync} from "node:fs"
import {dirname, join, relative, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import type {PageInfo} from "./llm-types"

const HERE = dirname(fileURLToPath(import.meta.url))
export const NEXT_ROOT = resolve(HERE, "..", "..", "..")
export const DOCS_ROOT = join(NEXT_ROOT, "content", "docs")

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith(".mdx")) out.push(p)
  }
  return out
}

export function fileToUrl(file: string): string {
  let rel = relative(DOCS_ROOT, file).replace(/\\/g, "/").replace(/\.mdx$/, "")
  rel = rel.replace(/\/index$/, "")
  return "/" + rel
}

interface Front {
  title?: string
  description?: string
  keywords?: string[]
}

function parseFrontmatter(src: string): {fm: Front; body: string} {
  if (!src.startsWith("---")) return {fm: {}, body: src}
  const end = src.indexOf("\n---", 3)
  if (end < 0) return {fm: {}, body: src}
  const block = src.slice(3, end)
  const body = src.slice(end + 4)
  const fm: Front = {}
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const key = m[1]
    let val = m[2].trim()
    if (key === "title" || key === "description") {
      val = val.replace(/^["']|["']$/g, "")
      ;(fm as Record<string, unknown>)[key] = val
    } else if (key === "keywords") {
      const arr = val.match(/"([^"]+)"|'([^']+)'/g)
      if (arr) fm.keywords = arr.map(s => s.replace(/^["']|["']$/g, ""))
    }
  }
  return {fm, body}
}

/** H2/H3 only (deeper are usually too granular), markdown stripped. */
function extractHeadings(body: string): string[] {
  const out: string[] = []
  for (const raw of body.split("\n")) {
    const m = /^(#{2,3})\s+(.*)$/.exec(raw.trim())
    if (!m) continue
    let h = m[2]
      .replace(/\{#[^}]*\}\s*$/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/[#:]+$/g, "")
      .trim()
    h = h.replace(/\s+/g, " ")
    if (h) out.push(h)
  }
  return out
}

/** Synthesize breadcrumbs from the URL path. Matches what fumadocs' index
 * stores (the harness verified earlier) closely enough for prompt context;
 * the actual production breadcrumbs come from page-tree traversal and may
 * have nicer display labels, but the structure is identical. */
function breadcrumbsFromUrl(url: string): string[] {
  return url
    .split("/")
    .filter(Boolean)
    .slice(0, -1)
    .map(seg => seg.replace(/-/g, " "))
}

export function loadAllPages(): PageInfo[] {
  const files = walk(DOCS_ROOT)
  const out: PageInfo[] = []
  for (const source_file of files) {
    const {fm, body} = parseFrontmatter(readFileSync(source_file, "utf8"))
    const url = fileToUrl(source_file)
    out.push({
      url,
      title: (fm.title ?? "").trim(),
      description: (fm.description ?? "").trim(),
      breadcrumbs: breadcrumbsFromUrl(url),
      source_file,
      h2_h3: extractHeadings(body),
    })
  }
  return out.sort((a, b) => a.url.localeCompare(b.url))
}

/** Slug a URL into a filesystem-safe basename for per-task output files. */
export function urlToFilename(url: string): string {
  return url.replace(/^\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_") || "_root"
}
