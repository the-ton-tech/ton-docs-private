/**
 * Parameter optimizer for the continuous relevance levers.
 *
 * Hand-guessing weights is exactly what produced the prior round's regressions
 * ("obvious" wins that the harness later killed). This does coordinate ascent
 * over a bounded grid and — critically — optimizes the objective ONLY on
 * mined-train (a held-out-style slice, not the 126 curated queries the pins
 * are built to game), then reports the chosen config's objective on
 * mined-test and curated. A large train↔test gap is overfitting, shown
 * explicitly rather than hidden. The final config is accepted only if it is a
 * significant, positive move on the held-out mined-test slice AND does not
 * significantly regress curated.
 *
 * Usage (from next/, needs a built index):
 *   npx tsx scripts/search-eval/sweep.ts
 *   npx tsx scripts/search-eval/sweep.ts --rounds 3
 */
import {
  CURATED_PATH,
  MINED_PATH,
  evaluate,
  loadIndex,
  metricVector,
  pruneToIndex,
  readEvalSet,
} from "./lib/harness"
import {objective, type Aggregate} from "./lib/metrics"
import {pairedDelta} from "./lib/stats"
import {splitByTarget} from "./lib/split"
import {DEFAULT_TUNING, type Tuning} from "../../src/lib/search-core"

type Axis = {name: string; values: unknown[]; apply: (t: Tuning, v: unknown) => Tuning}

// Bounded grids. Ranges chosen from the Orama source (BM25 b∈[0,1], k≈1.2–2)
// and the lexical weights' existing scale (title/haystack/url are 1–2).
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
]

function fmtTuning(t: Tuning): string {
  const r = t.relevance
  return (
    `bm25=${t.bm25Weight} ` +
    `relB=${r?.b ?? "—"} relK=${r?.k ?? "—"} ` +
    `exTitle=${t.exactTitleWeight} prefix=${t.titlePrefixWeight}`
  )
}

async function main(): Promise<void> {
  const roundsArg = process.argv.indexOf("--rounds")
  const rounds = roundsArg >= 0 ? Number(process.argv[roundsArg + 1]) : 2

  const {db, pageUrls} = loadIndex()
  const curated = readEvalSet(CURATED_PATH)
  const mined = pruneToIndex(readEvalSet(MINED_PATH), pageUrls).kept
  const {train, test} = splitByTarget(mined, 0.5)
  console.log(
    `optimize on mined-train (n=${train.length}); validate on ` +
      `mined-test (n=${test.length}) + curated (n=${curated.length})\n`,
  )

  const obj = async (t: Tuning, set: typeof curated): Promise<Aggregate> =>
    (await evaluate(db, set, t)).overall

  // Baseline = shipped DEFAULT_TUNING.
  const baseTrain = await obj(DEFAULT_TUNING, train)
  console.log(`DEFAULT  train obj=${objective(baseTrain).toFixed(4)}  (${fmtTuning(DEFAULT_TUNING)})\n`)

  let best: Tuning = {...DEFAULT_TUNING}
  let bestObj = objective(baseTrain)

  for (let round = 1; round <= rounds; round++) {
    console.log(`--- round ${round} ---`)
    for (const axis of AXES) {
      let localBest = best
      let localObj = bestObj
      const trail: string[] = []
      for (const v of axis.values) {
        const cand = axis.apply(best, v)
        const o = objective(await obj(cand, train))
        trail.push(`${String(v)}→${o.toFixed(4)}`)
        if (o > localObj + 1e-9) {
          localObj = o
          localBest = cand
        }
      }
      const picked =
        axis.name === "bm25Weight"
          ? localBest.bm25Weight
          : axis.name === "relevance.b"
            ? localBest.relevance?.b
            : axis.name === "relevance.k"
              ? localBest.relevance?.k
              : axis.name === "exactTitleWeight"
                ? localBest.exactTitleWeight
                : localBest.titlePrefixWeight
      console.log(
        `  ${axis.name.padEnd(18)} [${trail.join("  ")}]  → pick ${String(picked)} ` +
          `(obj ${bestObj.toFixed(4)}→${localObj.toFixed(4)})`,
      )
      best = localBest
      bestObj = localObj
    }
  }

  console.log(`\nbest config: ${fmtTuning(best)}`)
  const finalTrain = await obj(best, train)
  const finalTest = await obj(best, test)
  const finalCur = await obj(best, curated)
  const baseTest = await obj(DEFAULT_TUNING, test)
  const baseCur = await obj(DEFAULT_TUNING, curated)

  const line = (lbl: string, a: Aggregate) =>
    `  ${lbl.padEnd(12)} obj=${objective(a).toFixed(4)}  hit@1=${a.hit1.toFixed(4)}  ` +
    `mrr=${a.mrr.toFixed(4)}  ndcg@10=${a.ndcg10.toFixed(4)}  map=${a.map.toFixed(4)}`
  console.log(`\nobjective: train=${objective(finalTrain).toFixed(4)} ` +
    `test=${objective(finalTest).toFixed(4)} ` +
    `(gap=${(objective(finalTrain) - objective(finalTest)).toFixed(4)} — large ⇒ overfit)`)
  console.log("\nDEFAULT:")
  console.log(line("mined-test", baseTest))
  console.log(line("curated", baseCur))
  console.log("BEST:")
  console.log(line("mined-test", finalTest))
  console.log(line("curated", finalCur))

  // Accept only if held-out gain is significant AND curated not sig-worse.
  const bD = await evaluate(db, test, DEFAULT_TUNING)
  const cD = await evaluate(db, test, best)
  const bC = await evaluate(db, curated, DEFAULT_TUNING)
  const cC = await evaluate(db, curated, best)
  const testMrr = pairedDelta(metricVector(bD, "rr"), metricVector(cD, "rr"))
  const testNdcg = pairedDelta(metricVector(bD, "ndcg10"), metricVector(cD, "ndcg10"))
  const curMrr = pairedDelta(metricVector(bC, "rr"), metricVector(cC, "rr"))
  console.log(
    `\nheld-out mined-test  Δmrr=${testMrr.delta.toFixed(4)} p=${testMrr.pValue.toFixed(4)} ` +
      `| Δndcg=${testNdcg.delta.toFixed(4)} p=${testNdcg.pValue.toFixed(4)}`,
  )
  console.log(
    `curated guardrail    Δmrr=${curMrr.delta.toFixed(4)} p=${curMrr.pValue.toFixed(4)} ` +
      `${curMrr.delta < 0 && curMrr.significant ? "✗ SIG REGRESSION" : "✓ ok"}`,
  )
  const accept =
    testMrr.delta > 0 && testMrr.significant && !(curMrr.delta < 0 && curMrr.significant)
  console.log(`\nVERDICT: ${accept ? "✓ ACCEPT — generalizes, no curated regression" : "✗ REJECT"}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
