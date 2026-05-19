/**
 * Phase 3 orchestrator: prepares Sonnet adversarial-validation batches.
 *
 * Groups the Phase-2 Haiku candidates by 2-level URL prefix (the user's
 * suggested grain — e.g. /applications/ton-connect/ — small enough that
 * Sonnet sees the full page list, large enough to capture cross-page
 * ambiguities). For each category writes a single prompt file containing
 * the full category page roster + all candidates from that category, with
 * the adversarial verdict instructions inline. Sub-agents read one prompt
 * file and Write one verdict JSON. Resumable: skips categories whose
 * verdict file already exists.
 *
 * If a category has > MAX_CANDS_PER_BATCH candidates, it is split into
 * multiple ordered chunks so each Sonnet call has a tractable context.
 *
 * Usage (from next/):
 *   npx tsx scripts/search-eval/orchestrate-sonnet.ts            # prepare batches
 *   npx tsx scripts/search-eval/orchestrate-sonnet.ts --status   # show remaining
 *   npx tsx scripts/search-eval/orchestrate-sonnet.ts --aggregate
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {dirname, join, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {aggregateSonnet} from "./lib/llm-aggregate"
import {sonnetValidationPrompt} from "./lib/llm-prompts"
import {loadAllPages} from "./lib/pages"
import type {CandidateRecord, PageInfo} from "./lib/llm-types"

const HERE = dirname(fileURLToPath(import.meta.url))
const LLM_DIR = resolve(HERE, "llm-data", "sonnet")
const CANDIDATES_FILE = resolve(HERE, "llm-candidates.jsonl")
const FINAL_OUT = resolve(HERE, "llm-validated.jsonl")
const DROPS_OUT = resolve(HERE, "llm-validated-drops.jsonl")
const OBS_OUT = resolve(HERE, "llm-validated-observations.json")

const MAX_CANDS_PER_BATCH = 100

/** Two-level category prefix, e.g. "/applications/ton-connect". Top-level-
 * only would lump too much (/applications has 180+ pages); 3-level would
 * fragment too much. 2-level matched the user's suggestion. */
function categoryOf(url: string): string {
  const segs = url.split("/").filter(Boolean)
  return "/" + segs.slice(0, Math.min(2, segs.length)).join("/")
}

function safeName(s: string): string {
  return s.replace(/^\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_") || "_root"
}

interface Cat {
  category: string
  pages: PageInfo[]
  candidates: CandidateRecord[]
}

function loadCategories(): Cat[] {
  const pages = loadAllPages()
  const cands = readFileSync(CANDIDATES_FILE, "utf8")
    .trim()
    .split("\n")
    .map(l => JSON.parse(l) as CandidateRecord)

  const byCat = new Map<string, Cat>()
  for (const p of pages) {
    const cat = categoryOf(p.url)
    const e = byCat.get(cat) ?? {category: cat, pages: [], candidates: []}
    e.pages.push(p)
    byCat.set(cat, e)
  }
  for (const c of cands) {
    const cat = categoryOf(c.page_url)
    const e = byCat.get(cat)
    if (!e) continue // candidate page not in corpus (shouldn't happen)
    e.candidates.push(c)
  }
  return [...byCat.values()].sort((a, b) => a.category.localeCompare(b.category))
}

function prepare(): void {
  mkdirSync(LLM_DIR, {recursive: true})
  const cats = loadCategories()
  console.log(`categories: ${cats.length}`)
  let totalCands = 0
  let totalBatches = 0
  for (const c of cats) {
    totalCands += c.candidates.length
    // Split into chunks if too large
    const chunks: CandidateRecord[][] = []
    for (let i = 0; i < c.candidates.length; i += MAX_CANDS_PER_BATCH) {
      chunks.push(c.candidates.slice(i, i + MAX_CANDS_PER_BATCH))
    }
    for (let ci = 0; ci < chunks.length; ci++) {
      const base = join(LLM_DIR, `${safeName(c.category)}_part${ci.toString().padStart(2, "0")}`)
      const promptFile = base + ".prompt.txt"
      const candFile = base + ".candidates.json"
      const verdictFile = base + ".verdict.json"

      if (existsSync(verdictFile)) continue // resumable
      // Each candidate gets a stable integer id (its position within the
      // chunk). The id is referenced in the verdict so the aggregator can
      // re-join on q text.
      const ids = chunks[ci].map((cand, idx) => ({id: idx, q: cand.q, claimed_correct: cand.page_url}))
      const prompt = sonnetValidationPrompt(c.category, c.pages, ids, verdictFile)
      writeFileSync(candFile, JSON.stringify(ids, null, 2))
      writeFileSync(promptFile, prompt)
      totalBatches += 1
    }
  }
  console.log(`total candidates: ${totalCands}`)
  console.log(`wrote ${totalBatches} batch files in ${LLM_DIR}`)
  if (totalBatches === 0) console.log("✓ all verdict files already present — nothing to dispatch")
}

function status(): void {
  const cats = loadCategories()
  let totalParts = 0
  let donParts = 0
  for (const c of cats) {
    const parts = Math.ceil(c.candidates.length / MAX_CANDS_PER_BATCH) || 1
    totalParts += parts
    for (let ci = 0; ci < parts; ci++) {
      const verdict = join(
        LLM_DIR,
        `${safeName(c.category)}_part${ci.toString().padStart(2, "0")}.verdict.json`,
      )
      if (existsSync(verdict)) donParts += 1
    }
  }
  console.log(`Sonnet batches complete: ${donParts} / ${totalParts}`)
}

function aggregate(): void {
  const res = aggregateSonnet(LLM_DIR)
  console.log(`verdict files validated: ${res.total - res.errors.length} / ${res.total}`)
  if (res.errors.length > 0) {
    console.log(`✗ ${res.errors.length} verdict files failed validation:`)
    for (const e of res.errors.slice(0, 10)) console.log(`  ${e.file}: ${e.error}`)
  }
  console.log(`kept queries:  ${res.valid.length}`)
  console.log(`dropped queries: ${res.drops.length}`)
  if (res.valid.length === 0) return
  const lines = res.valid.map(v => JSON.stringify(v)).join("\n") + "\n"
  writeFileSync(FINAL_OUT, lines)
  writeFileSync(DROPS_OUT, res.drops.map(d => JSON.stringify(d)).join("\n") + "\n")
  writeFileSync(OBS_OUT, JSON.stringify(res.observations, null, 2))
  console.log(`wrote ${res.valid.length} validated lines → ${FINAL_OUT}`)
  console.log(`wrote ${res.drops.length} drop reasons     → ${DROPS_OUT}`)
  // Distribution
  const byVerdict: Record<string, number> = {}
  const byExpectSize: Record<string, number> = {}
  for (const v of res.valid) {
    byVerdict[v.verdict] = (byVerdict[v.verdict] ?? 0) + 1
    const k = v.expect.length === 1 ? "1" : v.expect.length === 2 ? "2" : "3+"
    byExpectSize[k] = (byExpectSize[k] ?? 0) + 1
  }
  console.log("by verdict:    ", byVerdict)
  console.log("by expect[] size:", byExpectSize)
}

const args = new Set(process.argv.slice(2))
if (args.has("--aggregate")) aggregate()
else if (args.has("--status")) status()
else prepare()
