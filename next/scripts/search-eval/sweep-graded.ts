/**
 * Graded-objective parameter optimizer.
 *
 * Sibling of `sweep.ts`. The binary sweep optimizes a hit/rr/ndcg blend on
 * mined-train; this one optimizes a graded objective (Burges nDCG_g + Hit@1
 * + ERR cascade) on a page-stratified half of the Opus 349-query gold slice,
 * then validates on the gold-test half and against the curated set as a
 * regression guardrail. Same coordinate-ascent pattern; same accept rule
 * (must significantly improve gold-test, must not significantly regress
 * curated).
 *
 * The gold slice's median Krippendorff α of 1.000 makes graded metrics
 * higher-signal than the binary auto-mined ones for sub-percent moves, so
 * this is the highest-resolution tuning surface available on this corpus.
 *
 * Usage (from next/, needs out/api/search + gold-evalset.json):
 *   npx tsx scripts/search-eval/sweep-graded.ts
 *   npx tsx scripts/search-eval/sweep-graded.ts --rounds 3
 */
import {
  CURATED_PATH,
  GOLD_PATH,
  evaluate,
  evaluateGraded,
  gradedMetricVector,
  loadIndex,
  metricVector,
  readEvalSet,
  readGradedEvalSet,
  type GradedAggregate,
  type GradedEvalQuery,
} from "./lib/harness"
import {pairedDelta} from "./lib/stats"
import {DEFAULT_TUNING, type Tuning} from "../../src/lib/search-core"

type Axis = {name: string; values: unknown[]; apply: (t: Tuning, v: unknown) => Tuning}

const AXES: Axis[] = [
  {
    name: "bm25Weight",
    values: [0, 0.5, 1, 1.5, 2, 2.5, 3, 4],
    apply: (t, v) => ({...t, bm25Weight: v as number}),
  },
  {
    name: "relevance.b",
    values: [undefined, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0],
    apply: (t, v) => ({...t, relevance: {...t.relevance, b: v as number | undefined}}),
  },
  {
    name: "relevance.k",
    values: [undefined, 1.2, 1.5, 1.8, 2.2],
    apply: (t, v) => ({...t, relevance: {...t.relevance, k: v as number | undefined}}),
  },
  {
    name: "exactTitleWeight",
    values: [0, 1, 2, 3, 5],
    apply: (t, v) => ({...t, exactTitleWeight: v as number}),
  },
  {
    name: "titlePrefixWeight",
    values: [0, 1, 2, 3],
    apply: (t, v) => ({...t, titlePrefixWeight: v as number}),
  },
  {
    name: "codeSymbolWeight",
    values: [0, 0.5, 1, 1.5, 2],
    apply: (t, v) => ({...t, codeSymbolWeight: v as number}),
  },
  {
    name: "structHitWeight",
    values: [0, 1, 2, 3],
    apply: (t, v) => ({...t, structHitWeight: v as number}),
  },
]

/** Graded objective: weighted blend of three calibrated graded signals.
 * 0.4 * nDCG_g@10 + 0.4 * Hit@1 + 0.2 * ERR@10. The weights mirror the
 * binary sweep's intuition (Hit@1 dominates the felt UX) but include
 * the graded continuous signal (nDCG_g, ERR) at the same weight, so a
 * tuning that moves a grade-2 to grade-3 (invisible to Hit@1) still
 * scores. */
function gradedObjective(a: GradedAggregate): number {
  return 0.4 * a.ndcgGraded10 + 0.4 * a.hit1 + 0.2 * a.err10
}

function fmtTuning(t: Tuning): string {
  const r = t.relevance
  return (
    `bm25=${t.bm25Weight} ` +
    `relB=${r?.b ?? "—"} relK=${r?.k ?? "—"} ` +
    `exTitle=${t.exactTitleWeight} prefix=${t.titlePrefixWeight} ` +
    `csw=${t.codeSymbolWeight} struct=${t.structHitWeight}`
  )
}

// FNV-1a for deterministic page-stratified split. Mirrors split.ts so a
// query's target URL set lands on the same side as in the binary sweep —
// but the input shape is `{url, grade}[]` not `string[]`, so we re-project
// to the URL list for hashing.
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function splitGoldByTarget(
  queries: GradedEvalQuery[],
  testFraction = 0.5,
  seed = "v1-graded",
): {train: GradedEvalQuery[]; test: GradedEvalQuery[]} {
  const train: GradedEvalQuery[] = []
  const test: GradedEvalQuery[] = []
  const threshold = Math.round(testFraction * 1000)
  for (const q of queries) {
    const key = [...q.expect.map(e => e.url)].sort().join("|") + "::" + seed
    if (fnv1a(key) % 1000 < threshold) test.push(q)
    else train.push(q)
  }
  return {train, test}
}

async function main(): Promise<void> {
  const roundsArg = process.argv.indexOf("--rounds")
  const rounds = roundsArg >= 0 ? Number(process.argv[roundsArg + 1]) : 2

  const {db} = loadIndex()
  const gold = readGradedEvalSet(GOLD_PATH)
  const {train, test} = splitGoldByTarget(gold, 0.5)
  const curated = readEvalSet(CURATED_PATH)
  console.log(
    `optimize on gold-train (n=${train.length}); validate on ` +
      `gold-test (n=${test.length}) + curated (n=${curated.length})\n`,
  )

  const obj = async (t: Tuning): Promise<GradedAggregate> =>
    (await evaluateGraded(db, train, t)).overall

  const baseTrain = await obj(DEFAULT_TUNING)
  console.log(
    `DEFAULT  train obj=${gradedObjective(baseTrain).toFixed(4)}  (${fmtTuning(DEFAULT_TUNING)})\n`,
  )

  let best: Tuning = {...DEFAULT_TUNING}
  let bestObj = gradedObjective(baseTrain)

  for (let round = 1; round <= rounds; round++) {
    console.log(`--- round ${round} ---`)
    for (const axis of AXES) {
      let localBest = best
      let localObj = bestObj
      const trail: string[] = []
      for (const v of axis.values) {
        const cand = axis.apply(best, v)
        const o = gradedObjective(await obj(cand))
        trail.push(`${String(v)}→${o.toFixed(4)}`)
        if (o > localObj + 1e-9) {
          localObj = o
          localBest = cand
        }
      }
      console.log(`  ${axis.name.padEnd(18)} [${trail.join("  ")}]  → obj ${bestObj.toFixed(4)}→${localObj.toFixed(4)}`)
      best = localBest
      bestObj = localObj
    }
  }

  console.log(`\nbest config: ${fmtTuning(best)}`)
  const finalTrain = await obj(best)
  const finalTest = (await evaluateGraded(db, test, best)).overall
  const baseTest = (await evaluateGraded(db, test, DEFAULT_TUNING)).overall

  const line = (lbl: string, a: GradedAggregate) =>
    `  ${lbl.padEnd(12)} obj=${gradedObjective(a).toFixed(4)}  hit@1=${a.hit1.toFixed(4)}  ` +
    `mrr=${a.mrr.toFixed(4)}  nDCG_g=${a.ndcgGraded10.toFixed(4)}  ERR=${a.err10.toFixed(4)}`
  console.log(
    `\nobjective: train=${gradedObjective(finalTrain).toFixed(4)} ` +
      `test=${gradedObjective(finalTest).toFixed(4)} ` +
      `(gap=${(gradedObjective(finalTrain) - gradedObjective(finalTest)).toFixed(4)} — large ⇒ overfit)`,
  )
  console.log("\nDEFAULT:")
  console.log(line("gold-test", baseTest))
  console.log("BEST:")
  console.log(line("gold-test", finalTest))

  // Accept only if held-out gold-test gain is significant AND curated not sig-worse.
  const bGT = await evaluateGraded(db, test, DEFAULT_TUNING)
  const cGT = await evaluateGraded(db, test, best)
  const bCur = await evaluate(db, curated, DEFAULT_TUNING)
  const cCur = await evaluate(db, curated, best)
  const testNdcgG = pairedDelta(
    gradedMetricVector(bGT, "ndcgGraded10"),
    gradedMetricVector(cGT, "ndcgGraded10"),
  )
  const testHit1 = pairedDelta(
    gradedMetricVector(bGT, "hit1"),
    gradedMetricVector(cGT, "hit1"),
  )
  const curMrr = pairedDelta(metricVector(bCur, "rr"), metricVector(cCur, "rr"))
  console.log(
    `\nheld-out gold-test  Δhit1=${testHit1.delta.toFixed(4)} p=${testHit1.pValue.toFixed(4)} ` +
      `| ΔnDCG_g=${testNdcgG.delta.toFixed(4)} p=${testNdcgG.pValue.toFixed(4)}`,
  )
  console.log(
    `curated guardrail   Δmrr=${curMrr.delta.toFixed(4)} p=${curMrr.pValue.toFixed(4)} ` +
      `${curMrr.delta < 0 && curMrr.significant ? "✗ SIG REGRESSION" : "✓ ok"}`,
  )
  const accept =
    (testHit1.delta > 0 || testNdcgG.delta > 0) &&
    (testHit1.significant || testNdcgG.significant) &&
    !(curMrr.delta < 0 && curMrr.significant)
  console.log(`\nVERDICT: ${accept ? "✓ ACCEPT — generalizes on gold-test, no curated regression" : "✗ REJECT"}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
