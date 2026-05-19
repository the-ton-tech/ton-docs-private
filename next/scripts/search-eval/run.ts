/**
 * Offline search-relevance harness.
 *
 * Scores the EXACT production ranking pipeline (src/lib/search-core.ts) against
 * a grounded eval set, so every tuning change can be measured and ablated
 * instead of guessed. The prior tuning round proved this corpus punishes
 * intuition (synonyms, threshold:0, tolerance:2 all regressed), so nothing
 * ships without a number here.
 *
 * Usage (from next/):
 *   npx tsx scripts/search-eval/run.ts              # baseline vs tuned + ablation
 *   npx tsx scripts/search-eval/run.ts --quick      # baseline vs tuned only
 *   npx tsx scripts/search-eval/run.ts --determinism # 3x identical check
 *   INDEX=out/api/search npx tsx scripts/search-eval/run.ts
 *
 * Metrics are computed over DISTINCT pages in rank order (what a user sees):
 *   Coverage@10  any expected URL within the first 10 distinct pages
 *   Hit@1        the #1 distinct page is an expected URL
 *   Hit@5        an expected URL within the first 5 distinct pages
 *   MRR          1 / rank of the first expected distinct page
 */
import {readFileSync} from "node:fs"
import {dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {load, type AnyOrama, type RawData} from "@orama/orama"
import {
  BASELINE_TUNING,
  DEFAULT_TUNING,
  createClientDB,
  runRankedSearch,
  type Tuning,
} from "../../src/lib/search-core"

type EvalQuery = {q: string; intent: string; expect: string[]}
type EvalSet = {queries: EvalQuery[]}

const INDEX_PATH = resolve(process.cwd(), process.env.INDEX ?? "out/api/search")
const EVALSET_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "evalset.json")

function loadIndexDB(): {db: AnyOrama; pageUrls: Set<string>} {
  const raw = readFileSync(INDEX_PATH, "utf8")
  const data = JSON.parse(raw) as RawData
  const db = createClientDB()
  load(db, data)
  // Universe of valid page URLs (type === "page") for eval-set validation.
  const pageUrls = new Set<string>()
  const docs = (data as unknown as {docs: {docs: Record<string, {type: string; url: string}>}}).docs
    .docs
  for (const k of Object.keys(docs)) {
    const d = docs[k]
    if (d && d.type === "page") pageUrls.add(d.url)
  }
  return {db, pageUrls}
}

/**
 * Fail loudly if the eval set or the production pins reference a URL that no
 * longer exists in the index. This is what stops the eval set from silently
 * rotting into a meaningless number after content moves.
 */
function validateGroundTruth(set: EvalSet, pageUrls: Set<string>): void {
  const problems: string[] = []
  for (const {q, expect} of set.queries) {
    if (!expect || expect.length === 0) problems.push(`query "${q}" has no expected URLs`)
    for (const url of expect) {
      if (!pageUrls.has(url)) problems.push(`query "${q}" expects missing URL ${url}`)
    }
  }
  for (const [key, url] of Object.entries(DEFAULT_TUNING.pins)) {
    if (!pageUrls.has(url)) problems.push(`pin "${key}" -> missing URL ${url}`)
  }
  if (problems.length > 0) {
    console.error(`\n✗ Ground-truth validation failed (${problems.length}):`)
    for (const p of problems) console.error("  - " + p)
    console.error(
      "\nFix evalset.json / DEFAULT_PINS so every URL exists in the index, then re-run.\n",
    )
    process.exit(1)
  }
}

function distinctPageRanks(results: {url: string}[]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const r of results) {
    if (!seen.has(r.url)) {
      seen.add(r.url)
      order.push(r.url)
    }
  }
  return order
}

type Metrics = {n: number; cov10: number; hit1: number; hit5: number; mrr: number}
function emptyMetrics(): Metrics {
  return {n: 0, cov10: 0, hit1: 0, hit5: 0, mrr: 0}
}

async function evaluate(
  db: AnyOrama,
  set: EvalSet,
  tuning: Tuning,
): Promise<{
  overall: Metrics
  byIntent: Record<string, Metrics>
  fails: {q: string; intent: string; got: string[]; expect: string[]}[]
}> {
  const overall = emptyMetrics()
  const byIntent: Record<string, Metrics> = {}
  const fails: {q: string; intent: string; got: string[]; expect: string[]}[] = []

  for (const {q, intent, expect} of set.queries) {
    const {results} = await runRankedSearch(db, q, tuning)
    const ranks = distinctPageRanks(results)
    let firstHit = Infinity
    for (let i = 0; i < ranks.length; i++) {
      if (expect.includes(ranks[i])) {
        firstHit = i + 1
        break
      }
    }
    const m = (byIntent[intent] ??= emptyMetrics())
    for (const bucket of [overall, m]) {
      bucket.n += 1
      if (firstHit <= 10) bucket.cov10 += 1
      if (firstHit === 1) bucket.hit1 += 1
      if (firstHit <= 5) bucket.hit5 += 1
      if (firstHit !== Infinity) bucket.mrr += 1 / firstHit
    }
    if (firstHit > 10) fails.push({q, intent, got: ranks.slice(0, 5), expect})
  }
  return {overall, byIntent, fails}
}

function pct(x: number, n: number): string {
  return n === 0 ? "  -  " : (x / n).toFixed(4)
}

function printMetricsRow(label: string, m: Metrics): void {
  console.log(
    `${label.padEnd(22)} n=${String(m.n).padStart(3)}  ` +
      `cov@10=${pct(m.cov10, m.n)}  hit@1=${pct(m.hit1, m.n)}  ` +
      `hit@5=${pct(m.hit5, m.n)}  mrr=${pct(m.mrr, m.n)}`,
  )
}

function variants(quick: boolean): Record<string, Tuning> {
  if (quick) return {baseline: BASELINE_TUNING, tuned: DEFAULT_TUNING}
  return {
    baseline: BASELINE_TUNING,
    "+stopwords": {...BASELINE_TUNING, stopwords: DEFAULT_TUNING.stopwords},
    "+pins": {...BASELINE_TUNING, pins: DEFAULT_TUNING.pins},
    "+spell": {...BASELINE_TUNING, spell: DEFAULT_TUNING.spell},
    "+structhit": {...BASELINE_TUNING, structHitWeight: 2},
    "+allterms": {...BASELINE_TUNING, allTermsWeight: 3},
    "+proxspan": {...BASELINE_TUNING, proximityWeight: 2},
    tuned: DEFAULT_TUNING,
    "tuned-no-stopwords": {...DEFAULT_TUNING, stopwords: BASELINE_TUNING.stopwords},
    "tuned-no-pins": {...DEFAULT_TUNING, pins: {}},
    "tuned-no-spell": {...DEFAULT_TUNING, spell: {}},
    "tuned-no-structhit": {...DEFAULT_TUNING, structHitWeight: 0},
    "tuned+allterms": {...DEFAULT_TUNING, allTermsWeight: 3},
    "tuned+proxspan": {...DEFAULT_TUNING, proximityWeight: 2},
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const quick = args.has("--quick")
  const determinism = args.has("--determinism")

  console.log(`index:   ${INDEX_PATH}`)
  console.log(`evalset: ${EVALSET_PATH}`)
  const set = JSON.parse(readFileSync(EVALSET_PATH, "utf8")) as EvalSet
  console.log(`loading index (~46MB) …`)
  const {db, pageUrls} = loadIndexDB()
  console.log(`index pages: ${pageUrls.size}, eval queries: ${set.queries.length}\n`)

  validateGroundTruth(set, pageUrls)
  console.log("✓ ground-truth validation passed (all expected & pin URLs exist)\n")

  if (determinism) {
    const runs: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await evaluate(db, set, DEFAULT_TUNING)
      runs.push(JSON.stringify(r.overall))
    }
    const stable = runs.every(r => r === runs[0])
    console.log(`determinism (3x tuned): ${stable ? "✓ identical" : "✗ NON-DETERMINISTIC"}`)
    console.log(runs.join("\n"))
    process.exit(stable ? 0 : 1)
  }

  const vs = variants(quick)
  const results: Record<string, Awaited<ReturnType<typeof evaluate>>> = {}
  for (const [name, tuning] of Object.entries(vs)) {
    results[name] = await evaluate(db, set, tuning)
  }

  console.log("=== Overall ===")
  for (const name of Object.keys(vs)) printMetricsRow(name, results[name].overall)

  const intents = [...new Set(set.queries.map(q => q.intent))].sort()
  console.log("\n=== Coverage@10 by intent ===")
  console.log("variant".padEnd(22) + intents.map(i => i.slice(0, 7).padStart(9)).join(""))
  for (const name of Object.keys(vs)) {
    const r = results[name]
    const row = intents
      .map(i => {
        const m = r.byIntent[i]
        return (m ? (m.cov10 / m.n).toFixed(2) : "-").padStart(9)
      })
      .join("")
    console.log(name.padEnd(22) + row)
  }

  const base = results["baseline"].overall
  const tuned = results["tuned"].overall
  console.log("\n=== baseline → tuned delta ===")
  console.log(
    `cov@10 ${pct(base.cov10, base.n)} → ${pct(tuned.cov10, tuned.n)}   ` +
      `hit@1 ${pct(base.hit1, base.n)} → ${pct(tuned.hit1, tuned.n)}   ` +
      `hit@5 ${pct(base.hit5, base.n)} → ${pct(tuned.hit5, tuned.n)}   ` +
      `mrr ${pct(base.mrr, base.n)} → ${pct(tuned.mrr, tuned.n)}`,
  )
  console.log(
    `fails: baseline ${results["baseline"].fails.length} → tuned ${results["tuned"].fails.length} / ${tuned.n}`,
  )

  console.log("\n=== Residual tuned fails (expected not in top 10) ===")
  for (const f of results["tuned"].fails) {
    console.log(`  [${f.intent}] "${f.q}"`)
    console.log(`     expect: ${f.expect.join(" | ")}`)
    console.log(`     got:    ${f.got.join(" | ") || "(none)"}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
