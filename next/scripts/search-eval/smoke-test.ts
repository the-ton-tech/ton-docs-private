/**
 * Phase 1 smoke test. No LLM calls — just verifies every harness lib loads,
 * the corpus parses, the prompt builders produce reasonable strings, the
 * graded metrics and inter-rater functions return sensible values on
 * hand-crafted inputs. If this is green, the orchestrator surface is sound
 * and Phase 2 can launch.
 *
 * Usage (from next/):
 *   npx tsx scripts/search-eval/smoke-test.ts
 */
import {
  gradedScoreQuery,
  krippendorffAlphaOrdinal,
  medianAcrossRaters,
  objective,
} from "./lib/metrics"
import {loadAllPages, urlToFilename} from "./lib/pages"
import {haikuGenerationPrompt, opusGradedRankingPrompt} from "./lib/llm-prompts"
import {haikuOutputSchema, opusRankingOutputSchema} from "./lib/llm-types"

let fails = 0
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    fails += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

console.log("=== corpus loader ===")
const pages = loadAllPages()
check("loaded ≥ 400 pages", pages.length >= 400, `got ${pages.length}`)
const sample = pages.find(p => p.url === "/blockchain-basics/standard/tokens/jettons/overview")
check("jettons/overview is present", !!sample)
if (sample) {
  check("title non-empty", sample.title.length > 0)
  check("source_file is absolute", sample.source_file.startsWith("/"))
  check("breadcrumbs derived", sample.breadcrumbs.length >= 3)
}

console.log("\n=== prompt builders ===")
if (sample) {
  const p = haikuGenerationPrompt(sample, "/tmp/test.json")
  check("haiku prompt mentions source_file", p.includes(sample.source_file))
  check("haiku prompt mentions output path", p.includes("/tmp/test.json"))
  check("haiku prompt has all personas", p.includes("novice") && p.includes("expert"))
  check("haiku prompt has CORRECTNESS CONTRACT", p.includes("CORRECTNESS CONTRACT"))
  check("haiku prompt ≥ 1500 chars", p.length >= 1500, `got ${p.length}`)

  const r = opusGradedRankingPrompt(
    "jetton transfer",
    1,
    [
      {
        url: "/a",
        title: "A",
        breadcrumbs: ["x"],
        description: "",
        source_file: "/tmp/a.mdx",
      },
      {
        url: "/b",
        title: "B",
        breadcrumbs: ["y"],
        description: "",
        source_file: "/tmp/b.mdx",
      },
    ],
    "/tmp/rate.json",
    0,
  )
  check("opus prompt has CALIBRATION ANCHORS", r.includes("CALIBRATION ANCHORS"))
  check("opus prompt mentions both urls", r.includes("/a") && r.includes("/b"))
}

console.log("\n=== zod schema sanity ===")
const goodHaiku = {
  page_url: "/foo",
  source_file: "/abs/foo.mdx",
  queries: Array(10).fill({
    q: "hello world",
    intent: "concept",
    persona: "novice",
    length: "medium",
    rationale: "this page covers hello world topics",
  }),
}
check("good haiku output validates", haikuOutputSchema.safeParse(goodHaiku).success)
check(
  "bad haiku output rejected",
  !haikuOutputSchema.safeParse({...goodHaiku, queries: [{q: "x"}]}).success,
)
const goodOpus = {
  query: "test",
  session_id: 1,
  ratings: [{url: "/a", grade: 3, reason: "perfect"}],
  best_url: "/a",
  ambiguity_note: "unambiguous",
}
check("good opus output validates", opusRankingOutputSchema.safeParse(goodOpus).success)
check(
  "bad opus output rejected",
  !opusRankingOutputSchema.safeParse({...goodOpus, ratings: [{url: "/a", grade: 5}]}).success,
)

console.log("\n=== graded metrics ===")
const expectMixed = [
  {url: "/perfect", grade: 3},
  {url: "/good", grade: 2},
  {url: "/partial", grade: 1},
]
const idealRanks = ["/perfect", "/good", "/partial"]
const idealScore = gradedScoreQuery(idealRanks, expectMixed)
check("ideal nDCG = 1", Math.abs(idealScore.gNdcg10 - 1) < 1e-9, `got ${idealScore.gNdcg10}`)
check("gradeAt1 = 3 for perfect first", idealScore.gradeAt1 === 3)
check("ERR@10 > 0", idealScore.err10 > 0)

const swappedScore = gradedScoreQuery(
  ["/good", "/perfect", "/partial"],
  expectMixed,
)
check(
  "swapping perfect/good drops nDCG",
  swappedScore.gNdcg10 < idealScore.gNdcg10,
  `${swappedScore.gNdcg10} >= ${idealScore.gNdcg10}`,
)
check(
  "binary Hit@1 stays 1 (good is grade ≥2)",
  swappedScore.hit1 === 1,
  "binary projection should treat grade≥2 as relevant",
)

console.log("\n=== inter-rater (Krippendorff α) ===")
const perfectAgree = [
  [3, 3, 3],
  [0, 0, 0],
  [2, 2, 2],
]
check("α = 1 on perfect agreement", Math.abs(krippendorffAlphaOrdinal(perfectAgree) - 1) < 1e-9)

const totalDisagree = [
  [0, 3, 0],
  [3, 0, 3],
]
const aDis = krippendorffAlphaOrdinal(totalDisagree)
check("α < 0.5 on heavy disagreement", aDis < 0.5, `got ${aDis}`)

const medians = medianAcrossRaters([
  [1, 3, 3],
  [0, 0, 1],
  [2, 2, 3],
])
check("median picks per-unit middle", medians[0] === 3 && medians[1] === 0 && medians[2] === 2)

console.log("\n=== objective sanity ===")
check(
  "objective ∈ [0,1]",
  objective({
    n: 1,
    hit1: 1,
    hit5: 1,
    cov10: 1,
    mrr: 1,
    ndcg10: 1,
    recall10: 1,
    precision10: 1,
    map: 1,
  }) === 1,
)

console.log("\n=== filesystem helpers ===")
check("urlToFilename safe", /^[a-zA-Z0-9._-]+$/.test(urlToFilename("/applications/ton-connect/overview")))

console.log(`\n${fails === 0 ? "✓ smoke green" : `✗ ${fails} check(s) failed`}`)
process.exit(fails === 0 ? 0 : 1)
