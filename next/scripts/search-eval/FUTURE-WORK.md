# Future work — search relevance harness

Captured at the end of the LLM-augmented eval round. Concrete, sized,
ordered by ROI / dependency. Things that need to happen first are at the
top; speculative items toward the bottom.

## 1. ~~Finish what Opus 529 interrupted~~ ✅ DONE (expanded to n=1049)

**Phase 5 is complete and expanded:** 3150/3150 Opus ratings landed
across the full 1050-query stratified sample (150 queries × 7 intents
× 3 sessions). The waves-of-6 dispatch pattern worked cleanly through
16 waves. 1049 queries kept after α ≥ 0.5 gate (1 dropped); median
α = 1.000, p10 = 0.965 — exceptional 3-session agreement preserved at
3× scale.

**Tuned vs baseline on n=1049 (graded):**

| metric         | baseline | tuned   | Δ        | p        |
| -------------- | -------- | ------- | -------- | -------- |
| Hit@1 (binary) | 0.5214   | 0.5443  | +0.0229  |          |
| MRR            | 0.5770   | 0.5975  | +0.0206  | 0.0005 ▲ |
| nDCG-graded@10 | 0.5068   | 0.5214  | +0.0146  | 0.0012 ▲ |
| ERR@10         | 0.4702   | 0.4834  | +0.0132  | 0.0049 ▲ |
| grade@1 mean   | 1.6072   | 1.6520  | +0.0448  | 0.0183 ▲ |

All 4 graded metrics significantly improve. The 3× expansion from
n=349 sharpens nDCG_g@10 from p=0.081 → **p=0.0012**, confirming the
tuning is decisive on both first-place outcomes _and_ the tail
distribution — not a noise artifact of small samples.

## 2. Targeted fixes from Phase 7's per-intent diagnostic

Gold-slice graded nDCG@10 by intent (DEFAULT_TUNING with codeSymbolWeight=1,
n=1049 — full slice, 150 queries per intent):

| intent          | nDCG_g@10 | mean grade@1 |
| --------------- | --------- | ------------ |
| navigational    | 0.742     | 2.51         |
| exact           | 0.574     | 1.79         |
| synonym         | 0.488     | 1.55         |
| concept         | 0.485     | 1.47         |
| troubleshooting | 0.477     | 1.50         |
| typo            | 0.468     | 1.43         |
| **identifier**  | **0.415** | **1.32**     |

The 3× expansion (n=349 → n=1049) flipped the diagnostic. At n=349
`synonym` looked like the weakest intent (0.424); at n=1049 it lifted
to 0.488 — that earlier ranking was **noise from a ±0.14 95% CI** on
the per-intent estimate. The actual remaining weak intent is
**`identifier` (0.415)** — the shape-conditional code-symbol bonus
helped but didn't close the gap to other intents. `concept` regressed
vs baseline at n=349 (-0.024) but at n=1049 the gap is smaller
(-0.011) — likely the BM25 blend slightly overweighting term-density
on broad conceptual queries; worth a targeted ablation.

Hypotheses worth measuring on the held-out + gold:

- **Stem-aware title bonus.** `runRankedSearch` re-rank does
  `title.includes(t)` with unstemmed tokens; the index is stemmed. For
  query "validating" → token "validating" → title "Validation" misses
  the substring but Orama's stemmed index hits it. Fix candidates:
  (a) stem the re-rank tokens too, (b) tokenize the title to words and
  do word-equality (not substring) against stemmed tokens.
- **Boost titles as a synthetic field at search time.** Currently only
  `properties: ["content"]` is searched. Title is *inside* content as a
  type=`page` row — but at index time fumadocs flattens. A
  prepend/duplicate trick at search time (do a second Orama pass on a
  title-only query variant and union) could surface exact-title matches
  more reliably without rebuilding the index.
- **Audit gold-slice `exact` queries for label noise.** Spot-check 20
  random exact-intent gold entries by hand; if the Sonnet-validated
  `expect[]` is wrong on a meaningful fraction, the diagnostic is
  partially a label problem, not a search problem. Easy to do with
  `gold-evalset.json` + the URL list.

**`concept` / `troubleshooting`** are mid; both suffer from sparse
`keywords:` frontmatter (only 6 pages). Cheapest gain: add `keywords:`
to the top-50 most-searched concept pages (any heuristic — page-view
proxy: by-depth-in-nav, or by-incoming-internal-links).

## 3. ~~Graded-objective sweep~~ ✅ DONE (shipped — current tuning is Pareto-optimal)

`scripts/search-eval/sweep-graded.ts` (npm: `search:sweep:graded`)
implements coordinate ascent on
`0.4 * nDCG_g@10 + 0.4 * Hit@1 + 0.2 * ERR@10`
over a page-stratified split of the gold slice (n=1049 → roughly
~500 train / ~550 test) with the curated set as a regression guardrail.

**Result of running it on DEFAULT_TUNING:** sweep finds a "best" config
on gold-train that fails to generalize to gold-test (test obj drops vs
DEFAULT, both Hit@1 and nDCG_g deltas are negative on held-out). The
sweep's accept gate (significant gain on gold-test + no curated
regression) correctly REJECTS the local optimum. Current DEFAULT is at
the Pareto knee for this corpus. Re-validation at n=1049 confirms the
finding (see §1) — the tuning is stable, not a small-sample artifact.

Useful in future rounds when corpus changes (new pages, new keywords,
plugin swap) — re-run to confirm the existing tuning is still optimal.

## 4. Untested levers worth measuring

### Index-side (require rebuild)

- ~~**`allowDuplicates: true` in the tokenizer**~~ ❌ measured-negative.
  Default `false` caps term-frequency at 1/field, flattening BM25's tf
  component. Hypothesis was that restoring real tf would help; **on
  full apples-to-apples measurement (both indexes built, same harness):**

  | slice      | metric   | nodups | allowdups | Δ        |
  | ---------- | -------- | ------ | --------- | -------- |
  | curated    | hit@1    | 0.9206 | 0.9127    | -0.0079  |
  | curated    | mrr      | 0.9389 | 0.9311    | -0.0078  |
  | mined-train| hit@1    | 0.7632 | 0.7647    | +0.0015  |
  | mined-test | hit@1    | 0.8132 | 0.8104    | -0.0028  |
  | gold       | hit@1    | 0.5301 | 0.5244    | -0.0057  |
  | gold       | grade@1  | 1.5845 | 1.5702    | -0.0143  |

  Strongest signal (curated, hand-verified) regresses. Hypothesis:
  with the calibrated BM25 blend already extracting tf information from
  curated keyword and code-symbol rows, the additional tf from
  duplicates over-weights long term-dense pages — the same mechanism the
  BM25 blend was designed to mitigate.
- **Custom multi-field schema, bypassing `createFromSource`.** Real
  separate title / headings / keywords / body fields with per-field
  `boost` at query time. Highest ceiling per Orama's own design intent.
  Cost: custom save/load + client tokenizer changes. Defer until the
  simpler levers plateau.

### Client-side (no rebuild — A/B-tested)

- ~~**`@orama/plugin-qps`** — proximity-first ranking.~~ ❌ measured-mixed.
  A/B-tested against the shipped pipeline (both indexes built, same
  harness). Tradeoff on gold:

  | intent          | nDCG_g (no-QPS) | nDCG_g (QPS) | Δ        |
  | --------------- | --------------- | ------------ | -------- |
  | synonym         | 0.424           | 0.481        | **+0.057** |
  | identifier      | 0.427           | 0.485        | **+0.058** |
  | exact           | 0.537           | 0.559        | +0.022   |
  | troubleshooting | 0.520           | 0.527        | +0.007   |
  | navigational    | 0.717           | 0.710        | -0.007   |
  | concept         | 0.473           | 0.449        | -0.024   |
  | typo            | 0.496           | 0.470        | -0.026   |

  QPS dramatically helps the vocabulary-matching intents (synonym /
  identifier) but regresses prose-density and fuzzy intents. Critically,
  **mined-test regresses across the board** (-1.0 to -1.3% on hit@1 / mrr
  / nDCG@10) — failing the "must not regress held-out mined-test"
  acceptance criterion. Reverted; the synonym / identifier gains
  motivate exploring a hybrid (per-intent routing or QPS as an additive
  signal blended with BM25) in a future round.

  Index size dropped 47.8 → 44.1 MB (-7.7%) with QPS — a side benefit
  worth remembering if a future approach captures the synonym wins
  without the mined-test cost.

- **`@orama/plugin-pt15`** — token-position ranker, lighter than QPS.
  Not yet A/B-tested. May exhibit a similar tradeoff to QPS.

## 5. Hard-cases backlog (46 verified failures)

`hard-cases.json` is a diagnostic catalog, not an eval slice. Each
entry has a `failure_category` and a `hypothesis` referencing concrete
pipeline mechanisms. By category (counts):

| category             | n   | typical fix                                                              |
| -------------------- | --- | ------------------------------------------------------------------------ |
| `identifier_miss`    | 15  | extend `extractCodeSymbols` patterns, or add a hand-curated symbol dict  |
| `synonym_gap`        | 6   | candidates for new `keywords:` frontmatter on the right page             |
| `pin_missing`        | 6   | candidates for `DEFAULT_PINS` additions — measure each before adding     |
| `title_ambiguity`    | 6   | "Overview" appearing 37 times; harder — needs context-aware disambig     |
| `stopword_strip`     | 6   | re-audit `DEFAULT_STOPWORDS` for over-stripping                          |
| `typo_beyond_2`      | 3   | additions to `DEFAULT_SPELL`                                             |
| `stem_collision`     | 2   | investigate Porter stem mistakes; one-off fixes via custom stemmer hook  |
| `bm25_length`        | 1   | already partially addressed by the BM25 blend ship                       |
| `exact_intent_drift` | 1   | overlaps the "exact" diagnostic above                                    |

Discipline: a fix earns its place only by **moving the gold slice**
(or curated, or held-out mined-test) measurably with no regression.
Don't bake a fix per `hard-case` row — those are inputs to hypotheses,
not specs.

## 6. Methodology improvements (higher-ROI than more tuning)

### Real user query logs

The biggest single upgrade available: replace the LLM surrogates with
ground-truth user demand. If Plausible / Algolia DocSearch / support
channel logs become available, that distribution beats any synthetic
set. Wire-up sketch: ingest into a fifth slice `real-evalset.jsonl`
(initially unlabeled — just queries with click-through), measure with
existing harness modulo label generation.

### Cross-family LLM agreement

Sonnet + Opus are the same model family (correlated priors). Adding a
different family (e.g. Gemini-2.5-Pro, GPT-5) as a third sanity-checker
on a 50-query gold subsample would test for systematic Anthropic-prior
bias. ~30-min of API spend; high diagnostic value.

### `report.ts` integration

Currently graded metrics live in a separate `report-graded.ts`. Merge
into the main report behind a `--full` flag so a single command
produces all 4 slices + graded metrics + per-intent breakdown.
Trivial; keeps the CLI surface tight.

### Determinism on the gold slice

`report-graded.ts --determinism` — 3× run, byte-compare. Same pattern
as the existing binary-slice determinism check.

### ~~CI integration~~ ✅ DONE

`.github/workflows/search-eval.yml` triggers on PRs that touch
`src/lib/search-core.ts`, `src/app/api/search/**`, `scripts/search-eval/**`,
or `content/docs/**`. Pipeline:

1. `npm run search:smoke` — 24-check infra (fails fast).
2. `npm run build` — produce `out/api/search`.
3. `npm run search:report` — binary 4-slice metrics + significance.
4. `npm run search:report:graded -- --vs-baseline` — graded gold slice
   (n=1049, α median 1.000).
5. `npm run search:eval` — legacy byte-compare ablation.

Currently the binary report is advisory (logs only); a future revision
should grep for `> 0.5% curated regression` in the output and fail.

### `report.ts` regression on gold

Add a per-query gold regression diff comparing baseline vs current ship:
which queries dropped from grade-3-at-1 to grade-2 or lower. Same
mechanism as the binary `regressions()` helper but for graded gain.

## 7. Search UX (separate axis from relevance)

`src/components/search.tsx` is a thin client wrapper around `runRankedSearch`.
Relevance-orthogonal UX improvements that surfaced during research but
were not implemented:

- **Did-you-mean.** When zero results have grade ≥ 2 (proxy: zero
  results with significant `s` value), show the spell-corrected query as
  a suggestion. Reuses `DEFAULT_SPELL`.
- **Idle prefetch + warm.** Currently the 46MB index loads lazily on
  first dialog open. Pre-fetch + `load()` on idle (after main-page
  interactive) eliminates the cold-start cost of the first search.
- **Snippet trimming.** The index stores 2000-char content blocks. UI
  currently shows the full matched block. Showing only the matched
  H2/H3 + nearest paragraph would shorten the result list and let users
  scan faster.

These need their own metric (click-through, time-to-first-click,
abandon rate) — not nDCG. Worth a dedicated round; orthogonal to this
harness.

## 8. Operational housekeeping

- The `llm-data/` per-task outputs (~5000 files total) are `.gitignore`'d
  and regenerable. Periodic prune on disk pressure.
- Sub-agent JSONL transcripts in `/tmp/claude-*/tasks/` are session-
  scoped and auto-clean on container reclaim.
- Phase 5 scaled to 1050 queries; gold-evalset regenerated at n=1049.
  Re-running `report-graded.ts --vs-baseline` is now the standard check
  on relevance changes — all four graded metrics significant at p≤0.02.
- The "leftover" `opus-rank/batches/batch_NNN.prompt.txt` files from the
  partial first run were cleaned manually; if the orchestrator is run
  more than once between batches, expect stale files (resumable design
  overwrites only as many batches as it needs).

## 9. Not worth doing

Documented for the next maintainer who'll be tempted:

- **`relevance.b` or `relevance.k` retuning.** Measured 5× — every
  off-default value is net-negative on held-out, in both directions. The
  defaults are right for this corpus.
- **Query-time synonym expansion.** Rejected twice. The
  Sonnet-validated `expand[]` data could in principle inform a precise
  variant, but the precedent is bad and the gains would be tiny.
- **`proximity` / `allTerms` bonuses.** Measured net-negative 5×;
  floats long reference pages over canonical short pages.
- **Embedding plugin (`@orama/plugin-embeddings`).** TF.js in-browser
  + ~1536 floats/doc inflates the 46MB static asset by 30–100MB. Not
  worth it for natural-language coverage we can get from the
  Sonnet/keywords path.

## 10. Order of operations (recommended, post-Phase-5)

1. ~~Finish Phase 5~~ ✅ done — full 1049-query gold slice, α median 1.000.
2. ~~`allowDuplicates: true` build experiment.~~ ❌ measured-negative
   on curated and gold (see §4). Not shipped; moved to "not worth doing".
3. **Spot-check synonym/identifier gold labels** (1 hour). The earlier
   exact-intent hypothesis turned out to be partial-data noise; redo
   on the new weak-spot intents.
4. **One targeted synonym/identifier fix attempt**. Identifier headroom
   suggests stem-aware title matching is still worth testing; synonym
   headroom hints at keyword-frontmatter coverage gaps.
5. **Investigate `concept` regression** (-0.024 vs baseline). Possible
   BM25 over-weighting on broad conceptual queries; try `bm25Weight=2`
   instead of 2.5 with paired test on gold + curated.
6. ~~Graded sweep~~ ✅ shipped (§3) — confirmed DEFAULT is Pareto-optimal.
7. ~~Plugin QPS / PT15 A/B~~ ❌ QPS A/B-tested; measured-mixed (big
   synonym/identifier wins on gold, mined-test regressed 1.0-1.3% —
   rejected). PT15 not yet tested.
8. ~~CI integration~~ ✅ shipped (`.github/workflows/search-eval.yml`).
9. **Real user logs ingest** if and when available — supersedes much
   of the above.
