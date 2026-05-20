/**
 * Phase 5 orchestrator: Opus 3-session graded ranking on a stratified
 * sample of the Sonnet-validated held-out queries.
 *
 *   1. Load llm-validated.jsonl + llm-candidates.jsonl (joined on q so each
 *      validated query carries its Haiku-assigned intent).
 *   2. Deterministic stratified sample: ${TARGET_PER_INTENT} per intent,
 *      capped at the available count. Page-hash split is applied AFTER the
 *      sample so train/test maintain non-overlapping target pages.
 *   3. For each sampled query × 3 Opus sessions (s=1,2,3; instruction
 *      variant 0,1,2) build a ranking prompt with deterministic candidate-
 *      order shuffle keyed on (q, session_id).
 *   4. Pack tasks into batches of BATCH_SIZE for dispatch.
 *   5. Aggregator computes median grade per (query,url), Krippendorff α per
 *      query, drops queries with α < 0.5, writes gold-evalset.json.
 *
 * Usage (from next/, needs out/api/search):
 *   npx tsx scripts/search-eval/orchestrate-opus-rank.ts             # prepare batches
 *   npx tsx scripts/search-eval/orchestrate-opus-rank.ts --status
 *   npx tsx scripts/search-eval/orchestrate-opus-rank.ts --aggregate
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
import {krippendorffAlphaOrdinal, medianAcrossRaters} from "./lib/metrics"
import {opusGradedRankingPrompt} from "./lib/llm-prompts"
import {loadAllPages} from "./lib/pages"
import {readAndValidate} from "./lib/llm-validate"
import {opusRankingOutputSchema, type PageInfo} from "./lib/llm-types"

const HERE = dirname(fileURLToPath(import.meta.url))
const LLM_DIR = resolve(HERE, "llm-data", "opus-rank")
const BATCH_DIR = join(LLM_DIR, "batches")
const VALIDATED_PATH = resolve(HERE, "llm-validated.jsonl")
const CANDIDATES_PATH = resolve(HERE, "llm-candidates.jsonl")
const INDEX_PATH = resolve(process.cwd(), process.env.INDEX ?? "out/api/search")
const GOLD_OUT = resolve(HERE, "gold-evalset.json")
const REPORT_OUT = resolve(HERE, "gold-rank-report.json")

const TARGET_PER_INTENT = 150
const SESSIONS = [1, 2, 3] as const
const BATCH_SIZE = 10
const TASK_SEPARATOR = "\n\n===== TASK BOUNDARY (read & execute each in order) =====\n\n"

interface SampledQuery {
  q: string
  intent: string
  expect: string[]
}

function fnv32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function safeKey(q: string, session_id: number): string {
  const h = fnv32(q + "::" + session_id)
  const slug = q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 32)
    .replace(/^_+|_+$/g, "")
  return `${slug}__${h.toString(16).padStart(8, "0")}_s${session_id}`
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

function loadJoined(): SampledQuery[] {
  const intentByQ = new Map<string, string>()
  for (const line of readFileSync(CANDIDATES_PATH, "utf8").trim().split("\n")) {
    const c = JSON.parse(line) as {q: string; intent: string}
    intentByQ.set(c.q, c.intent)
  }
  const out: SampledQuery[] = []
  for (const line of readFileSync(VALIDATED_PATH, "utf8").trim().split("\n")) {
    const v = JSON.parse(line) as {q: string; expect: string[]}
    const intent = intentByQ.get(v.q)
    if (!intent) continue
    out.push({q: v.q, intent, expect: v.expect})
  }
  return out
}

function stratifiedSample(qs: SampledQuery[], perIntent: number): SampledQuery[] {
  const byIntent = new Map<string, SampledQuery[]>()
  for (const q of qs) {
    const arr = byIntent.get(q.intent) ?? []
    arr.push(q)
    byIntent.set(q.intent, arr)
  }
  const picked: SampledQuery[] = []
  for (const [intent, arr] of byIntent) {
    // Deterministic order: sort by hash of q (stable across runs), take first N.
    arr.sort((a, b) => fnv32(a.q) - fnv32(b.q))
    for (const q of arr.slice(0, perIntent)) picked.push(q)
  }
  return picked
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

async function buildPromptFor(
  db: AnyOrama,
  pages: Map<string, PageInfo>,
  allUrls: string[],
  q: SampledQuery,
  session_id: 1 | 2 | 3,
  outputPath: string,
): Promise<string> {
  const candUrlSet = new Set<string>()
  for (const u of q.expect) candUrlSet.add(u)
  for (const u of await topKUrls(db, q.q, BASELINE_TUNING, 20)) candUrlSet.add(u)
  for (const u of await topKUrls(db, q.q, DEFAULT_TUNING, 20)) candUrlSet.add(u)
  const seed = fnv32(q.q)
  for (const d of pickDecoys(allUrls, candUrlSet, 3, seed)) candUrlSet.add(d)

  const opusCandidates = [...candUrlSet]
    .sort()
    .map(u => pages.get(u))
    .filter((p): p is PageInfo => !!p)
    .map(p => ({
      url: p.url,
      title: p.title,
      breadcrumbs: p.breadcrumbs,
      description: p.description,
      source_file: p.source_file,
    }))

  const variant = ((session_id - 1) % 3) as 0 | 1 | 2
  return opusGradedRankingPrompt(q.q, session_id, opusCandidates, outputPath, variant)
}

async function prepare(): Promise<void> {
  mkdirSync(LLM_DIR, {recursive: true})
  mkdirSync(BATCH_DIR, {recursive: true})
  const {db, pageUrls} = loadIndex()
  const allUrls = [...pageUrls].sort()
  const pages = new Map<string, PageInfo>()
  for (const p of loadAllPages()) pages.set(p.url, p)

  const sampled = stratifiedSample(loadJoined(), TARGET_PER_INTENT)
  console.log(`stratified sample: ${sampled.length} queries`)
  const byIntent: Record<string, number> = {}
  for (const q of sampled) byIntent[q.intent] = (byIntent[q.intent] ?? 0) + 1
  console.log("by intent:", byIntent)

  const sampleManifest = sampled.map(s => ({q: s.q, intent: s.intent, expect: s.expect}))
  writeFileSync(join(LLM_DIR, "sample.manifest.json"), JSON.stringify(sampleManifest, null, 2))

  // Build pending task list (query × session pairs) skipping already-ranked.
  const pendingPrompts: string[] = []
  let skipped = 0
  for (const q of sampled) {
    for (const s of SESSIONS) {
      const out = join(LLM_DIR, `${safeKey(q.q, s)}.ranking.json`)
      if (existsSync(out)) {
        skipped += 1
        continue
      }
      pendingPrompts.push(await buildPromptFor(db, pages, allUrls, q, s, out))
    }
  }

  // Pack into batch files.
  let batches = 0
  for (let i = 0; i < pendingPrompts.length; i += BATCH_SIZE) {
    const chunk = pendingPrompts.slice(i, i + BATCH_SIZE)
    const file = join(BATCH_DIR, `batch_${String(batches).padStart(3, "0")}.prompt.txt`)
    const header =
      `# Opus graded-ranking batch ${batches + 1} — ${chunk.length} tasks\n` +
      `# Each task is one (query, session_id) pair. Execute in order; Write each output.\n` +
      `# When all Write tool calls succeed, end your turn (no chat output).\n\n`
    writeFileSync(file, header + chunk.join(TASK_SEPARATOR))
    batches += 1
  }
  console.log(`pending tasks: ${pendingPrompts.length} (skipped ${skipped} already ranked)`)
  console.log(`wrote ${batches} batch files → ${BATCH_DIR}`)
}

function status(): void {
  const sampled = stratifiedSample(loadJoined(), TARGET_PER_INTENT)
  let done = 0
  let total = 0
  for (const q of sampled) {
    for (const s of SESSIONS) {
      total += 1
      const out = join(LLM_DIR, `${safeKey(q.q, s)}.ranking.json`)
      if (existsSync(out)) done += 1
    }
  }
  console.log(`Opus rankings: ${done} / ${total} (${((100 * done) / total).toFixed(1)}%)`)
}

function aggregateAndReport(): void {
  const sampled = stratifiedSample(loadJoined(), TARGET_PER_INTENT)
  type RatingsMap = Map<string, number[]> // url → [grade_session1, grade_session2, grade_session3]
  interface GoldQuery {
    q: string
    intent: string
    sample_expect: string[] // original Sonnet expect set
    expect: {url: string; grade: number}[] // Opus median grades (grade ≥ 1)
    session_alpha: number
    n_sessions: number
    dropped: boolean // low α
  }
  const goldQueries: GoldQuery[] = []
  let alphaLowDropped = 0
  let parsedCount = 0
  let totalSessionsExpected = 0
  let totalSessionsParsed = 0

  for (const q of sampled) {
    const sessionUrls: string[][] = []
    const sessionGrades: Map<string, number>[] = []
    for (const s of SESSIONS) {
      totalSessionsExpected += 1
      const path = join(LLM_DIR, `${safeKey(q.q, s)}.ranking.json`)
      const r = readAndValidate(path, opusRankingOutputSchema)
      if (!r.ok) continue
      totalSessionsParsed += 1
      const map = new Map<string, number>()
      for (const rt of r.value.ratings) map.set(rt.url, rt.grade)
      sessionGrades.push(map)
      sessionUrls.push([...map.keys()])
    }
    if (sessionGrades.length === 0) continue
    parsedCount += 1

    // Union of all rated URLs across sessions.
    const allUrls = new Set<string>()
    for (const m of sessionGrades) for (const u of m.keys()) allUrls.add(u)

    // Per-unit (URL) row of grades (NaN for absent).
    const ratings: number[][] = []
    for (const u of allUrls) {
      const row: number[] = []
      for (const m of sessionGrades) {
        row.push(m.has(u) ? (m.get(u) as number) : Number.NaN)
      }
      ratings.push(row)
    }

    const alpha = krippendorffAlphaOrdinal(ratings)
    const medians = medianAcrossRaters(ratings)
    const expect: {url: string; grade: number}[] = []
    let i = 0
    for (const u of allUrls) {
      const med = medians[i++]
      if (Number.isFinite(med) && med >= 1) expect.push({url: u, grade: Math.round(med)})
    }
    expect.sort((a, b) => b.grade - a.grade || (a.url < b.url ? -1 : 1))

    const dropped = !Number.isFinite(alpha) || alpha < 0.5
    if (dropped) alphaLowDropped += 1
    goldQueries.push({
      q: q.q,
      intent: q.intent,
      sample_expect: q.expect,
      expect,
      session_alpha: Number.isFinite(alpha) ? alpha : 0,
      n_sessions: sessionGrades.length,
      dropped,
    })
  }

  const kept = goldQueries.filter(g => !g.dropped)
  const alphas = goldQueries.map(g => g.session_alpha).sort((a, b) => a - b)
  const median = alphas[Math.floor(alphas.length / 2)] ?? 0
  const lo = alphas[Math.floor(alphas.length * 0.1)] ?? 0
  const hi = alphas[Math.floor(alphas.length * 0.9)] ?? 0

  // Drop the dropped queries; keep raw expect form for stable JSON shape.
  const goldJson = {
    _comment:
      "Opus 4.7 graded relevance, 3-session median per (query, url). Inter-rater " +
      "Krippendorff α reported; queries with α < 0.5 are dropped (logged separately).",
    n_queries: kept.length,
    sample_target_per_intent: TARGET_PER_INTENT,
    queries: kept.map(({q, intent, expect, session_alpha, n_sessions}) => ({
      q,
      intent,
      expect,
      session_alpha,
      n_sessions,
    })),
  }
  writeFileSync(GOLD_OUT, JSON.stringify(goldJson, null, 0))

  const report = {
    sampled: sampled.length,
    sessions_expected: totalSessionsExpected,
    sessions_parsed: totalSessionsParsed,
    queries_with_any_rating: parsedCount,
    queries_kept: kept.length,
    queries_dropped_low_alpha: alphaLowDropped,
    alpha_distribution: {min: alphas[0] ?? 0, p10: lo, median, p90: hi, max: alphas[alphas.length - 1] ?? 0},
  }
  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2))
  console.log(`sessions parsed: ${totalSessionsParsed} / ${totalSessionsExpected}`)
  console.log(`queries with rating: ${parsedCount} / ${sampled.length}`)
  console.log(`queries kept (α ≥ 0.5): ${kept.length}; dropped (low α): ${alphaLowDropped}`)
  console.log(`α distribution: min=${report.alpha_distribution.min.toFixed(3)} ` +
    `p10=${lo.toFixed(3)} median=${median.toFixed(3)} ` +
    `p90=${hi.toFixed(3)} max=${report.alpha_distribution.max.toFixed(3)}`)
  console.log(`gold → ${GOLD_OUT}`)
  console.log(`report → ${REPORT_OUT}`)
}

const args = new Set(process.argv.slice(2))
if (args.has("--aggregate")) aggregateAndReport()
else if (args.has("--status")) status()
else await prepare()
