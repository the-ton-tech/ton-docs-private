/**
 * Phase 4 orchestrator: Opus calibration on the 126 curated queries.
 *
 * The CRITICAL GATE. Before trusting Opus as a graded-ranking judge on the
 * llm-validated slice, we measure how well Opus agrees with the hand-built
 * curated ground truth. For each of the 126 curated queries:
 *   1. Build candidate pool = union(top-20 from BASELINE_TUNING + top-20 from
 *      DEFAULT_TUNING) ∪ curated expect URLs ∪ 3 random decoys. (Includes
 *      expect URLs unconditionally so the gold answer is always rateable.)
 *   2. Write per-query Opus prompt + read-list.
 *   3. (Dispatch happens by parent session via Agent tool with model: opus.)
 *   4. Aggregator computes:
 *        top1_agreement  = fraction of queries where Opus's highest grade
 *                          page is in expect[]
 *        recall_at_expect = fraction where at least one expect URL got grade ≥ 2
 *        false_3_rate     = grade-3 pages that are NOT in expect[]
 *      Gate (Phase 4 contract): top1 ≥ 0.85 AND recall_at_expect ≥ 0.95.
 *
 * Usage (from next/, needs out/api/search):
 *   npx tsx scripts/search-eval/orchestrate-opus-calibrate.ts
 *   npx tsx scripts/search-eval/orchestrate-opus-calibrate.ts --status
 *   npx tsx scripts/search-eval/orchestrate-opus-calibrate.ts --aggregate
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {dirname, join, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {load, type AnyOrama, type RawData} from "@orama/orama"
import {
  BASELINE_TUNING,
  DEFAULT_TUNING,
  createClientDB,
  runRankedSearch,
} from "../../src/lib/search-core"
import {opusGradedRankingPrompt} from "./lib/llm-prompts"
import {loadAllPages, urlToFilename} from "./lib/pages"
import {readAndValidate} from "./lib/llm-validate"
import {opusRankingOutputSchema, type PageInfo} from "./lib/llm-types"

const HERE = dirname(fileURLToPath(import.meta.url))
const LLM_DIR = resolve(HERE, "llm-data", "opus-calib")
const BATCH_DIR = join(LLM_DIR, "batches")
const CURATED_PATH = resolve(HERE, "evalset.json")
const INDEX_PATH = resolve(process.cwd(), process.env.INDEX ?? "out/api/search")
const REPORT_OUT = resolve(HERE, "opus-calibration-report.json")
const BATCH_SIZE = 10
const TASK_SEPARATOR = "\n\n===== TASK BOUNDARY (read & execute each in order) =====\n\n"

interface EvalQuery {
  q: string
  intent: string
  expect: string[]
}

interface CalibTask {
  q: string
  expect: string[]
  candidates: string[] // pool of URLs
  output_path: string
  prompt_path: string
}

function safeKey(q: string): string {
  // Length-capped + hash-suffix so different queries can't collide on slug.
  let h = 0x811c9dc5
  for (let i = 0; i < q.length; i++) {
    h ^= q.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const slug = q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 40)
    .replace(/^_+|_+$/g, "")
  return `${slug}__${(h >>> 0).toString(16).padStart(8, "0")}`
}

function loadIndex(): {db: AnyOrama; pageUrls: Set<string>} {
  const data = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as RawData
  const db = createClientDB()
  load(db, data)
  const urls = new Set<string>()
  const docs = (data as unknown as {docs: {docs: Record<string, {type: string; url: string}>}})
    .docs.docs
  for (const k of Object.keys(docs)) {
    const d = docs[k]
    if (d && d.type === "page") urls.add(d.url)
  }
  return {db, pageUrls: urls}
}

async function topKUrls(db: AnyOrama, q: string, tuning: typeof DEFAULT_TUNING, k: number): Promise<string[]> {
  const {results} = await runRankedSearch(db, q, tuning)
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of results) {
    if (seen.has(r.url)) continue
    seen.add(r.url)
    out.push(r.url)
    if (out.length >= k) break
  }
  return out
}

function pickDecoys(allUrls: string[], exclude: Set<string>, n: number, seed: number): string[] {
  // Mulberry32 deterministic pick — decoys must be reproducible across runs.
  let s = seed
  const rng = (): number => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pool = allUrls.filter(u => !exclude.has(u))
  const picked: string[] = []
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length)
    picked.push(pool.splice(idx, 1)[0])
  }
  return picked
}

async function buildTask(
  db: AnyOrama,
  pages: Map<string, PageInfo>,
  allUrls: string[],
  q: EvalQuery,
): Promise<CalibTask> {
  const candUrlSet = new Set<string>()
  // 1. Always include expect URLs (the gold answers must be rateable).
  for (const u of q.expect) candUrlSet.add(u)
  // 2. Top-20 from each tuning.
  for (const u of await topKUrls(db, q.q, BASELINE_TUNING, 20)) candUrlSet.add(u)
  for (const u of await topKUrls(db, q.q, DEFAULT_TUNING, 20)) candUrlSet.add(u)
  // 3. 3 deterministic decoys.
  let seed = 0x5eed
  for (const c of q.q) seed = Math.imul(seed ^ c.charCodeAt(0), 0x01000193)
  for (const d of pickDecoys(allUrls, candUrlSet, 3, seed)) candUrlSet.add(d)

  const candidates = [...candUrlSet].sort()
  const key = safeKey(q.q)
  const output_path = join(LLM_DIR, `${key}.ranking.json`)
  const prompt_path = join(LLM_DIR, `${key}.prompt.txt`)

  // Build the candidate metadata for the prompt.
  const opusCandidates = candidates
    .map(u => pages.get(u))
    .filter((p): p is PageInfo => !!p)
    .map(p => ({
      url: p.url,
      title: p.title,
      breadcrumbs: p.breadcrumbs,
      description: p.description,
      source_file: p.source_file,
    }))

  const prompt = opusGradedRankingPrompt(q.q, 1, opusCandidates, output_path, 0)
  return {q: q.q, expect: q.expect, candidates, output_path, prompt_path}
}

async function prepare(): Promise<void> {
  mkdirSync(LLM_DIR, {recursive: true})
  mkdirSync(BATCH_DIR, {recursive: true})
  const {db, pageUrls} = loadIndex()
  const allUrls = [...pageUrls].sort()
  const pages = new Map<string, PageInfo>()
  for (const p of loadAllPages()) pages.set(p.url, p)

  const curated = (JSON.parse(readFileSync(CURATED_PATH, "utf8")) as {queries: EvalQuery[]}).queries
  console.log(`curated queries: ${curated.length}; corpus pages: ${pageUrls.size}`)

  // Build per-query prompts for those still missing a ranking output.
  const pendingPrompts: string[] = []
  let skipped = 0
  for (const q of curated) {
    const task = await buildTask(db, pages, allUrls, q)
    if (existsSync(task.output_path)) {
      skipped += 1
      continue
    }
    const opusCandidates = task.candidates
      .map(u => pages.get(u))
      .filter((p): p is PageInfo => !!p)
      .map(p => ({
        url: p.url,
        title: p.title,
        breadcrumbs: p.breadcrumbs,
        description: p.description,
        source_file: p.source_file,
      }))
    pendingPrompts.push(opusGradedRankingPrompt(q.q, 1, opusCandidates, task.output_path, 0))
  }

  // Pack pending prompts into batch files (one sub-agent processes one batch
  // of ~10 ranking tasks — same pattern as Haiku Phase 2).
  let batches = 0
  for (let i = 0; i < pendingPrompts.length; i += BATCH_SIZE) {
    const chunk = pendingPrompts.slice(i, i + BATCH_SIZE)
    const file = join(BATCH_DIR, `batch_${String(batches).padStart(3, "0")}.prompt.txt`)
    const header =
      `# Opus calibration batch ${batches + 1} — ${chunk.length} ranking tasks\n` +
      `# Execute every task below in order. Each task starts after the separator.\n` +
      `# When all Write tool calls succeed, end your turn (no chat output).\n\n`
    writeFileSync(file, header + chunk.join(TASK_SEPARATOR))
    batches += 1
  }
  console.log(`skipped ${skipped} (already ranked); packed ${pendingPrompts.length} tasks into ${batches} batch files`)
  console.log(`batches → ${BATCH_DIR}`)
}

function aggregateAndReport(): void {
  const curated = (
    JSON.parse(readFileSync(CURATED_PATH, "utf8")) as {queries: EvalQuery[]}
  ).queries

  let parsed = 0
  let top1Agree = 0
  let recallAtExpect = 0
  let false3 = 0
  const queryDetails: {
    q: string
    expect: string[]
    top1: {url: string; grade: number} | null
    expectGrades: {url: string; grade: number}[]
    false3Urls: string[]
  }[] = []

  for (const q of curated) {
    const key = safeKey(q.q)
    const path = join(LLM_DIR, `${key}.ranking.json`)
    const r = readAndValidate(path, opusRankingOutputSchema)
    if (!r.ok) continue
    parsed += 1
    const ratings = r.value.ratings
    const expectSet = new Set(q.expect)

    // Top-1: highest-grade page (ties → alphabetic first stable). If that
    // page is in expect[], count agreement.
    let top: {url: string; grade: number} | null = null
    for (const rt of ratings) {
      if (!top || rt.grade > top.grade) top = {url: rt.url, grade: rt.grade}
    }
    if (top && top.grade > 0 && expectSet.has(top.url)) top1Agree += 1

    // Recall@expect: did at least one expect URL get grade ≥ 2?
    const expectGrades: {url: string; grade: number}[] = []
    for (const rt of ratings) if (expectSet.has(rt.url)) expectGrades.push({url: rt.url, grade: rt.grade})
    if (expectGrades.some(e => e.grade >= 2)) recallAtExpect += 1

    // False-3: grade-3 ratings on non-expect URLs.
    const false3Urls: string[] = []
    for (const rt of ratings) if (rt.grade === 3 && !expectSet.has(rt.url)) false3Urls.push(rt.url)
    if (false3Urls.length > 0) false3 += 1

    queryDetails.push({q: q.q, expect: q.expect, top1: top, expectGrades, false3Urls})
  }

  const n = curated.length
  const report = {
    total_queries: n,
    parsed,
    top1_agreement: parsed === 0 ? 0 : top1Agree / parsed,
    recall_at_expect: parsed === 0 ? 0 : recallAtExpect / parsed,
    false_3_rate: parsed === 0 ? 0 : false3 / parsed,
    gate: {
      top1_threshold: 0.85,
      recall_threshold: 0.95,
      passed:
        parsed === n &&
        top1Agree / parsed >= 0.85 &&
        recallAtExpect / parsed >= 0.95,
    },
    queryDetails,
  }
  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2))
  console.log(`parsed ${parsed} / ${n} ranking files`)
  console.log(`top1_agreement:   ${report.top1_agreement.toFixed(4)} (target ≥ 0.85)`)
  console.log(`recall_at_expect: ${report.recall_at_expect.toFixed(4)} (target ≥ 0.95)`)
  console.log(`false_3_rate:     ${report.false_3_rate.toFixed(4)} (lower = better)`)
  console.log(`gate passed: ${report.gate.passed ? "✓ YES" : "✗ NO"}`)
  console.log(`report → ${REPORT_OUT}`)
}

function status(): void {
  const curated = (
    JSON.parse(readFileSync(CURATED_PATH, "utf8")) as {queries: EvalQuery[]}
  ).queries
  let done = 0
  for (const q of curated) {
    const key = safeKey(q.q)
    if (existsSync(join(LLM_DIR, `${key}.ranking.json`))) done += 1
  }
  console.log(`Opus calibration: ${done} / ${curated.length}`)
}

const args = new Set(process.argv.slice(2))
if (args.has("--aggregate")) aggregateAndReport()
else if (args.has("--status")) status()
else await prepare()
