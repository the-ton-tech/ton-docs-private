/**
 * Phase 6 orchestrator: Opus adversarial red-team query generation.
 *
 * Independent of the calibration/ranking track. We give Opus the full
 * search-core.ts pipeline source + the corpus URL list and ask it to find
 * queries the pipeline will FAIL on. 3 sessions with rotating framings
 * (long-vs-short page tradeoffs, identifier lookup, NL paraphrase). After
 * each session, every proposed failure is EMPIRICALLY VERIFIED against the
 * running pipeline — claimed failures that actually rank in top-5 are
 * dropped (Opus mis-predicted). The surviving set is the hard-cases file.
 *
 * Usage (from next/, needs out/api/search):
 *   npx tsx scripts/search-eval/orchestrate-opus-redteam.ts             # prepare prompts
 *   npx tsx scripts/search-eval/orchestrate-opus-redteam.ts --aggregate # verify + write hard-cases.json
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {dirname, join, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {load, type AnyOrama, type RawData} from "@orama/orama"
import {
  DEFAULT_TUNING,
  createClientDB,
  runRankedSearch,
} from "../../src/lib/search-core"
import {opusRedTeamPrompt} from "./lib/llm-prompts"
import {loadAllPages} from "./lib/pages"
import {readAndValidate} from "./lib/llm-validate"
import {redTeamOutputSchema} from "./lib/llm-types"

const HERE = dirname(fileURLToPath(import.meta.url))
const LLM_DIR = resolve(HERE, "llm-data", "opus-redteam")
const PIPELINE_SRC = resolve(HERE, "..", "..", "src", "lib", "search-core.ts")
const INDEX_PATH = resolve(process.cwd(), process.env.INDEX ?? "out/api/search")
const HARD_OUT = resolve(HERE, "hard-cases.json")

const N_SESSIONS = 3

function sessionPath(n: number): {prompt: string; output: string} {
  const stem = join(LLM_DIR, `session_${String(n).padStart(2, "0")}`)
  return {prompt: stem + ".prompt.txt", output: stem + ".redteam.json"}
}

function loadIndex(): {db: AnyOrama; pageUrls: Set<string>} {
  const data = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as RawData
  const db = createClientDB()
  load(db, data)
  const urls = new Set<string>()
  const docs = (data as unknown as {docs: {docs: Record<string, {type: string; url: string}>}})
    .docs.docs
  for (const k of Object.keys(docs)) {
    const d = docs[k]
    if (d && d.type === "page") urls.add(d.url)
  }
  return {db, pageUrls: urls}
}

function prepare(): void {
  mkdirSync(LLM_DIR, {recursive: true})
  const pipeline = readFileSync(PIPELINE_SRC, "utf8")
  const corpus = loadAllPages().map(p => ({url: p.url, title: p.title}))
  let wrote = 0
  for (let s = 1; s <= N_SESSIONS; s++) {
    const {prompt, output} = sessionPath(s)
    if (existsSync(output)) continue
    writeFileSync(prompt, opusRedTeamPrompt(pipeline, corpus, s, output))
    wrote += 1
  }
  console.log(`wrote ${wrote} red-team prompts in ${LLM_DIR}`)
}

async function aggregateAndVerify(): Promise<void> {
  const {db, pageUrls} = loadIndex()
  type Case = {
    q: string
    intent: string
    should_rank_first: string
    failure_category: string
    hypothesis: string
    session_id: number
  }
  const proposed: Case[] = []
  for (let s = 1; s <= N_SESSIONS; s++) {
    const {output} = sessionPath(s)
    if (!existsSync(output)) continue
    const r = readAndValidate(output, redTeamOutputSchema)
    if (!r.ok) {
      console.log(`  ✗ ${output}: ${r.error}`)
      continue
    }
    for (const hc of r.value.hard_cases) {
      proposed.push({
        q: hc.q,
        intent: hc.intent,
        should_rank_first: hc.should_rank_first,
        failure_category: hc.failure_category,
        hypothesis: hc.hypothesis,
        session_id: r.value.session_id,
      })
    }
  }

  // EMPIRICAL VERIFICATION: a "failure" only counts if the shipped pipeline
  // actually fails to rank should_rank_first in the top 5. Opus mis-predicts
  // sometimes; those queries don't earn their place in hard-cases.
  const verified: (Case & {actual_first: string; actual_rank: number | null})[] = []
  let droppedUnknown = 0
  let droppedNotFailure = 0
  for (const c of proposed) {
    if (!pageUrls.has(c.should_rank_first)) {
      droppedUnknown += 1
      continue
    }
    const {results} = await runRankedSearch(db, c.q, DEFAULT_TUNING)
    const distinct = [...new Set(results.map(r => r.url))]
    const actualRank = distinct.indexOf(c.should_rank_first)
    const actualFirst = distinct[0] ?? "(none)"
    if (actualRank >= 0 && actualRank < 5) {
      droppedNotFailure += 1
      continue
    }
    verified.push({
      ...c,
      actual_first: actualFirst,
      actual_rank: actualRank >= 0 ? actualRank + 1 : null,
    })
  }

  // Dedupe by query text (Opus sessions sometimes overlap on findings;
  // we keep the first occurrence's metadata).
  const seen = new Set<string>()
  const deduped = verified.filter(v => {
    const k = v.q.trim().toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  const byCat: Record<string, number> = {}
  for (const v of deduped) byCat[v.failure_category] = (byCat[v.failure_category] ?? 0) + 1

  const out = {
    proposed_total: proposed.length,
    dropped_unknown_url: droppedUnknown,
    dropped_not_actually_failing: droppedNotFailure,
    verified_unique_cases: deduped.length,
    by_failure_category: byCat,
    cases: deduped,
  }
  writeFileSync(HARD_OUT, JSON.stringify(out, null, 2))
  console.log(`proposed: ${proposed.length}`)
  console.log(`dropped (URL not in corpus): ${droppedUnknown}`)
  console.log(`dropped (not a real failure on current ship): ${droppedNotFailure}`)
  console.log(`verified unique hard cases:  ${deduped.length}`)
  console.log("by failure category:", byCat)
  console.log(`hard-cases → ${HARD_OUT}`)
}

const args = new Set(process.argv.slice(2))
if (args.has("--aggregate")) await aggregateAndVerify()
else prepare()
