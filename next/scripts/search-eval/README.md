# Search relevance eval harness

Offline harness that scores the **exact** production search pipeline
(`src/lib/search-core.ts`) against a grounded query set, so every relevance
change is measured and ablated instead of guessed.

This corpus punishes intuition: the prior tuning round measured semantic
synonym expansion, `threshold:0`, and `tolerance:2` as **regressions** despite
all three being "obvious" wins. Nothing ships without a number here.

## Run

```bash
# from next/
npx tsx scripts/search-eval/run.ts            # baseline vs tuned + full ablation
npx tsx scripts/search-eval/run.ts --quick    # baseline vs tuned only
npx tsx scripts/search-eval/run.ts --determinism   # 3x identical check
INDEX=out/api/search npx tsx scripts/search-eval/run.ts
```

Requires a built index at `out/api/search` (`npm run build`). Query-side
levers (stopwords, pins, spell, structHit) need no rebuild; index-side levers
(code symbols, `keywords` frontmatter) require `npm run build` because the
fumadocs index is produced by the webpack build.

## Pieces

- `evalset.json` — 126 queries across 7 intents (navigational, exact, concept,
  multiword, identifier, typo, synonym), each mapped to known-correct
  target URL(s). `run.ts` **fails loudly** if any expected or pin URL is
  missing from the index, so the set can't silently rot when content moves.
- `run.ts` — loads the index once, runs `runRankedSearch` per query for every
  tuning variant (read-only, so one shared DB), reports Coverage@10 / Hit@1 /
  Hit@5 / MRR overall and per intent, plus residual fails.

Metrics are over **distinct pages in rank order** (what a user sees). Hit@1 /
MRR are the priority metrics for docs search — getting the right page first
matters more than raw top-10 coverage.

## Validated result (126-query set)

Baseline = previously shipped pipeline on the pre-tuning index.
Tuned = `DEFAULT_TUNING` + code-symbol/keyword indexing.

| metric | baseline | tuned |
|---|---|---|
| Coverage@10 | 0.849 | **0.984** |
| Hit@1 | 0.754 | **0.921** |
| Hit@5 | 0.825 | **0.968** |
| MRR | 0.784 | **0.939** |
| fails | 19 | **2** |

Per-intent Coverage@10 (tuned): concept 1.00, exact 1.00, identifier 0.89,
multiword 1.00, navigational 1.00, synonym 1.00, typo 1.00.

### Lever verdicts (ablated)

| lever | verdict | evidence |
|---|---|---|
| domain-aware stopwords | **keep** | identifier 0.83→0.89, no regression |
| best-bet pins | **keep** | navigational 0.61→1.00, hit@1 +; also fire on spell-corrected query |
| spell (always-union) | **keep** | typo 0.75→1.00; original low-recall gate never fired (mis-ranking, not recall) |
| code-symbol + keyword indexing | **keep** | synonym 0.79→1.00, identifier +; index +2.5% |
| structHit (keyword rows only) | **keep** | synonym +, hit@1 +; **code-symbol rows excluded** — measured too noisy for NL queries (wrecked concept 1.00→0.88) |
| proximity / all-terms bonus | **reject** | nets −hit@1/−MRR (floats long reference pages over canonical); measured 5× |

Residual 2 fails are code-only-symbol cases (`OP_SENDMSG` on an interactive
component page; `loadUint` genericized across Tolk). Accepted — chasing them
risks the overfitting this harness exists to prevent.
