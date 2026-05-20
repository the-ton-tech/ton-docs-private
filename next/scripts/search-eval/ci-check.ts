/**
 * CI gate for the search-relevance harness. Loads the built index, runs the
 * SHIPPED DEFAULT_TUNING on the curated 126-query slice + the held-out mined
 * 712-query slice (and the gold slice if present), and fails the build if
 * any guarded metric drops below the documented floor in `floors.json`.
 *
 * Two-layer design (per Opus critique on the prior round):
 *  1. Hard floors per slice — fail if shipped slips below them.
 *  2. Soft ratchet — if shipped is materially ABOVE the recorded floor
 *     (delta > slack and direction +), print a warning so the maintainer
 *     bumps the floor on the next commit. The check is non-fatal; the
 *     mechanism just keeps quiet drift visible.
 *
 * Mined-test is gated alongside curated so a change that wins curated but
 * loses held-out (the harness's "intuition is wrong" canary) still fails
 * CI.
 *
 *   npx tsx scripts/search-eval/ci-check.ts
 *   INDEX=out/api/search npx tsx scripts/search-eval/ci-check.ts
 */
import {readFileSync} from "node:fs"
import {dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {
  CURATED_PATH,
  GOLD_PATH,
  MINED_PATH,
  evaluate,
  evaluateGraded,
  loadIndex,
  pruneToIndex,
  readEvalSet,
  readGradedEvalSet,
} from "./lib/harness"
import {splitByTarget} from "./lib/split"
import {DEFAULT_TUNING} from "../../src/lib/search-core"

const HERE = dirname(fileURLToPath(import.meta.url))
const FLOORS_PATH = resolve(HERE, "floors.json")

interface SliceFloor {
  n: number
  floors: Record<string, number>
  slack: number
  commit: string
  date: string
  last_observed: Record<string, number>
}

interface FloorsFile {
  _comment?: string
  curated: SliceFloor
  "mined-test": SliceFloor
  gold?: SliceFloor
}

function readFloors(): FloorsFile {
  return JSON.parse(readFileSync(FLOORS_PATH, "utf8")) as FloorsFile
}

interface Verdict {
  failures: string[]
  ratchet: string[]
}

function checkFloors(
  sliceLabel: string,
  observed: Record<string, number>,
  cfg: SliceFloor,
): Verdict {
  const v: Verdict = {failures: [], ratchet: []}
  for (const [metric, floor] of Object.entries(cfg.floors)) {
    const got = observed[metric]
    if (got === undefined) continue
    if (got < floor) {
      v.failures.push(`${sliceLabel}.${metric} ${got.toFixed(4)} < floor ${floor.toFixed(4)}`)
    }
    const lastObs = cfg.last_observed[metric]
    if (lastObs !== undefined && got > lastObs + cfg.slack) {
      v.ratchet.push(
        `${sliceLabel}.${metric} ${got.toFixed(4)} ≫ recorded ${lastObs.toFixed(4)} ` +
          `(+${(got - lastObs).toFixed(4)} > slack ${cfg.slack}) — bump floors.json`,
      )
    }
  }
  return v
}

async function main(): Promise<void> {
  console.log(`ci-check: index=${process.env.INDEX ?? "out/api/search"}`)
  const floors = readFloors()
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

  const curatedRes = await evaluate(db, curated, DEFAULT_TUNING)
  const ca = curatedRes.overall
  console.log(
    `curated:    n=${ca.n}  hit@1=${ca.hit1.toFixed(4)}  mrr=${ca.mrr.toFixed(4)}  ` +
      `ndcg@10=${ca.ndcg10.toFixed(4)}  cov@10=${ca.cov10.toFixed(4)}`,
  )

  let mined: ReturnType<typeof readEvalSet> = []
  try {
    mined = pruneToIndex(readEvalSet(MINED_PATH), pageUrls).kept
  } catch {
    console.error(`! ${MINED_PATH} not found — held-out gate skipped`)
  }
  let minedTestObs: Record<string, number> = {}
  if (mined.length > 0) {
    const {test: minedTest} = splitByTarget(mined, 0.5)
    const minedRes = await evaluate(db, minedTest, DEFAULT_TUNING)
    const ma = minedRes.overall
    minedTestObs = {hit1: ma.hit1, mrr: ma.mrr, ndcg10: ma.ndcg10, cov10: ma.cov10}
    console.log(
      `mined-test: n=${ma.n}  hit@1=${ma.hit1.toFixed(4)}  mrr=${ma.mrr.toFixed(4)}  ` +
        `ndcg@10=${ma.ndcg10.toFixed(4)}  cov@10=${ma.cov10.toFixed(4)}`,
    )
  }

  let goldObs: Record<string, number> = {}
  try {
    const gold = readGradedEvalSet(GOLD_PATH)
    const gres = await evaluateGraded(db, gold, DEFAULT_TUNING)
    const g = gres.overall
    goldObs = {hit1: g.hit1, ndcgGraded10: g.ndcgGraded10}
    console.log(
      `gold:       n=${g.n}  hit@1=${g.hit1.toFixed(4)}  nDCG_g@10=${g.ndcgGraded10.toFixed(4)}`,
    )
  } catch {
    console.error(`! ${GOLD_PATH} not found — gold gate skipped`)
  }

  console.log("")
  const curatedV = checkFloors("curated", {
    hit1: ca.hit1, mrr: ca.mrr, ndcg10: ca.ndcg10, cov10: ca.cov10,
  }, floors.curated)
  const minedV = mined.length > 0 ? checkFloors("mined-test", minedTestObs, floors["mined-test"]) : {failures: [], ratchet: []}
  const goldV = floors.gold && Object.keys(goldObs).length > 0 ? checkFloors("gold", goldObs, floors.gold) : {failures: [], ratchet: []}

  const failures = [...curatedV.failures, ...minedV.failures, ...goldV.failures]
  const ratchet = [...curatedV.ratchet, ...minedV.ratchet, ...goldV.ratchet]

  if (ratchet.length > 0) {
    console.log(`! ratchet candidates (non-fatal — bump floors.json next commit):`)
    for (const r of ratchet) console.log(`  - ${r}`)
    console.log()
  }

  if (failures.length > 0) {
    console.error(`✗ search-eval CI gate FAILED:`)
    for (const f of failures) console.error(`  - ${f}`)
    console.error(
      `\nIf the regression is real (content edit changed a curated answer),\n` +
        `run \`npm run search:report\` locally, audit the regressions list, fix\n` +
        `the content or update the curated evalset, then re-run CI.`,
    )
    process.exit(1)
  }
  console.log("✓ search-eval CI gate passed")
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
