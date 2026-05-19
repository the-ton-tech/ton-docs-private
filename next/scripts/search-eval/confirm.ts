/**
 * Final-config confirmation. The full matrix (report.ts) ablated each lever
 * in isolation; levers interact, so the SHIP candidate — BM25 blend + exact
 * title together — must be measured as a unit on all three slices with
 * significance before it goes into DEFAULT_TUNING. `relevance` is left at
 * Orama defaults: both b directions measured net-negative on held-out
 * (the harness's recurring "intuition is wrong here" result).
 *
 * Usage (from next/, built index): npx tsx scripts/search-eval/confirm.ts
 */
import {
  CURATED_PATH,
  MINED_PATH,
  evaluate,
  loadIndex,
  metricVector,
  pruneToIndex,
  readEvalSet,
  regressions,
} from "./lib/harness"
import {fmtAggregate} from "./lib/metrics"
import {fmtDelta, pairedDelta} from "./lib/stats"
import {splitByTarget} from "./lib/split"
import {DEFAULT_TUNING, type Tuning} from "../../src/lib/search-core"

const CANDIDATES: Record<string, Tuning> = {
  "bm25@2+exact@3": {...DEFAULT_TUNING, bm25Weight: 2, exactTitleWeight: 3},
  "bm25@2.5+exact@3": {...DEFAULT_TUNING, bm25Weight: 2.5, exactTitleWeight: 3},
  "bm25@3+exact@3": {...DEFAULT_TUNING, bm25Weight: 3, exactTitleWeight: 3},
  "bm25@3+exact@4": {...DEFAULT_TUNING, bm25Weight: 3, exactTitleWeight: 4},
}

async function main(): Promise<void> {
  const {db, pageUrls} = loadIndex()
  const curated = readEvalSet(CURATED_PATH)
  const mined = pruneToIndex(readEvalSet(MINED_PATH), pageUrls).kept
  const {train, test} = splitByTarget(mined, 0.5)
  const slices = {curated, "mined-train": train, "mined-test": test} as const

  const base: Record<string, Awaited<ReturnType<typeof evaluate>>> = {}
  for (const [s, set] of Object.entries(slices)) base[s] = await evaluate(db, set, DEFAULT_TUNING)

  for (const [name, t] of Object.entries(CANDIDATES)) {
    console.log(`\n================ ${name} ================`)
    for (const [s, set] of Object.entries(slices)) {
      const cand = await evaluate(db, set, t)
      console.log(`[${s}]`)
      console.log("  " + fmtAggregate("DEFAULT", base[s].overall))
      console.log("  " + fmtAggregate(name, cand.overall))
      const mrr = pairedDelta(metricVector(base[s], "rr"), metricVector(cand, "rr"))
      const nd = pairedDelta(metricVector(base[s], "ndcg10"), metricVector(cand, "ndcg10"))
      const h1 = pairedDelta(metricVector(base[s], "hit1"), metricVector(cand, "hit1"))
      console.log("    " + fmtDelta("mrr", mrr))
      console.log("    " + fmtDelta("ndcg@10", nd))
      console.log("    " + fmtDelta("hit@1", h1))
      if (s === "curated") {
        const regs = regressions(base[s], cand)
        console.log(
          `    curated regressions: ${regs.length}` +
            (regs.length
              ? " — " +
                regs
                  .slice(0, 6)
                  .map(r => `"${r.q}" ${r.from}→${r.to === Infinity ? ">10" : r.to}`)
                  .join("; ")
              : ""),
        )
      }
    }
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
