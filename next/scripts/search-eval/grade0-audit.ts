/**
 * Surface every gold-slice query where the shipped pipeline puts a grade-0
 * page at rank 1 — i.e. nothing relevant in the first slot. Per the Phase-7
 * "27 queries still grade-0 at rank 1" diagnostic, these are the next-most
 * tractable target: bucket them by failure mode (synonym-gap → keywords:
 * frontmatter, length-bias → BM25 retune, ambiguous → curated pin), then
 * attack the largest bucket. Outputs a structured JSON for follow-up.
 *
 * Usage (from next/, needs built index + gold-evalset.json):
 *   npx tsx scripts/search-eval/grade0-audit.ts
 *   npx tsx scripts/search-eval/grade0-audit.ts --json > grade0.json
 */
import {writeFileSync} from "node:fs"
import {GOLD_PATH, evaluateGraded, loadIndex, readGradedEvalSet} from "./lib/harness"
import {DEFAULT_TUNING} from "../../src/lib/search-core"

interface FailureRow {
  q: string
  intent: string
  expect_top: {url: string; grade: number}
  actual_top: string | undefined
  actual_top_grade: number
  expect_rank_in_top10: number | null
  ranks: string[]
}

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2))
  const asJson = argv.has("--json")
  const {db} = loadIndex()
  const gold = readGradedEvalSet(GOLD_PATH)
  const res = await evaluateGraded(db, gold, DEFAULT_TUNING)

  const grade0: FailureRow[] = []
  for (const p of res.perQuery) {
    if (p.score.gradeAt1 !== 0) continue
    const topExpect = [...p.expect]
      .filter(e => e.grade >= 2)
      .sort((a, b) => b.grade - a.grade)[0]
    if (!topExpect) continue
    const actualTop = p.ranks[0]
    const expectRank = p.ranks.findIndex(u => {
      const e = p.expect.find(x => x.url === u)
      return e !== undefined && e.grade >= 2
    })
    grade0.push({
      q: p.q,
      intent: p.intent,
      expect_top: topExpect,
      actual_top: actualTop,
      actual_top_grade: 0,
      expect_rank_in_top10: expectRank >= 0 ? expectRank + 1 : null,
      ranks: p.ranks.slice(0, 10),
    })
  }

  if (asJson) {
    writeFileSync(
      "scripts/search-eval/grade0-failures.json",
      JSON.stringify({n: grade0.length, queries: grade0}, null, 2),
    )
    console.log(`wrote scripts/search-eval/grade0-failures.json (${grade0.length} queries)`)
    return
  }

  console.log(`Gold slice grade=0 @ rank 1: ${grade0.length} of ${gold.length}`)
  console.log()

  // Bucket by recoverability: expected page is somewhere in top-10 (rank
  // bug — fixable by tuning) vs. not (recall bug — content/index level).
  const inTop10 = grade0.filter(r => r.expect_rank_in_top10 !== null)
  const notFound = grade0.filter(r => r.expect_rank_in_top10 === null)
  console.log(`  Buckets:`)
  console.log(`    rank bug (expected in top-10, mis-ordered):  ${inTop10.length}`)
  console.log(`    recall bug (expected NOT in top-10):         ${notFound.length}`)
  console.log()

  console.log("=== Rank bugs (top-10 candidate exists; promote it) ===")
  for (const r of inTop10) {
    console.log(
      `  [${r.intent.padEnd(15)}] "${r.q}"`,
    )
    console.log(`    expect: ${r.expect_top.url} (grade ${r.expect_top.grade}) at rank ${r.expect_rank_in_top10}`)
    console.log(`    actual: ${r.actual_top}`)
  }

  console.log()
  console.log("=== Recall bugs (expected not in top-10; index-level fix) ===")
  for (const r of notFound) {
    console.log(
      `  [${r.intent.padEnd(15)}] "${r.q}"`,
    )
    console.log(`    expect: ${r.expect_top.url} (grade ${r.expect_top.grade}) — NOT in top-10`)
    console.log(`    actual: ${r.actual_top}`)
  }

  // By-intent rollup so the maintainer knows which intent has the largest
  // grade-0 tail to attack.
  const byIntent: Record<string, number> = {}
  for (const r of grade0) byIntent[r.intent] = (byIntent[r.intent] ?? 0) + 1
  console.log()
  console.log("=== By intent ===")
  for (const [k, v] of Object.entries(byIntent).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(15)} ${v}`)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
