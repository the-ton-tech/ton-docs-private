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
    return {n: 0, hit1: 0, hit5: 0, cov10: 0, mrr: 0, ndcg10: 0, recall10: 0, precision10: 0, map: 0}
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
