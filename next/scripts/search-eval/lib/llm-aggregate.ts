/**
 * Directory scanners that gather per-task sub-agent outputs into final eval
 * artifacts. Each LLM phase writes one JSON per task to its `llm-data/<phase>`
 * directory; these aggregators validate every file and produce the
 * consolidated set (or report which sub-agents need to be re-run).
 */
import {readFileSync, readdirSync} from "node:fs"
import {join} from "node:path"
import {readAndValidate, type ValidationResult} from "./llm-validate"
import {
  haikuOutputSchema,
  opusRankingOutputSchema,
  redTeamOutputSchema,
  sonnetOutputSchema,
  type CandidateRecord,
  type HaikuOutput,
  type OpusRankingOutput,
  type RedTeamCase,
  type SonnetOutput,
} from "./llm-types"

function jsonFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .map(f => join(dir, f))
      .sort()
  } catch {
    return []
  }
}

export interface AggregationSummary<T> {
  valid: T[]
  errors: {file: string; error: string}[]
  total: number
}

function aggregate<Raw, Out>(
  dir: string,
  schema: Parameters<typeof readAndValidate<Raw>>[1],
  flatten: (raw: Raw, file: string) => Out[],
): AggregationSummary<Out> {
  const files = jsonFilesIn(dir)
  const valid: Out[] = []
  const errors: {file: string; error: string}[] = []
  for (const f of files) {
    const r: ValidationResult<Raw> = readAndValidate(f, schema)
    if (r.ok) valid.push(...flatten(r.value, r.file))
    else errors.push({file: f, error: r.error})
  }
  return {valid, errors, total: files.length}
}

export function aggregateHaiku(dir: string): AggregationSummary<CandidateRecord> {
  return aggregate<HaikuOutput, CandidateRecord>(dir, haikuOutputSchema, raw =>
    raw.queries.map(q => ({
      page_url: raw.page_url,
      q: q.q,
      intent: q.intent,
      persona: q.persona,
      length: q.length,
      rationale: q.rationale,
    })),
  )
}

export interface ValidatedQuery {
  q: string
  expect: string[]
  category_path: string
  reason: string
  /** From Sonnet's verdict — useful for diagnostics. */
  verdict: "keep" | "expand" | "correct"
}

export function aggregateSonnet(dir: string): AggregationSummary<ValidatedQuery> & {
  drops: {q: string; category_path: string; reason: string}[]
  observations: {category_path: string; note: string}[]
} {
  const drops: {q: string; category_path: string; reason: string}[] = []
  const observations: {category_path: string; note: string}[] = []
  // We need access to the original candidate q for each verdict id; the
  // orchestrator script writes the candidate batch alongside the Sonnet
  // request so the aggregator can join. The candidate file is co-located
  // with the verdict file: <name>.verdict.json + <name>.candidates.json.
  const summary = aggregate<SonnetOutput, ValidatedQuery>(dir, sonnetOutputSchema, (raw, file) => {
    observations.push({category_path: raw.category_path, note: raw.category_observations})
    const candPath = file.replace(/\.verdict\.json$/, ".candidates.json")
    let cands: {id: number; q: string}[] = []
    try {
      cands = JSON.parse(readFileSync(candPath, "utf8")) as {id: number; q: string}[]
    } catch {
      // Sub-agent ran without the orchestrator's candidate file; skip join.
      return []
    }
    const qById = new Map(cands.map(c => [c.id, c.q]))
    const out: ValidatedQuery[] = []
    for (const v of raw.verdicts) {
      const q = qById.get(v.id)
      if (!q) continue
      if (v.verdict === "drop") {
        drops.push({q, category_path: raw.category_path, reason: v.reason})
        continue
      }
      if (v.expect.length === 0) continue
      out.push({
        q,
        expect: v.expect,
        category_path: raw.category_path,
        reason: v.reason,
        verdict: v.verdict,
      })
    }
    return out
  })
  return {...summary, drops, observations}
}

export function aggregateOpusRanking(
  dir: string,
): AggregationSummary<OpusRankingOutput> {
  return aggregate<OpusRankingOutput, OpusRankingOutput>(dir, opusRankingOutputSchema, raw => [
    raw,
  ])
}

export function aggregateRedTeam(dir: string): AggregationSummary<RedTeamCase> {
  return aggregate<{session_id: number; hard_cases: RedTeamCase[]}, RedTeamCase>(
    dir,
    redTeamOutputSchema,
    raw => raw.hard_cases,
  )
}
