/**
 * Phase 2 orchestrator: prepares Haiku per-page query-generation batches.
 *
 * Does NOT dispatch sub-agents itself (those are launched via the Agent tool
 * by the orchestrator session). What this does:
 *   1. Load all 471 pages from content/docs/.
 *   2. Group into batches of `BATCH_SIZE` pages.
 *   3. For each batch, write a single prompt file under
 *      llm-data/haiku/batches/batch_NN.prompt.txt — concatenated per-page
 *      Haiku prompts with separators. A sub-agent gets ONE batch.
 *   4. Compute per-page output paths under llm-data/haiku/<slug>.json.
 *   5. Report which batches still need to be dispatched (output files
 *      missing for ≥1 of their pages) — i.e. resumable.
 *
 * Usage (from next/):
 *   npx tsx scripts/search-eval/orchestrate-haiku.ts            # prepare batches
 *   npx tsx scripts/search-eval/orchestrate-haiku.ts --status   # show remaining
 *   npx tsx scripts/search-eval/orchestrate-haiku.ts --aggregate
 */
import {existsSync, mkdirSync, readdirSync, writeFileSync} from "node:fs"
import {dirname, join, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {aggregateHaiku} from "./lib/llm-aggregate"
import {haikuGenerationPrompt} from "./lib/llm-prompts"
import {loadAllPages, urlToFilename} from "./lib/pages"

const HERE = dirname(fileURLToPath(import.meta.url))
const LLM_DIR = resolve(HERE, "llm-data", "haiku")
const BATCH_DIR = join(LLM_DIR, "batches")
const FINAL_OUT = resolve(HERE, "llm-candidates.jsonl")

const BATCH_SIZE = 10
const TASK_SEPARATOR = "\n\n===== TASK BOUNDARY (read & execute each in order) =====\n\n"

interface PageTask {
  page_url: string
  output_path: string
  prompt: string
  done: boolean
}

function pageOutputPath(url: string): string {
  return join(LLM_DIR, `${urlToFilename(url)}.json`)
}

function buildTasks(): PageTask[] {
  const pages = loadAllPages()
  return pages.map(p => {
    const out = pageOutputPath(p.url)
    return {
      page_url: p.url,
      output_path: out,
      prompt: haikuGenerationPrompt(p, out),
      done: existsSync(out),
    }
  })
}

function prepare(): void {
  mkdirSync(LLM_DIR, {recursive: true})
  mkdirSync(BATCH_DIR, {recursive: true})

  const tasks = buildTasks()
  const totalDone = tasks.filter(t => t.done).length
  console.log(`pages: ${tasks.length}; already done: ${totalDone}`)

  const remaining = tasks.filter(t => !t.done)
  if (remaining.length === 0) {
    console.log("✓ all per-page outputs already present — nothing to dispatch")
    console.log("  run with --aggregate to build llm-candidates.jsonl")
    return
  }

  // Pack remaining tasks into batches and write each batch's prompt file.
  const batches: PageTask[][] = []
  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    batches.push(remaining.slice(i, i + BATCH_SIZE))
  }
  let wrote = 0
  for (let b = 0; b < batches.length; b++) {
    const file = join(BATCH_DIR, `batch_${String(b).padStart(3, "0")}.prompt.txt`)
    const header =
      `# Haiku batch ${b + 1}/${batches.length} — ${batches[b].length} page tasks\n` +
      `# Execute every task below in order. Each task starts after a separator.\n` +
      `# When all Write tool calls succeed, end your turn (no chat output).\n\n`
    const body = batches[b].map(t => t.prompt).join(TASK_SEPARATOR)
    writeFileSync(file, header + body)
    wrote += 1
  }
  console.log(`wrote ${wrote} batch prompt files → ${BATCH_DIR}`)
  console.log(`\nNext: orchestrator dispatches sub-agents. Each agent is told to`)
  console.log(`Read one batch_NNN.prompt.txt and execute its tasks (Read+Write).`)
  console.log(`Resumable: re-running this script skips pages whose .json output exists.`)
}

function status(): void {
  const tasks = buildTasks()
  const done = tasks.filter(t => t.done).length
  console.log(`completed: ${done} / ${tasks.length} (${((100 * done) / tasks.length).toFixed(1)}%)`)
  const batches = readdirSync(BATCH_DIR)
    .filter(f => f.endsWith(".prompt.txt"))
    .sort()
  console.log(`batch files present: ${batches.length}`)
}

function aggregate(): void {
  const res = aggregateHaiku(LLM_DIR)
  console.log(`per-page files validated: ${res.valid.length} candidates from ${res.total} files`)
  if (res.errors.length > 0) {
    console.log(`✗ ${res.errors.length} files failed validation:`)
    for (const e of res.errors.slice(0, 10)) {
      console.log(`  ${e.file}: ${e.error}`)
    }
  }
  if (res.valid.length === 0) {
    console.log("nothing to aggregate yet — run sub-agents first")
    return
  }
  const lines = res.valid.map(c => JSON.stringify(c)).join("\n") + "\n"
  writeFileSync(FINAL_OUT, lines)
  console.log(`wrote ${res.valid.length} candidate lines → ${FINAL_OUT}`)
  // Quick distribution summary
  const byIntent: Record<string, number> = {}
  const byPersona: Record<string, number> = {}
  for (const c of res.valid) {
    byIntent[c.intent] = (byIntent[c.intent] ?? 0) + 1
    byPersona[c.persona] = (byPersona[c.persona] ?? 0) + 1
  }
  console.log("by intent: ", byIntent)
  console.log("by persona:", byPersona)
}

const args = new Set(process.argv.slice(2))
if (args.has("--aggregate")) aggregate()
else if (args.has("--status")) status()
else prepare()
