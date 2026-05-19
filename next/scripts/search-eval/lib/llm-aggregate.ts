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
  haikuQuerySchema,
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
  // Lenient per-query validation: a Haiku batch occasionally emits one query
  // with a bad enum label (e.g. "explorer" used as intent instead of persona);
  // dropping just the bad query — not the whole file — recovers the other 9
  // valid candidates from those files. We do this by:
  //   1. Trying full file validation first (cheapest, covers 95%+ of files).
  //   2. On failure, parsing as { queries: unknown[], page_url: ... } and
  //      filtering queries individually with haikuQuerySchema.
  const files = jsonFilesIn(dir)
  const valid: CandidateRecord[] = []
  const errors: {file: string; error: string}[] = []
  for (const f of files) {
    const strict = readAndValidate(f, haikuOutputSchema)
    if (strict.ok) {
      for (const q of strict.value.queries) {
        valid.push({
          page_url: strict.value.page_url,
          q: q.q,
          intent: q.intent,
          persona: q.persona,
          length: q.length,
          rationale: q.rationale,
        })
      }
      continue
    }
    // Per-query fallback. Read raw, find queries[], validate each query.
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(f, "utf8"))
    } catch {
      errors.push({file: f, error: strict.error})
      continue
    }
    const obj = raw as {page_url?: unknown; queries?: unknown[]}
    if (typeof obj.page_url !== "string" || !Array.isArray(obj.queries)) {
      errors.push({file: f, error: strict.error})
      continue
    }
    const page_url = obj.page_url
    let kept = 0
    let dropped = 0
    for (const q of obj.queries) {
      const r = haikuQuerySchema.safeParse(q)
      if (r.success) {
        valid.push({page_url, q: r.data.q, intent: r.data.intent, persona: r.data.persona, length: r.data.length, rationale: r.data.rationale})
        kept += 1
      } else {
        dropped += 1
      }
    }
    if (kept === 0) errors.push({file: f, error: strict.error})
    else if (dropped > 0) {
      errors.push({file: f, error: `partial: ${dropped} of ${obj.queries.length} queries dropped (${strict.error})`})
    }
  }
  return {valid, errors, total: files.length}
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
