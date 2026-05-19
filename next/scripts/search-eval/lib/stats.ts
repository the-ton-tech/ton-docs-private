/**
 * Significance testing. With ~126 (or even ~500) queries a +0.01 metric
 * delta can be a single query flipping. Shipping on point estimates is how
 * the prior round's "obvious" wins turned out to be noise. Every
 * baseline→candidate comparison reports a bootstrap CI on the delta and a
 * paired permutation p-value, so we only keep changes that move the metric
 * beyond what reshuffling the same per-query outcomes could produce.
 */

// Deterministic PRNG (mulberry32) — significance numbers must be identical
// across runs or the harness undermines its own purpose.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface DeltaStat {
  meanA: number
  meanB: number
  delta: number
  ci95: [number, number]
  pValue: number
  significant: boolean
}

/**
 * Paired comparison of two variants over the SAME queries. `a`/`b` are
 * per-query metric values (e.g. each query's reciprocal rank) aligned by
 * index. Bootstrap resamples query indices for the delta CI; the permutation
 * test randomly swaps each query's (a,b) pair to build the null where the
 * variant label doesn't matter — the right null for a paired ranking change.
 */
export function pairedDelta(a: number[], b: number[], iters = 10000, seed = 0x5eed): DeltaStat {
  const n = a.length
  if (n === 0 || n !== b.length) throw new Error("pairedDelta: length mismatch / empty")
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  const meanA = mean(a)
  const meanB = mean(b)
  const observed = meanB - meanA
  const diffs = b.map((x, i) => x - a[i])

  const rng = mulberry32(seed)

  // Bootstrap CI for the paired delta.
  const boot: number[] = new Array(iters)
  for (let it = 0; it < iters; it++) {
    let s = 0
    for (let i = 0; i < n; i++) s += diffs[(rng() * n) | 0]
    boot[it] = s / n
  }
  boot.sort((x, y) => x - y)
  const lo = boot[Math.floor(0.025 * iters)]
  const hi = boot[Math.floor(0.975 * iters)]

  // Two-sided paired permutation (sign-flip) test.
  let extreme = 0
  const absObs = Math.abs(observed)
  for (let it = 0; it < iters; it++) {
    let s = 0
    for (let i = 0; i < n; i++) s += rng() < 0.5 ? diffs[i] : -diffs[i]
    if (Math.abs(s / n) >= absObs - 1e-12) extreme++
  }
  const pValue = (extreme + 1) / (iters + 1)

  return {
    meanA,
    meanB,
    delta: observed,
    ci95: [lo, hi],
    pValue,
    significant: pValue < 0.05,
  }
}

export function fmtDelta(name: string, d: DeltaStat): string {
  const s = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(4)
  const mark = d.significant ? (d.delta > 0 ? "▲ sig" : "▼ sig") : "· ns"
  return (
    `${name.padEnd(16)} ${d.meanA.toFixed(4)} → ${d.meanB.toFixed(4)}  ` +
    `Δ=${s(d.delta)}  95%CI[${s(d.ci95[0])},${s(d.ci95[1])}]  p=${d.pValue.toFixed(4)}  ${mark}`
  )
}
