# Future work — search relevance harness

Captured at the end of the LLM-augmented eval round. Concrete, sized,
ordered by ROI / dependency. Things that need to happen first are at the
top; speculative items toward the bottom.

## 0. Status update (commits after this doc)

This document was the next-action list at commit `8a84384`. The
ship since then has measurably moved the harness numbers — `0.` here
records what's done so the same items aren't re-prioritized.

| ship          | binary | gold | comment                                    |
| ------------- | ------ | ---- | ------------------------------------------ |
| pinAfterStopwords (now unconditional, no flag) | curated +0.000, mined-test +0.000 | nDCG_g +0.000 → +0.007 | concept "what is a wallet" → hits the wallet pin |
| allowDuplicates: true (tokenizer) | mined-test hit@1 +0.004 | hit@1 +0.009, nDCG_g +0.012 | real BM25 tf restored |
| 6 spell-corrections | mined-test mrr +0.001 | — | typo_beyond_2 from hard-cases.json |
| stemReRank lever (off by default) | curated +0.000, mined-test ns | hit@1 +0.018 ns | regresses mined-test ns @ -0.0094; gold positive |
| headingMatchWeight=0.2 (NEW) | curated +0.016 / 0 regressions, mined-test **+0.020 hit@1 p=0.014** | nDCG_g flat, troubleshooting +0.030 | per-token + phrase heading match |
| `description` frontmatter indexed | — | hit@1 +0.018 | 469/471 pages have non-empty descriptions |
| `titleBM25Weight` lever (measured negative) | — | — | second Orama pass on type:"page"; rejected at every weight |
| `#Code symbols` conditional structHit (off by default) | mined-test ns sig negative | — | confirms maintainer's earlier unconditional rejection |

**Net shipped, vs. the harness's baseline before this doc:**

| metric              | start (8a84384) | now    | Δ       |
| ------------------- | --------------- | ------ | ------- |
| curated hit@1       | 0.921           | 0.929  | +0.008  |
| mined-test hit@1    | 0.813           | 0.832  | +0.019  |
| mined-test MRR      | 0.840           | 0.856  | +0.016  |
| gold hit@1          | 0.652           | 0.688  | +0.036  |
| gold nDCG_g@10      | 0.584           | 0.602  | +0.018  |
| gold exact nDCG_g   | 0.308           | 0.404  | +0.096  |
| gold troubleshoot  | 0.488           | 0.527  | +0.039  |

CI gate now enforced via floors.json with auto-ratchet warnings — see
`scripts/search-eval/ci-check.ts` + `.github/workflows/search-eval.yml`.

The §1–§9 items below are the *remaining* future work after this round.

## 1. Finish what Opus 529 interrupted

**Phase 5 (graded gold slice) is partial:** 325 of 1050 ratings landed
before Anthropic rate-limited Opus across our parallel agents. The
orchestrator is fully resumable — re-running `prepare` rebuilds batches
only for the missing tasks. Once 529s subside, finish:

```bash
# from next/, with out/api/search present
npx tsx scripts/search-eval/orchestrate-opus-rank.ts            # rewrites only missing batches
# then dispatch the remaining ~80 batches, model:opus, throttled
npx tsx scripts/search-eval/orchestrate-opus-rank.ts --aggregate  # → gold-evalset.json
```

**Critical:** dispatch in waves of ≤6 in parallel, with a deliberate
pause between waves (e.g. wait for a wave to complete before launching
the next, rather than firing 25+ at once like the first attempt). The
limiting factor is platform-level rate-limit, not Claude Max quota, so
sequential throughput is fine; brute parallelism is what tripped it.

Target: full 350-query gold slice (50 per intent). After that lands, a
**graded-objective sweep** (§3 below) becomes feasible.

If gold quality holds at α ≈ 1.0 on 350, consider scaling further to
~3000 (one ranking per validated query × 3 sessions). At that size,
per-intent significance becomes powered.

## 2. Targeted fixes from Phase 7's per-intent diagnostic

Gold-slice graded nDCG@10 by intent (DEFAULT_TUNING, n=112):

| intent          | nDCG_g@10 | mean grade@1 |
| --------------- | --------- | ------------ |
| navigational    | 0.72      | 2.46         |
| concept         | 0.49      | 1.52         |
| troubleshooting | 0.49      | 1.50         |
| **exact**       | **0.31**  | **1.00**     |

**`exact` is the biggest weak spot** and was invisible to binary Hit@1
(0.65 on gold; misleading without grading). Hypotheses worth measuring
on the held-out + gold:

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

## 3. Graded-objective sweep (after Phase 5 scales)

`sweep.ts` currently optimizes the *binary* objective on `mined-train`.
With ≥ 300 gold queries, add a sibling `sweep-graded.ts`:

- Page-stratified split of the gold slice into `gold-train` / `gold-test`.
- Objective: `0.4 * nDCG_g@10 + 0.4 * Hit@1 + 0.2 * ERR@10`.
- Same coordinate-ascent pattern; same guardrails (must not significantly
  regress curated, must significantly improve `gold-test`).

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

## 10. Order of operations (recommended)

1. **Finish Phase 5** (throttled). Re-run `report-graded.ts`. Update
   the gold-slice table in the README.
2. **`allowDuplicates: true` build experiment.** Single rebuild, all
   4 slices, both binary and graded. Either ship or document as
   measured-negative.
3. **Spot-check exact-intent gold labels** (1 hour). Quantify label
   noise vs. genuine search misses.
4. **One targeted exact-intent fix attempt** (stem-aware title bonus
   probably). Measure on gold. Ship only if significant.
5. **Graded sweep** once gold ≥ 300.
6. **Plugin QPS / PT15 A/B**, if 1–4 leave headroom.
7. **CI integration** — should happen alongside, not after.
8. **Real user logs ingest** if and when available — supersedes much
   of the above.
