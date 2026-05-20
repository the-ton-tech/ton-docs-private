# Future work — search relevance harness

Captured at the end of the LLM-augmented eval round. Concrete, sized,
ordered by ROI / dependency. Things that need to happen first are at the
top; speculative items toward the bottom.

## 1. ~~Finish what Opus 529 interrupted~~ ✅ DONE

**Phase 5 is complete:** 1050/1050 Opus ratings landed across the full
350-query stratified sample (50 queries × 7 intents). The waves-of-6
dispatch pattern worked cleanly. 349 queries kept after α ≥ 0.5 gate
(1 dropped); median α = 1.000, p10 = 0.964 — exceptional 3-session
agreement.

**Tuned vs baseline on n=349 (graded):**

| metric         | baseline | tuned   | Δ        | p       |
| -------------- | -------- | ------- | -------- | ------- |
| Hit@1 (binary) | 0.5014   | 0.5301  | +0.0287  |         |
| MRR            | 0.5587   | 0.5846  | +0.0258  | 0.008 ▲ |
| nDCG-graded@10 | 0.4982   | 0.5112  | +0.0129  | 0.102   |
| ERR@10         | 0.4506   | 0.4656  | +0.0149  | 0.043 ▲ |
| grade@1 mean   | 1.52     | 1.58    | +0.0630  | 0.030 ▲ |

3 of 4 graded metrics significantly improved; nDCG_g is directional but
not significant on n=349. The graded sweep (§3) is now feasible.

**Optional further scaling:** if more headroom is wanted, scale to
~3000 ratings (1 per validated query × 3 sessions across the full
Sonnet-validated set). At that size, per-intent significance becomes
powered. Not strictly necessary — 349 is enough to drive the next
round of tuning.

## 2. Targeted fixes from Phase 7's per-intent diagnostic

Gold-slice graded nDCG@10 by intent (DEFAULT_TUNING, n=349 — full slice):

| intent          | nDCG_g@10 | mean grade@1 |
| --------------- | --------- | ------------ |
| navigational    | 0.718     | 2.46         |
| exact           | 0.542     | 1.56         |
| troubleshooting | 0.517     | 1.61         |
| typo            | 0.493     | 1.38         |
| concept         | 0.476     | 1.46         |
| **synonym**     | **0.424** | **1.30**     |
| **identifier**  | **0.408** | **1.32**     |

The partial-data analysis (n=112) flagged `exact` as the weak spot at
0.31 — that finding was **noise from the small sample**. On the full
349-query slice `exact` is at 0.542, mid-pack. The actual weak intents
are **`synonym` (0.424)** and **`identifier` (0.408)**, both below 0.43.
**`concept` regressed** vs baseline (-0.024) on the full slice — likely
the BM25 blend overweighting term-density on broad conceptual queries;
worth a targeted ablation.

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

## 3. Graded-objective sweep (NOW unblocked — gold has 349 queries)

`sweep.ts` currently optimizes the *binary* objective on `mined-train`.
With 349 gold queries (median α 1.000) the graded sweep is now feasible —
add a sibling `sweep-graded.ts`:

- Page-stratified split of the gold slice into `gold-train` / `gold-test`.
- Objective: `0.4 * nDCG_g@10 + 0.4 * Hit@1 + 0.2 * ERR@10`.
- Same coordinate-ascent pattern; same guardrails (must not significantly
  regress curated, must significantly improve `gold-test`).
- Consider per-intent reporting so `synonym` / `identifier` headroom is
  attributable rather than averaged out.

This is the highest-resolution tuning surface we'll have on this corpus.

## 4. Untested levers worth measuring

### Index-side (require rebuild)

- **`allowDuplicates: true` in the tokenizer**
  ([route.ts](../../src/app/api/search/route.ts)). Default `false` caps
  term-frequency at 1/field, flattening BM25's tf component. With the
  BM25 blend now active in ranking, restoring real tf is the most
  promising untried lever. Cost: one `next build`. Measure on all 4
  slices.
- **Custom multi-field schema, bypassing `createFromSource`.** Real
  separate title / headings / keywords / body fields with per-field
  `boost` at query time. Highest ceiling per Orama's own design intent.
  Cost: custom save/load + client tokenizer changes. Defer until the
  simpler levers plateau.

### Client-side (no rebuild)

- **`@orama/plugin-qps`** — proximity-first ranking. Drop-in via
  `getComponents()`; serializable; still honors per-prop `boost`. Strong
  candidate when phrase-like queries dominate the gold slice.
- **`@orama/plugin-pt15`** — token-position ranker, lighter than QPS.
  A/B comparable.

Both add to `package.json` but stay client-side; no backend.

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

### CI integration

Add a CI job (e.g. `.github/workflows/search-eval.yml`) that runs on
PRs touching `src/lib/search-core.ts`, `src/app/api/search/route.ts`,
or `content/docs/**`:

1. `npm run search:smoke` (24-check infra)
2. `npm run build` (so out/api/search is present)
3. `npm run search:report --quick` — fail if curated metric regresses
4. `npm run search:eval` (legacy ablation, byte-compares)

The graded report stays out of CI for now (gold slice still partial).

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
- After Phase 5 scales to 350: regenerate `gold-evalset.json`, re-run
  `report-graded.ts --vs-baseline`, update the README's gold-slice
  table with the final numbers.
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

1. ~~Finish Phase 5~~ ✅ done — full 349-query gold slice, α median 1.000.
2. **`allowDuplicates: true` build experiment.** Single rebuild, all
   4 slices, both binary and graded. Either ship or document as
   measured-negative. **Now the highest-ROI untried lever.**
3. **Spot-check synonym/identifier gold labels** (1 hour). The earlier
   exact-intent hypothesis turned out to be partial-data noise; redo
   on the new weak-spot intents.
4. **One targeted synonym/identifier fix attempt**. Identifier headroom
   suggests stem-aware title matching is still worth testing; synonym
   headroom hints at keyword-frontmatter coverage gaps.
5. **Investigate `concept` regression** (-0.024 vs baseline). Possible
   BM25 over-weighting on broad conceptual queries; try `bm25Weight=2`
   instead of 2.5 with paired test on gold + curated.
6. **Graded sweep** (now feasible — see §3).
7. **Plugin QPS / PT15 A/B**, if 2–5 leave headroom.
8. **CI integration** — should happen alongside, not after.
9. **Real user logs ingest** if and when available — supersedes much
   of the above.
