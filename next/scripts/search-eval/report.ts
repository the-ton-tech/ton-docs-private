/**
 * Search-relevance report (v2 of the harness).
 *
 * What the original run.ts could NOT tell us, and why this exists:
 *  • Overfitting blindness — 126 hand queries only. A change that helps them
 *    can be memorization. This scores every variant on THREE slices: the
 *    curated set, and a held-out mined set split into train/test by target
 *    page (a config that wins train but not test is overfit, and it shows).
 *  • Noise blindness — a +0.01 metric move can be one query. Every variant is
 *    compared to the shipped DEFAULT with a paired permutation test +
 *    bootstrap CI; only changes significant on the HELD-OUT test slice count.
 *  • Metric blindness — Hit@1/MRR hide tail reshuffling. nDCG@10, Recall@10,
 *    Precision@10 and MAP are reported alongside.
 *  • Regression blindness — net-flat aggregates hide "won 4 / lost 4". The
 *    per-query regression list surfaces every query a variant worsened.
 *
 * Usage (from next/, needs a built index):
 *   npx tsx scripts/search-eval/report.ts            # full variant matrix
 *   npx tsx scripts/search-eval/report.ts --quick    # baseline vs tuned only
 *   npx tsx scripts/search-eval/report.ts --determinism
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
  type EvalResult,
} from "./lib/harness"
import {fmtAggregate} from "./lib/metrics"
import {fmtDelta, pairedDelta} from "./lib/stats"
import {splitByTarget} from "./lib/split"
import {BASELINE_TUNING, DEFAULT_TUNING, type Tuning} from "../../src/lib/search-core"

function variantMatrix(quick: boolean): Record<string, Tuning> {
  if (quick) {
    return {baseline: BASELINE_TUNING, tuned: DEFAULT_TUNING}
  }
  return {
    baseline: BASELINE_TUNING,
    tuned: DEFAULT_TUNING,
    // Each candidate lever layered on the SHIPPED tuning, one at a time, so
    // its marginal effect is isolated (the harness's core discipline).
    "tuned+bm25@1": {...DEFAULT_TUNING, bm25Weight: 1},
    "tuned+bm25@2": {...DEFAULT_TUNING, bm25Weight: 2},
    "tuned+bm25@3": {...DEFAULT_TUNING, bm25Weight: 3},
    "tuned+relB.4": {...DEFAULT_TUNING, relevance: {b: 0.4}},
    "tuned+relB.9": {...DEFAULT_TUNING, relevance: {b: 0.9}},
    "tuned+exacttitle": {...DEFAULT_TUNING, exactTitleWeight: 3},
    "tuned+titleprefix": {...DEFAULT_TUNING, titlePrefixWeight: 2},
    "tuned+stem": {...DEFAULT_TUNING, stemReRank: true},
    "tuned+hd@0.1": {...DEFAULT_TUNING, headingMatchWeight: 0.1},
    "tuned+hd@0.3": {...DEFAULT_TUNING, headingMatchWeight: 0.3},
    "tuned+tbm@1": {...DEFAULT_TUNING, titleBM25Weight: 1},
  }
}

const SLICES = ["curated", "mined-train", "mined-test"] as const
type Slice = (typeof SLICES)[number]

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const quick = args.has("--quick")

  console.log(`index:   ${process.env.INDEX ?? "out/api/search"}`)
  const {db, pageUrls} = loadIndex()

  const curated = readEvalSet(CURATED_PATH)
  // Curated set hard-validates (original contract): a moved URL is a bug to
  // fix, not to silently prune.
  const badCurated = curated.flatMap(q => (q.expect.every(u => !pageUrls.has(u)) ? [q.q] : []))
  if (badCurated.length > 0) {
    console.error(`\n✗ curated eval references missing URLs: ${badCurated.join(", ")}`)
    process.exit(1)
  }
  for (const [k, url] of Object.entries(DEFAULT_TUNING.pins)) {
    if (!pageUrls.has(url)) {
      console.error(`✗ pin "${k}" → missing URL ${url}`)
      process.exit(1)
    }
  }

  let mined: ReturnType<typeof readEvalSet> = []
  try {
    mined = pruneToIndex(readEvalSet(MINED_PATH), pageUrls).kept
  } catch {
    console.error(`! ${MINED_PATH} not found — run mine-evalset.ts first. Curated-only.`)
  }
  const {train: minedTrain, test: minedTest} = splitByTarget(mined, 0.5)

  const sets: Record<Slice, typeof curated> = {
    curated,
    "mined-train": minedTrain,
    "mined-test": minedTest,
  }
  console.log(
    `slices: curated=${curated.length}  mined-train=${minedTrain.length}  ` +
      `mined-test=${minedTest.length}  (pages indexed: ${pageUrls.size})\n`,
  )

  if (args.has("--determinism")) {
    const runs: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await evaluate(db, curated, DEFAULT_TUNING)
      runs.push(JSON.stringify(r.overall))
    }
    const ok = runs.every(r => r === runs[0])
    console.log(`determinism (3× tuned/curated): ${ok ? "✓ identical" : "✗ NON-DETERMINISTIC"}`)
    console.log(runs.join("\n"))
    process.exit(ok ? 0 : 1)
  }

  const variants = variantMatrix(quick)
  const results: Record<string, Record<Slice, EvalResult>> = {}
  for (const [name, tuning] of Object.entries(variants)) {
    results[name] = {} as Record<Slice, EvalResult>
    for (const slice of SLICES) {
      if (sets[slice].length === 0) continue
      results[name][slice] = await evaluate(db, sets[slice], tuning)
    }
  }

  for (const slice of SLICES) {
    if (sets[slice].length === 0) continue
    console.log(
      `\n================ ${slice.toUpperCase()} (n=${sets[slice].length}) ================`,
    )
    for (const name of Object.keys(variants)) {
      console.log(fmtAggregate(name, results[name][slice].overall))
    }
    // Per-intent nDCG@10 — where does each lever actually move the needle.
    const intents = [...new Set(sets[slice].map(q => q.intent))].sort()
    console.log("\n  nDCG@10 by intent:")
    console.log("  " + "variant".padEnd(22) + intents.map(i => i.slice(0, 8).padStart(10)).join(""))
    for (const name of Object.keys(variants)) {
      const bi = results[name][slice].byIntent
      console.log(
        "  " +
          name.padEnd(22) +
          intents.map(i => (bi[i] ? bi[i].ndcg10.toFixed(3) : "-").padStart(10)).join(""),
      )
    }
  }

  // Significance vs the SHIPPED tuning on every slice. The verdict that
  // matters is mined-test: significant + positive there = it generalizes.
  console.log(`\n================ SIGNIFICANCE vs "tuned" (paired, 10k perm) ================`)
  for (const name of Object.keys(variants)) {
    if (name === "tuned" || name === "baseline") continue
    console.log(`\n${name}:`)
    for (const slice of SLICES) {
      if (sets[slice].length === 0) continue
      const base = results["tuned"][slice]
      const cand = results[name][slice]
      const mrr = pairedDelta(metricVector(base, "rr"), metricVector(cand, "rr"))
      const ndcg = pairedDelta(metricVector(base, "ndcg10"), metricVector(cand, "ndcg10"))
      const h1 = pairedDelta(metricVector(base, "hit1"), metricVector(cand, "hit1"))
      console.log(`  [${slice}]`)
      console.log("    " + fmtDelta("mrr", mrr))
      console.log("    " + fmtDelta("ndcg@10", ndcg))
      console.log("    " + fmtDelta("hit@1", h1))
    }
  }

  // Regressions vs shipped on the clean, interpretable curated slice.
  console.log(`\n================ REGRESSIONS vs "tuned" (curated) ================`)
  for (const name of Object.keys(variants)) {
    if (name === "tuned" || name === "baseline") continue
    const regs = regressions(results["tuned"].curated, results[name].curated)
    if (regs.length === 0) {
      console.log(`${name}: none`)
      continue
    }
    console.log(`${name}: ${regs.length} worsened`)
    for (const r of regs.slice(0, 8)) {
      console.log(`   [${r.intent}] "${r.q}"  rank ${r.from} → ${r.to === Infinity ? ">10" : r.to}`)
    }
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
