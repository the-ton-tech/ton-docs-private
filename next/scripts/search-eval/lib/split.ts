/**
 * Deterministic train/test split. The whole point of the bigger mined eval
 * set is to detect tuning that overfits the 126 hand queries — so the split
 * must (a) be reproducible (a fixed hash, never Math.random) and (b) keep
 * every query that targets the same page on the SAME side. A page's
 * title-query and a typo of that title leaking across the split would let a
 * config "generalize" by memorizing the page, defeating the purpose.
 */

export interface EvalQuery {
  q: string
  intent: string
  expect: string[]
}

// FNV-1a — small, stable, dependency-free. Used only to bucket strings.
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Assign each query to "train" or "test" by hashing the JOINED sorted expect
 * URLs (a query's target page-set), so all queries for one page co-locate.
 * `testFraction` of the page-sets land in test. Deterministic for a given
 * `seed`.
 */
export function splitByTarget(
  queries: EvalQuery[],
  testFraction = 0.5,
  seed = "v1",
): {train: EvalQuery[]; test: EvalQuery[]} {
  const train: EvalQuery[] = []
  const test: EvalQuery[] = []
  const threshold = Math.round(testFraction * 1000)
  for (const query of queries) {
    const key = [...query.expect].sort().join("|") + "::" + seed
    if (fnv1a(key) % 1000 < threshold) test.push(query)
    else train.push(query)
  }
  return {train, test}
}
