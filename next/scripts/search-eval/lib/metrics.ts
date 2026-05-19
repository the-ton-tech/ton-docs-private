/**
 * Information-retrieval metrics, computed over the DISTINCT page URLs a user
 * actually sees (rank order, first occurrence wins). Relevance is binary: an
 * eval query carries one or more `expect` URLs and any of them counts as the
 * relevant result for that query (graded relevance is not available for this
 * corpus, so nDCG uses binary gain — still position-aware, unlike Hit@k).
 *
 * Why more than the original Hit@1/Hit@5/MRR: a docs-search change can win
 * one query and lose another and net flat on Hit@1 while clearly improving
 * (or degrading) the experience. nDCG@10 (position-weighted) and Recall@10
 * (did we surface it at all) catch movement Hit@1 hides, and the user asked
 * specifically for relevance AND precision, so Precision@k/MAP are reported.
 */

/** Distinct page URLs in first-seen rank order (what the dialog renders). */
export function distinctPageRanks(results: {url: string}[]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const r of results) {
    if (!seen.has(r.url)) {
      seen.add(r.url)
      order.push(r.url)
    }
  }
  return order
}

/** 1-based rank of the first relevant URL, or Infinity if none retrieved. */
export function firstRelevantRank(ranks: string[], expect: readonly string[]): number {
  const want = new Set(expect)
  for (let i = 0; i < ranks.length; i++) if (want.has(ranks[i])) return i + 1
  return Infinity
}

export interface QueryScore {
  /** 1-based rank of first relevant doc (Infinity if missed entirely). */
  firstHit: number
  hit1: number
  hit5: number
  cov10: number
  rr: number // reciprocal rank (MRR contribution)
  ndcg10: number
  recall10: number
  precision10: number
  ap: number // average precision (MAP contribution)
}

const LOG2 = Math.log(2)
function dcgAt(relevantHitPositions: number[], k: number): number {
  // Binary-gain DCG: every position holding a relevant doc contributes
  // 1/log2(rank+1). Standard (Burges) formulation with gain ∈ {0,1}.
  let dcg = 0
  for (const pos of relevantHitPositions) if (pos <= k) dcg += LOG2 / Math.log(pos + 1)
  return dcg
}

/**
 * Score one query's distinct-page ranking against its relevant set.
 * `numRelevantTotal` caps idealized recall/nDCG when the corpus genuinely
 * holds fewer relevant pages than `k` (here = |expect|, since the eval set
 * enumerates every acceptable target).
 */
export function scoreQuery(ranks: string[], expect: readonly string[]): QueryScore {
  const want = new Set(expect)
  const relevantPositions: number[] = []
  for (let i = 0; i < ranks.length; i++) if (want.has(ranks[i])) relevantPositions.push(i + 1)

  const firstHit = relevantPositions.length > 0 ? relevantPositions[0] : Infinity
  const R = Math.max(1, want.size)

  // Average precision over the (binary) relevant set, truncated at the
  // retrieved list — the per-query term of MAP.
  let hitsSoFar = 0
  let apSum = 0
  for (let i = 0; i < ranks.length; i++) {
    if (want.has(ranks[i])) {
      hitsSoFar += 1
      apSum += hitsSoFar / (i + 1)
    }
  }
  const ap = apSum / Math.min(R, Math.max(R, 1))

  const idcg = dcgAt(
    Array.from({length: Math.min(R, 10)}, (_, i) => i + 1),
    10,
  )
  const ndcg10 = idcg === 0 ? 0 : dcgAt(relevantPositions, 10) / idcg

  const relIn10 = relevantPositions.filter(p => p <= 10).length
  return {
    firstHit,
    hit1: firstHit === 1 ? 1 : 0,
    hit5: firstHit <= 5 ? 1 : 0,
    cov10: firstHit <= 10 ? 1 : 0,
    rr: firstHit === Infinity ? 0 : 1 / firstHit,
    ndcg10,
    recall10: relIn10 / R,
    precision10: relIn10 / 10,
    ap,
  }
}

export interface Aggregate {
  n: number
  hit1: number
  hit5: number
  cov10: number
  mrr: number
  ndcg10: number
  recall10: number
  precision10: number
  map: number
}

export function aggregate(scores: QueryScore[]): Aggregate {
  const n = scores.length
  const sum = (f: (s: QueryScore) => number) => scores.reduce((a, s) => a + f(s), 0)
  if (n === 0) {
    return {
      n: 0,
      hit1: 0,
      hit5: 0,
      cov10: 0,
      mrr: 0,
      ndcg10: 0,
      recall10: 0,
      precision10: 0,
      map: 0,
    }
  }
  return {
    n,
    hit1: sum(s => s.hit1) / n,
    hit5: sum(s => s.hit5) / n,
    cov10: sum(s => s.cov10) / n,
    mrr: sum(s => s.rr) / n,
    ndcg10: sum(s => s.ndcg10) / n,
    recall10: sum(s => s.recall10) / n,
    precision10: sum(s => s.precision10) / n,
    map: sum(s => s.ap) / n,
  }
}

/** The metric the sweep/optimizer maximizes. Hit@1 and MRR are the priority
 * for docs search (right page first); nDCG@10 guards against shuffling the
 * tail. This composite is monotone in all three and bounded [0,1]. */
export function objective(a: Aggregate): number {
  return 0.5 * a.hit1 + 0.3 * a.mrr + 0.2 * a.ndcg10
}

export function fmtAggregate(label: string, a: Aggregate): string {
  const p = (x: number) => x.toFixed(4)
  return (
    `${label.padEnd(24)} n=${String(a.n).padStart(3)}  ` +
    `hit@1=${p(a.hit1)}  hit@5=${p(a.hit5)}  cov@10=${p(a.cov10)}  ` +
    `mrr=${p(a.mrr)}  ndcg@10=${p(a.ndcg10)}  ` +
    `rec@10=${p(a.recall10)}  prec@10=${p(a.precision10)}  map=${p(a.map)}`
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Graded relevance (Phase 7 of the LLM-augmented harness). The gold slice
// will carry per-page grades 0–3 from multi-session Opus rankers; binary
// metrics above still apply (any grade ≥ 2 collapses to "relevant"), but
// graded nDCG / ERR resolve cases binary cannot — "perfect first vs.
// acceptable first when a perfect existed". Kept in the same module so the
// harness has one canonical scoring surface.
// ────────────────────────────────────────────────────────────────────────────

/** Maximum grade used by the gold slice. Burges/ERR formulas key off this so
 * raising the scale later is a single-point change. */
export const MAX_GRADE = 3

export type GradedExpect = readonly {url: string; grade: number}[]

export interface GradedQueryScore extends QueryScore {
  /** Burges-formula nDCG@10 with gain = 2^grade − 1, IDCG built from the
   * sorted-descending grades of the expect list. Distinguishes a grade-3
   * page at #1 from a grade-2 page at #1; binary nDCG cannot. */
  gNdcg10: number
  /** Expected Reciprocal Rank @10 (Chapelle et al.): cascade-user model
   * where a user stops at the first satisfying document. Higher = better. */
  err10: number
  /** Grade of the page at rank 1 (0 if no expect-listed page in retrieved
   * results). Useful "did we put the best page first?" lens. */
  gradeAt1: number
}

function dcgBurges(grades: number[], k: number): number {
  // Burges (2005): DCG = Σ (2^g_i − 1) / log2(i + 1). 0-graded positions
  // contribute zero so we can pass the full top-k including misses.
  let dcg = 0
  for (let i = 0; i < Math.min(grades.length, k); i++) {
    if (grades[i] > 0) dcg += (Math.pow(2, grades[i]) - 1) / Math.log2(i + 2)
  }
  return dcg
}

export function gradedScoreQuery(ranks: string[], expect: GradedExpect): GradedQueryScore {
  // Binary projection: grade ≥ 2 counts as relevant. Keeps Hit@1/MRR etc.
  // semantically consistent with the rest of the harness so a graded slice
  // can be reported alongside binary slices using identical metric names.
  const binaryExpect: string[] = []
  const gradeByUrl = new Map<string, number>()
  for (const e of expect) {
    gradeByUrl.set(e.url, e.grade)
    if (e.grade >= 2) binaryExpect.push(e.url)
  }
  const binary = scoreQuery(ranks, binaryExpect)

  const retrievedGrades = ranks.slice(0, 10).map(u => gradeByUrl.get(u) ?? 0)
  const idealGrades = [...gradeByUrl.values()].sort((a, b) => b - a).slice(0, 10)
  const idcg = dcgBurges(idealGrades, 10)
  const gNdcg10 = idcg === 0 ? 0 : dcgBurges(retrievedGrades, 10) / idcg

  // ERR with normalized gain R_i = (2^g − 1) / 2^MAX_GRADE.
  let err10 = 0
  let stopProb = 1
  const normGain = (g: number) => (Math.pow(2, g) - 1) / Math.pow(2, MAX_GRADE)
  for (let i = 0; i < Math.min(retrievedGrades.length, 10); i++) {
    const r = normGain(retrievedGrades[i])
    err10 += (stopProb * r) / (i + 1)
    stopProb *= 1 - r
  }

  return {...binary, gNdcg10, err10, gradeAt1: retrievedGrades[0] ?? 0}
}

/**
 * Krippendorff's α for ordinal ratings (3+ raters, possibly missing).
 * `ratings` is a matrix indexed [unit][rater] (NaN = missing). Returns α in
 * (−∞, 1]: 1 = perfect agreement, 0 = no better than random, < 0 = worse than
 * random. The Phase 5 protocol drops queries with α < 0.5, sends 0.5–0.7 to a
 * tiebreaker session. Uses the squared-difference distance metric (canonical
 * for ordinal data per Krippendorff 2004).
 */
export function krippendorffAlphaOrdinal(ratings: readonly (readonly number[])[]): number {
  // Flatten valid (unit, value) pairs to compute the value-by-value coincidence
  // matrix, then the standard formula α = 1 − D_o / D_e.
  const allValues: number[] = []
  for (const unit of ratings) {
    for (const v of unit) if (Number.isFinite(v)) allValues.push(v)
  }
  if (allValues.length < 2) return Number.NaN

  // Observed disagreement: average squared diff over all ordered rater pairs
  // within each unit, weighted by 1 / (n_unit − 1) per Krippendorff.
  let nPairsInUnit = 0
  let sumSqInUnit = 0
  for (const unit of ratings) {
    const vals = unit.filter(Number.isFinite)
    if (vals.length < 2) continue
    for (let i = 0; i < vals.length; i++) {
      for (let j = 0; j < vals.length; j++) {
        if (i === j) continue
        sumSqInUnit += Math.pow(vals[i] - vals[j], 2) / (vals.length - 1)
        nPairsInUnit += 1 / (vals.length - 1)
      }
    }
  }
  const Do = nPairsInUnit === 0 ? 0 : sumSqInUnit / nPairsInUnit

  // Expected disagreement: average squared diff over all ordered pairs in the
  // global value distribution (independence baseline).
  let sumSqGlobal = 0
  let nPairsGlobal = 0
  for (let i = 0; i < allValues.length; i++) {
    for (let j = 0; j < allValues.length; j++) {
      if (i === j) continue
      sumSqGlobal += Math.pow(allValues[i] - allValues[j], 2)
      nPairsGlobal += 1
    }
  }
  const De = nPairsGlobal === 0 ? 0 : sumSqGlobal / nPairsGlobal

  return De === 0 ? 1 : 1 - Do / De
}

/** Per-unit median over rater values, ignoring NaN. Used to collapse the
 * Phase 5 multi-session matrix into the final grade. Median is more robust
 * to a single outlier session than mean for ordinal data. */
export function medianAcrossRaters(perUnit: readonly (readonly number[])[]): number[] {
  return perUnit.map(unit => {
    const sorted = unit.filter(Number.isFinite).slice().sort((a, b) => a - b)
    if (sorted.length === 0) return Number.NaN
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  })
}
