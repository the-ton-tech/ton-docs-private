/**
 * CI gate for the search-relevance harness. Loads the built index, runs the
 * SHIPPED DEFAULT_TUNING on the curated 126-query slice, and fails the build
 * if any guarded metric drops below the documented floor. The floor is
 * computed once from the ship-commit numbers (DEFAULT shipping with
 * pinAfterStopwords=true, allowDuplicates=true) minus a 1-percentage-point
 * slack to absorb one curated query flipping due to content reshuffling.
 *
 * Intended to run after `npm run build` (which produces out/api/search). Pair
 * with `npm run search:smoke` for infra-only checks that need no built index.
 *
 *   npx tsx scripts/search-eval/ci-check.ts
 *   INDEX=out/api/search npx tsx scripts/search-eval/ci-check.ts
 */
import {CURATED_PATH, evaluate, loadIndex, readEvalSet} from "./lib/harness"
import {DEFAULT_TUNING} from "../../src/lib/search-core"

// Floors are the SHIPPED tuning's curated numbers minus a 0.01 slack. If a
// content edit pushes a single curated query out of top-1 (Δ=-0.0079 on n=126
// per query), the slack absorbs it; deeper regressions fail CI so the human
// looks at it. Update these when DEFAULT_TUNING ships a measured-significant
// improvement; do NOT loosen them to make a regression go away.
const FLOOR = {
  hit1: 0.9,
  mrr: 0.92,
  ndcg10: 0.92,
  cov10: 0.97,
} as const

async function main(): Promise<void> {
  console.log(`ci-check: index=${process.env.INDEX ?? "out/api/search"}`)
  const {db, pageUrls} = loadIndex()
  const curated = readEvalSet(CURATED_PATH)
  for (const q of curated) {
    if (q.expect.every(u => !pageUrls.has(u))) {
      console.error(`✗ curated query "${q.q}" references no in-index URL`)
      process.exit(1)
    }
  }
  for (const [k, url] of Object.entries(DEFAULT_TUNING.pins)) {
    if (!pageUrls.has(url)) {
      console.error(`✗ pin "${k}" → missing URL ${url}`)
      process.exit(1)
    }
  }

  const r = await evaluate(db, curated, DEFAULT_TUNING)
  const a = r.overall
  console.log(
    `curated: n=${a.n}  hit@1=${a.hit1.toFixed(4)}  mrr=${a.mrr.toFixed(4)}  ` +
      `ndcg@10=${a.ndcg10.toFixed(4)}  cov@10=${a.cov10.toFixed(4)}`,
  )

  const failures: string[] = []
  if (a.hit1 < FLOOR.hit1) failures.push(`hit@1 ${a.hit1.toFixed(4)} < ${FLOOR.hit1}`)
  if (a.mrr < FLOOR.mrr) failures.push(`mrr ${a.mrr.toFixed(4)} < ${FLOOR.mrr}`)
  if (a.ndcg10 < FLOOR.ndcg10) failures.push(`ndcg@10 ${a.ndcg10.toFixed(4)} < ${FLOOR.ndcg10}`)
  if (a.cov10 < FLOOR.cov10) failures.push(`cov@10 ${a.cov10.toFixed(4)} < ${FLOOR.cov10}`)

  if (failures.length > 0) {
    console.error(`\n✗ search-eval CI gate FAILED:`)
    for (const f of failures) console.error(`  - ${f}`)
    console.error(
      `\nIf the regression is real (a content edit changed a curated answer),\n` +
        `run \`npm run search:report\` locally, audit the regressions list, fix\n` +
        `the content or update the curated evalset, then re-run CI.`,
    )
    process.exit(1)
  }
  console.log("\n✓ search-eval CI gate passed")
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
