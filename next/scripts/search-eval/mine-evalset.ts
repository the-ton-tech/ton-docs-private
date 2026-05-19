/**
 * Auto-generate a LARGE, grounded, held-out relevance eval set from the
 * corpus, so tuning can be validated for generalization instead of overfit
 * to the 126 hand-written queries (the explicit risk the README calls out).
 *
 * Grounding: every generated query's target URL is derived from the file's
 * own path/frontmatter/headings (the page is, by construction, a correct
 * answer) and then hard-validated against the built index. The dominant
 * noise source is AMBIGUITY (generic titles/headings recurring across pages);
 * defenses: a contentless-phrase stop-list, corpus-wide uniqueness (a query
 * mapping to >3 pages is dropped; 2–3 are merged into `expect[]`), minimum
 * token/char floors, and exclusion of anything that collides with a curated
 * query so the mined set stays genuinely held-out.
 *
 * Usage (from next/, needs a built index for validation):
 *   npx tsx scripts/search-eval/mine-evalset.ts            # write mined-evalset.json
 *   npx tsx scripts/search-eval/mine-evalset.ts --dry      # stats only
 */
import {readFileSync, readdirSync, writeFileSync, statSync} from "node:fs"
import {dirname, join, relative, resolve} from "node:path"
import {fileURLToPath} from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const NEXT_ROOT = resolve(HERE, "..", "..")
const DOCS_ROOT = join(NEXT_ROOT, "content", "docs")
const INDEX_PATH = resolve(process.cwd(), process.env.INDEX ?? "out/api/search")
const CURATED = resolve(HERE, "evalset.json")
const OUT = resolve(HERE, "mined-evalset.json")

// Contentless phrases: valid headings/titles but useless as grounded queries
// because dozens of pages share them. Uniqueness filtering catches most; this
// kills the highest-frequency offenders up front (and their typo/path forms).
const STOP_PHRASES = new Set([
  "overview",
  "introduction",
  "intro",
  "faq",
  "faqs",
  "examples",
  "example",
  "summary",
  "conclusion",
  "prerequisites",
  "see also",
  "next steps",
  "notes",
  "how it works",
  "use cases",
  "usage",
  "getting started",
  "references",
  "reference",
  "table of contents",
  "in this article",
  "what's next",
  "before you begin",
  "requirements",
  "result",
  "results",
  "background",
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith(".mdx")) out.push(p)
  }
  return out
}

/** File path under content/docs → served fumadocs URL (verified mapping:
 * URL = "/" + path sans .mdx; an `index` basename collapses to its parent;
 * `overview` is a literal segment, not special). */
function fileToUrl(file: string): string {
  let rel = relative(DOCS_ROOT, file)
    .replace(/\\/g, "/")
    .replace(/\.mdx$/, "")
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
      // Inline JSON-ish array: ["a", "b", ...]
      const arr = val.match(/"([^"]+)"|'([^']+)'/g)
      if (arr) fm.keywords = arr.map(s => s.replace(/^["']|["']$/g, ""))
    }
  }
  return {fm, body}
}

/** H2/H3 only (deeper headings are usually too granular), markdown stripped. */
function headings(body: string): string[] {
  const out: string[] = []
  for (const raw of body.split("\n")) {
    const m = /^(#{2,3})\s+(.*)$/.exec(raw.trim())
    if (!m) continue
    let h = m[2]
      .replace(/\{#[^}]*\}\s*$/, "") // {#anchor}
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [t](u) → t
      .replace(/[`*_~]/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/[#:]+$/g, "")
      .trim()
    h = h.replace(/\s+/g, " ")
    if (h) out.push(h)
  }
  return out
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ")
}
const tokens = (s: string) => norm(s).split(" ").filter(Boolean)

/** Reject non-query-like strings: OpenAPI route titles ("applications/api/
 * .../get-traces"), code/markup fragments, and over-long phrases no human
 * types into a docs search box. Keeps the mined set realistic. */
function junky(q: string): boolean {
  if (/[/\\|<>{}()[\]=]/.test(q)) return true
  if (q.length > 80) return true
  const tk = tokens(q)
  if (tk.length > 10) return true
  if (tk.some(t => t.length > 28)) return true
  return false
}

// QWERTY-ish single-edit typo on the longest alphabetic token (≥6 chars):
// swap the two characters left of center. Deterministic; rejected later if it
// collides with a real corpus title token.
function typoOf(title: string): {q: string; base: string} | undefined {
  const toks = tokens(title)
  let longest = ""
  for (const t of toks) if (/^[a-z]+$/.test(t) && t.length > longest.length) longest = t
  if (longest.length < 6) return undefined
  const i = Math.floor(longest.length / 2) - 1
  if (i < 1 || longest[i] === longest[i + 1]) return undefined
  const a = longest.split("")
  ;[a[i], a[i + 1]] = [a[i + 1], a[i]]
  const mutated = a.join("")
  return {q: norm(title).replace(longest, mutated), base: longest}
}

type Cand = {q: string; intent: string; url: string; gen: string}

function main(): void {
  const dry = process.argv.includes("--dry")
  const files = walk(DOCS_ROOT)
  const cands: Cand[] = []
  const allTitleTokens = new Set<string>()
  const pages: {url: string; title: string; desc: string; kws: string[]; heads: string[]}[] = []

  for (const f of files) {
    const {fm, body} = parseFrontmatter(readFileSync(f, "utf8"))
    const url = fileToUrl(f)
    const title = (fm.title ?? "").trim()
    const desc = (fm.description ?? "").trim()
    const kws = fm.keywords ?? []
    const heads = headings(body)
    pages.push({url, title, desc, kws, heads})
    for (const t of tokens(title)) if (/^[a-z]+$/.test(t)) allTitleTokens.add(t)
  }

  for (const p of pages) {
    const titleN = norm(p.title)
    // G1 — title as query (exact intent)
    if (titleN && !STOP_PHRASES.has(titleN) && tokens(titleN).length >= 1) {
      cands.push({q: titleN, intent: "exact", url: p.url, gen: "title"})
    }
    // G7 — last two path segments as words (multiword), drop trailing 'overview'
    const segs = p.url.split("/").filter(Boolean)
    while (
      segs.length &&
      (segs[segs.length - 1] === "overview" || /^v\d+$/.test(segs[segs.length - 1]))
    )
      segs.pop()
    if (segs.length >= 2) {
      const q = norm(segs.slice(-2).join(" ").replace(/-/g, " "))
      if (tokens(q).length >= 2 && !STOP_PHRASES.has(q)) {
        cands.push({q, intent: "multiword", url: p.url, gen: "path"})
      }
    }
    // G3 — keywords (synonym intent)
    for (const k of p.kws) {
      const q = norm(k)
      if (q.length >= 3 && !STOP_PHRASES.has(q)) {
        cands.push({q, intent: "synonym", url: p.url, gen: "keyword"})
      }
    }
    // G4 — H2/H3 headings. A heading is only a *grounded* query if it is
    // topically tied to THIS page; otherwise generic headings ("Conclusion",
    // "Adding the dependency", "Step 1") are noise that maps to one page by
    // luck. Require ≥1 shared meaningful token with the title or slug, and
    // cap 2/page so a long page can't flood the held-out distribution.
    const topicToks = new Set<string>(
      [...tokens(titleN), ...segs.flatMap(s => s.split("-"))].filter(
        t => t.length >= 4 && !STOP_PHRASES.has(t),
      ),
    )
    let headTaken = 0
    for (const h of p.heads) {
      if (headTaken >= 2) break
      const q = norm(h)
      if (STOP_PHRASES.has(q) || q.length < 8) continue
      const tk = tokens(q)
      if (tk.length < 2 || tk.length > 8) continue
      if (!tk.some(t => topicToks.has(t))) continue
      const concept = /^(how|why|what|when|where|which)\b/.test(q)
      cands.push({q, intent: concept ? "concept" : "multiword", url: p.url, gen: "heading"})
      headTaken++
    }
    // G5 — description (concept intent), only short, specific descriptions
    if (p.desc) {
      const q = norm(p.desc.replace(/[.?!]+$/, ""))
      const tk = tokens(q)
      if (tk.length >= 3 && tk.length <= 12 && !STOP_PHRASES.has(q)) {
        cands.push({q, intent: "concept", url: p.url, gen: "desc"})
      }
    }
    // G6 — single-edit typo of the title (typo intent)
    const ty = typoOf(p.title)
    if (ty && !allTitleTokens.has(ty.base.replace(ty.base, ""))) {
      // reject if the mutated token is itself a real corpus title token
      const mutatedTok = tokens(ty.q).find(t => !tokens(titleN).includes(t))
      if (!mutatedTok || !allTitleTokens.has(mutatedTok)) {
        cands.push({q: ty.q, intent: "typo", url: p.url, gen: "typo"})
      }
    }
  }

  // Curated queries are excluded so the mined set is genuinely held-out.
  const curated = new Set<string>(
    (JSON.parse(readFileSync(CURATED, "utf8")) as {queries: {q: string}[]}).queries.map(x =>
      norm(x.q),
    ),
  )

  // Aggregate by normalized query → union of target URLs.
  const byQ = new Map<
    string,
    {urls: Set<string>; intents: Map<string, number>; gens: Set<string>}
  >()
  for (const c of cands) {
    if (curated.has(c.q) || junky(c.q)) continue
    const e = byQ.get(c.q) ?? {urls: new Set(), intents: new Map(), gens: new Set()}
    e.urls.add(c.url)
    e.intents.set(c.intent, (e.intents.get(c.intent) ?? 0) + 1)
    e.gens.add(c.gen)
    byQ.set(c.q, e)
  }

  // Validate against the built index (same source of truth as run.ts).
  const idx = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as {
    docs: {docs: Record<string, {type: string; url: string}>}
  }
  const pageUrls = new Set<string>()
  for (const k of Object.keys(idx.docs.docs)) {
    const d = idx.docs.docs[k]
    if (d && d.type === "page") pageUrls.add(d.url)
  }

  const INTENT_PRIORITY = ["typo", "synonym", "concept", "multiword", "exact", "navigational"]
  const queries: {q: string; intent: string; expect: string[]; gen: string}[] = []
  let droppedAmbig = 0
  let droppedMissing = 0
  for (const [q, e] of byQ) {
    if (q.length < 3) continue
    const urls = [...e.urls].filter(u => pageUrls.has(u))
    if (urls.length === 0) {
      droppedMissing++
      continue
    }
    if (urls.length > 3) {
      droppedAmbig++
      continue
    }
    const intent = INTENT_PRIORITY.find(i => e.intents.has(i)) ?? [...e.intents.keys()][0]
    queries.push({q, intent, expect: urls.sort(), gen: [...e.gens].sort().join("+")})
  }

  // Deterministic order (stable across runs), cap per source generator-mix so
  // no single generator dominates the held-out distribution.
  queries.sort((a, b) => (a.q < b.q ? -1 : a.q > b.q ? 1 : 0))

  const byGen: Record<string, number> = {}
  const byIntent: Record<string, number> = {}
  for (const q of queries) {
    byGen[q.gen] = (byGen[q.gen] ?? 0) + 1
    byIntent[q.intent] = (byIntent[q.intent] ?? 0) + 1
  }

  console.log(`pages scanned:        ${pages.length}`)
  console.log(`raw candidates:       ${cands.length}`)
  console.log(`unique queries:       ${byQ.size}`)
  console.log(`dropped (ambiguous):  ${droppedAmbig}`)
  console.log(`dropped (no index):   ${droppedMissing}`)
  console.log(`final mined queries:  ${queries.length}`)
  console.log(`by intent:`, byIntent)
  console.log(`by generator:`, byGen)

  if (!dry) {
    const payload = {
      _comment:
        "AUTO-GENERATED held-out eval set (scripts/mine-evalset.ts). Do not hand-edit. " +
        "Grounded: each expect URL derived from the page's own path/frontmatter/headings " +
        "and validated against the built index. Used to measure GENERALIZATION (train/test " +
        "split in report.ts), complementing the curated evalset.json.",
      queries: queries.map(({q, intent, expect}) => ({q, intent, expect})),
    }
    writeFileSync(OUT, JSON.stringify(payload, null, 0).replace(/},{/g, "},\n{") + "\n")
    console.log(`\nwrote ${queries.length} queries → ${relative(NEXT_ROOT, OUT)}`)
  }
}

main()
