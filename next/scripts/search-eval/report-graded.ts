/**
 * Phase 7 report: shipped pipeline measured on the Phase 5 graded gold slice.
 *
 * The 3-slice report (curated / mined-train / mined-test, all binary) is the
 * primary measurement surface. This report ADDS the graded gold slice as a
 * high-confidence reference — Opus 4.7's 3-session median grades on 112
 * stratified validated queries with Krippendorff α median 1.000 — and the
 * graded metrics nDCG-graded@10 (Burges 2^g−1 formula), ERR@10 (cascade
 * user model), and mean grade-at-rank-1. These distinguish "perfect first"
 * from "acceptable first when perfect existed" — invisible to binary Hit@1.
 *
 * Usage (from next/, needs out/api/search and gold-evalset.json):
 *   npx tsx scripts/search-eval/report-graded.ts
 *   npx tsx scripts/search-eval/report-graded.ts --vs-baseline
 */
import {
  GOLD_PATH,
  evaluateGraded,
  gradedMetricVector,
  loadIndex,
  readGradedEvalSet,
} from "./lib/harness"
import {fmtDelta, pairedDelta} from "./lib/stats"
import {BASELINE_TUNING, DEFAULT_TUNING, type Tuning} from "../../src/lib/search-core"

function fmtGraded(label: string, a: ReturnType<typeof gradedAgg>): string {
  const p = (x: number) => x.toFixed(4)
  return (
    `${label.padEnd(24)} n=${String(a.n).padStart(3)}  ` +
    `hit@1=${p(a.hit1)}  mrr=${p(a.mrr)}  ndcg-bin=${p(a.ndcg10)}  ` +
    `nDCG_g@10=${p(a.ndcgGraded10)}  ERR@10=${p(a.err10)}  ` +
    `g@1=${p(a.gradeAt1Mean)}`
  )
}
type Aggr = Awaited<ReturnType<typeof evaluateGraded>>["overall"]
function gradedAgg(a: Aggr): Aggr {
  return a
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  console.log(`index:   ${process.env.INDEX ?? "out/api/search"}`)
  console.log(`gold:    ${GOLD_PATH}`)
  const {db} = loadIndex()
  const gold = readGradedEvalSet(GOLD_PATH)
  console.log(`gold queries: ${gold.length}  (median α reported separately in gold-rank-report.json)\n`)

  const variants: Record<string, Tuning> = args.has("--vs-baseline")
    ? {baseline: BASELINE_TUNING, tuned: DEFAULT_TUNING}
    : {tuned: DEFAULT_TUNING}
  if (args.has("--ablate")) {
    variants["tuned+stem"] = {...DEFAULT_TUNING, stemReRank: true}
    variants["tuned+pinAS"] = {...DEFAULT_TUNING, pinAfterStopwords: true}
    variants["tuned+stem+pinAS"] = {
      ...DEFAULT_TUNING,
      stemReRank: true,
      pinAfterStopwords: true,
    }
  }

  const results: Record<string, Aggr> = {}
  const fullResults: Record<string, Awaited<ReturnType<typeof evaluateGraded>>> = {}
  for (const [name, tuning] of Object.entries(variants)) {
    const r = await evaluateGraded(db, gold, tuning)
    results[name] = r.overall
    fullResults[name] = r
  }

  console.log("================ GOLD slice (graded) ================")
  for (const name of Object.keys(variants)) {
    console.log(fmtGraded(name, results[name]))
  }
  const intents = [...new Set(gold.map(q => q.intent))].sort()
  console.log("\n  nDCG_g@10 by intent:")
  console.log("  " + "variant".padEnd(22) + intents.map(i => i.slice(0, 8).padStart(10)).join(""))
  for (const name of Object.keys(variants)) {
    const bi = fullResults[name].byIntent
    console.log(
      "  " +
        name.padEnd(22) +
        intents
          .map(i => (bi[i] ? bi[i].ndcgGraded10.toFixed(3) : "-").padStart(10))
          .join(""),
    )
  }
  console.log("\n  Mean grade-at-rank-1 by intent (0..3):")
  console.log("  " + "variant".padEnd(22) + intents.map(i => i.slice(0, 8).padStart(10)).join(""))
  for (const name of Object.keys(variants)) {
    const bi = fullResults[name].byIntent
    console.log(
      "  " +
        name.padEnd(22) +
        intents
          .map(i => (bi[i] ? bi[i].gradeAt1Mean.toFixed(2) : "-").padStart(10))
          .join(""),
    )
  }

  if (variants.baseline && variants.tuned) {
    console.log(`\n================ SIGNIFICANCE on GOLD (tuned vs baseline) ================`)
    const base = fullResults["baseline"]
    const cand = fullResults["tuned"]
    const mrr = pairedDelta(gradedMetricVector(base, "rr"), gradedMetricVector(cand, "rr"))
    const ndcgG = pairedDelta(
      gradedMetricVector(base, "ndcgGraded10"),
      gradedMetricVector(cand, "ndcgGraded10"),
    )
    const err = pairedDelta(gradedMetricVector(base, "err10"), gradedMetricVector(cand, "err10"))
    const g1 = pairedDelta(
      gradedMetricVector(base, "gradeAt1"),
      gradedMetricVector(cand, "gradeAt1"),
    )
    console.log(fmtDelta("mrr", mrr))
    console.log(fmtDelta("nDCG_g@10", ndcgG))
    console.log(fmtDelta("ERR@10", err))
    console.log(fmtDelta("grade@1", g1))
  }

  // Per-query top-1 grade summary: how often does shipped put a 3 first?
  const tuned = fullResults["tuned"]
  let g3At1 = 0
  let g2At1 = 0
  let g0At1 = 0
  for (const p of tuned.perQuery) {
    if (p.score.gradeAt1 === 3) g3At1++
    else if (p.score.gradeAt1 === 2) g2At1++
    else if (p.score.gradeAt1 === 0) g0At1++
  }
  console.log(`\ntop-1 grade distribution (tuned):  3→${g3At1}  2→${g2At1}  ` +
    `1→${tuned.perQuery.length - g3At1 - g2At1 - g0At1}  0→${g0At1}  (n=${tuned.perQuery.length})`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
