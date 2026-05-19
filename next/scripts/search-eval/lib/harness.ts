/**
 * Shared evaluation engine. Loads the built Orama index ONCE into a single
 * read-only client DB (the production `createClientDB`, so the harness scores
 * the exact shipped pipeline) and replays a query set through
 * `runRankedSearch` for any `Tuning`. Everything downstream — ablation,
 * significance, the parameter sweep — calls `evaluate()`, so they all see
 * identical numbers for identical inputs.
 */
import {readFileSync} from "node:fs"
import {dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {load, type AnyOrama, type RawData} from "@orama/orama"
import {createClientDB, runRankedSearch, type Tuning} from "../../../src/lib/search-core"
import {aggregate, distinctPageRanks, scoreQuery, type Aggregate, type QueryScore} from "./metrics"
import type {EvalQuery} from "./split"

const HERE = dirname(fileURLToPath(import.meta.url))
export const INDEX_PATH = resolve(process.cwd(), process.env.INDEX ?? "out/api/search")
export const CURATED_PATH = resolve(HERE, "..", "evalset.json")
export const MINED_PATH = resolve(HERE, "..", "mined-evalset.json")

export interface LoadedIndex {
  db: AnyOrama
  pageUrls: Set<string>
}

export function loadIndex(): LoadedIndex {
  const data = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as RawData
  const db = createClientDB()
  load(db, data)
  const pageUrls = new Set<string>()
  const docs = (data as unknown as {docs: {docs: Record<string, {type: string; url: string}>}}).docs
    .docs
  for (const k of Object.keys(docs)) {
    const d = docs[k]
    if (d && d.type === "page") pageUrls.add(d.url)
  }
  return {db, pageUrls}
}

export function readEvalSet(path: string): EvalQuery[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {queries: EvalQuery[]}
  return parsed.queries
}

/**
 * Drop eval entries whose every `expect` URL is missing from the index, and
 * report them. The original harness hard-failed; for a large auto-mined set
 * we instead prune + surface a count so a handful of moved pages can't void
 * an entire generalization run (the curated set still hard-validates in
 * report.ts).
 */
export function pruneToIndex(
  queries: EvalQuery[],
  pageUrls: Set<string>,
): {kept: EvalQuery[]; dropped: EvalQuery[]} {
  const kept: EvalQuery[] = []
  const dropped: EvalQuery[] = []
  for (const q of queries) {
    const present = q.expect.filter(u => pageUrls.has(u))
    if (present.length > 0) kept.push({...q, expect: present})
    else dropped.push(q)
  }
  return {kept, dropped}
}

export interface PerQuery {
  q: string
  intent: string
  expect: string[]
  ranks: string[] // distinct page URLs, rank order, truncated
  score: QueryScore
}

export interface EvalResult {
  overall: Aggregate
  byIntent: Record<string, Aggregate>
  perQuery: PerQuery[]
}

const RANK_KEEP = 12

export async function evaluate(
  db: AnyOrama,
  queries: EvalQuery[],
  tuning: Tuning,
): Promise<EvalResult> {
  const perQuery: PerQuery[] = []
  const byIntentScores: Record<string, QueryScore[]> = {}
  const allScores: QueryScore[] = []

  for (const {q, intent, expect} of queries) {
    const {results} = await runRankedSearch(db, q, tuning)
    const ranks = distinctPageRanks(results)
    const score = scoreQuery(ranks, expect)
    allScores.push(score)
    ;(byIntentScores[intent] ??= []).push(score)
    perQuery.push({q, intent, expect, ranks: ranks.slice(0, RANK_KEEP), score})
  }

  const byIntent: Record<string, Aggregate> = {}
  for (const [k, v] of Object.entries(byIntentScores)) byIntent[k] = aggregate(v)
  return {overall: aggregate(allScores), byIntent, perQuery}
}

/** Per-query value of one metric, aligned to `queries` order — the input the
 * paired significance test consumes. */
export function metricVector(
  res: EvalResult,
  metric: "rr" | "ndcg10" | "hit1" | "cov10" | "ap" | "recall10",
): number[] {
  return res.perQuery.map(p => {
    const s = p.score
    return metric === "rr"
      ? s.rr
      : metric === "ndcg10"
        ? s.ndcg10
        : metric === "hit1"
          ? s.hit1
          : metric === "cov10"
            ? s.cov10
            : metric === "ap"
              ? s.ap
              : s.recall10
  })
}

/** Queries whose first-relevant rank strictly worsened from `base` to `cand`
 * (same query order assumed). Net-flat aggregates can still hide painful
 * individual regressions — report.ts surfaces these explicitly. */
export function regressions(
  base: EvalResult,
  cand: EvalResult,
): {q: string; intent: string; from: number; to: number}[] {
  const out: {q: string; intent: string; from: number; to: number}[] = []
  for (let i = 0; i < base.perQuery.length; i++) {
    const a = base.perQuery[i].score.firstHit
    const b = cand.perQuery[i].score.firstHit
    if (b > a) out.push({q: base.perQuery[i].q, intent: base.perQuery[i].intent, from: a, to: b})
  }
  return out.sort((x, y) => y.to - y.from - (x.to - x.from))
}
