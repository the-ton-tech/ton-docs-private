# Phase 5 expansion — state snapshot

Captured mid-execution after the session was stopped. The shipped state
on `main` (and on this branch's latest commit) is unchanged: production
search ranks against the n=349-query gold slice. The work documented
here is the **expansion to n≈1050 queries** (target 150 per intent ×
7 intents × 3 sessions = 3150 ratings), in flight.

## TL;DR

- **Phase 5 expansion: 2188 / 3150 ratings (69.5%).**
- 962 ratings still pending across **97 batches** (10 tasks each).
- Existing per-(query, session) JSONs live in
  `scripts/search-eval/llm-data/opus-rank/*.ranking.json` (gitignored,
  ~2176 files).
- The orchestrator (`orchestrate-opus-rank.ts`, `TARGET_PER_INTENT = 150`,
  committed in `a8d92cf`) is **fully resumable**. Re-running `prepare`
  rebuilds batches only for the missing tasks.

## How we got here (this session, on top of `8a84384`)

| commit  | what                                                                                  |
| ------- | ------------------------------------------------------------------------------------- |
| 1cb0b71 | Phase 5 complete on n=349 (1050/1050 ratings, α median 1.000)                         |
| 7512db0 | `allowDuplicates:true` measured-negative on curated & gold; reverted                  |
| d564526 | `codeSymbolWeight=1` shipped — +0.6% gold hit@1, +1.9% identifier nDCG_g, no regress  |
| 7d75b10 | `sweep-graded.ts` — confirms DEFAULT_TUNING is Pareto-optimal on n=349                |
| 9138263 | `.github/workflows/search-eval.yml` — CI runs harness on search-related PRs           |
| f515429 | `@orama/plugin-qps` A/B — measured-mixed; reverted (mined-test regressed 1.0-1.3%)    |
| a8d92cf | Bump `TARGET_PER_INTENT` 50→150 (Phase 5 expansion target ~3150 ratings)              |

## What broke on wave 14

All 10 dispatched agents (batches 112–121) returned `status=killed`
mid-execution — Anthropic appears to have rate-limited the parallel
Opus dispatch after ~150 successful runs in this session. The kills hit
between "I have enough context, writing outputs" and the actual Write
tool calls, so most batches wrote 0 ratings. A handful of partial writes
landed (delta: 2170 → 2188 = +18 ratings across 10 batches).

The previous Phase 5 wrap-up hit the same wall at higher parallelism
(25+ concurrent), and the FUTURE-WORK.md recommended waves of ≤6. The
8–10 we ran cleanly for ~13 waves before this one, so the limit isn't
a fixed concurrency number — it's a cumulative budget per window.
Cooling off should resolve it; **dispatch in waves of ≤6 when resuming.**

## Resume procedure

From `next/`, with `out/api/search` present:

```bash
# 1. Re-prepare to rebuild batches for only the missing 962 tasks.
#    Safe at any time; the orchestrator is idempotent and resumable
#    (skips tasks whose output JSON already exists).
rm -f scripts/search-eval/llm-data/opus-rank/batches/batch_*.prompt.txt
npx tsx scripts/search-eval/orchestrate-opus-rank.ts
# Expected output: "pending tasks: 962 (skipped 2188 already ranked)"
# Expected output: "wrote 97 batch files"

# 2. Dispatch in waves of ≤6 Opus agents. ~16 waves needed. Each batch
#    is one Agent call with `model: 'opus'`, subagent_type:
#    'general-purpose', run_in_background: true, and the prompt from
#    the Phase 5 dispatch pattern (see this session's history). Wait
#    for each wave to complete before launching the next.

# 3. When 3150/3150 ratings land, aggregate.
npx tsx scripts/search-eval/orchestrate-opus-rank.ts --aggregate
# Writes:
#   scripts/search-eval/gold-evalset.json          (queries with α≥0.5)
#   scripts/search-eval/gold-rank-report.json      (α distribution)

# 4. Re-run reports.
npx tsx scripts/search-eval/report-graded.ts --vs-baseline   # gold-only
npm run search:report                                        # all slices
```

If Phase 5 expansion reveals new findings, update:
- `scripts/search-eval/README.md` — replace n=349 table with n=~1000 numbers
- `scripts/search-eval/FUTURE-WORK.md` — refresh §1 and §2 per-intent
- Consider re-running `npx tsx scripts/search-eval/sweep-graded.ts` to
  confirm DEFAULT_TUNING is still Pareto-optimal at the larger n.

## Dispatch prompt template

Every batch agent gets this same body. Only the batch number changes:

```
You are a relevance-judgment expert (Opus 4.7) evaluating documentation
pages for a TON blockchain docs search engine.

Read the batch file at:
/home/user/ton-docs-private/next/scripts/search-eval/llm-data/opus-rank/batches/batch_NNN.prompt.txt

It contains 10 self-contained ranking tasks separated by
`===== TASK BOUNDARY (read & execute each in order) =====`.
Execute each task in order:

1. Read the task. Each contains: QUERY, SESSION_ID, CANDIDATE PAGES
   (randomized), GRADING SCALE (0-3), CALIBRATION ANCHORS, INSTRUCTIONS.
2. For each candidate page you're considering grading ≥ 2, use the Read
   tool to inspect the source_file body. Up to 8 reads per task.
3. Apply the grading scale strictly per calibration anchors. Most pages
   should get grade 0.
4. Emit JSON output (exact shape shown at end of task) to the exact file
   path given in STEP 2 of the task, using the Write tool.

When all 10 Write outputs are emitted, end your turn with no chat output.
Do NOT explain your work.

Critical:
- Process all 10 tasks in the batch.
- DEFAULT to grade 0. Grade 3 is a strong claim.
- One-sentence reason ONLY for grade ≥ 2 (null for 0 and 1).
- The output `ratings` array must be alphabetical by url.
- The file paths to write to are embedded in each task — do not invent them.
```

## What stays shipped during expansion

Production `DEFAULT_TUNING` (in `src/lib/search-core.ts`) is unchanged:

```ts
stopwords: DEFAULT_STOPWORDS,
pins: DEFAULT_PINS,
spell: DEFAULT_SPELL,
structHitWeight: 2,
allTermsWeight: 0,
proximityWeight: 0,
titleWeight: 2,
haystackWeight: 1,
urlWeight: 1,
bm25Weight: 2.5,
relevance: undefined,
exactTitleWeight: 3,
titlePrefixWeight: 0,
codeSymbolWeight: 1,        // ← shipped this session
```

Validated against the n=349 gold slice (committed gold-evalset.json):

| metric         | baseline | tuned   | Δ        | p       |
| -------------- | -------- | ------- | -------- | ------- |
| Hit@1 (binary) | 0.5014   | 0.5358  | +0.0344  |         |
| MRR            | 0.5587   | 0.5900  | +0.0312  | 0.004 ▲ |
| nDCG-graded@10 | 0.4982   | 0.5134  | +0.0152  | 0.081   |
| ERR@10         | 0.4506   | 0.4669  | +0.0163  | 0.049 ▲ |
| grade@1 mean   | 1.52     | 1.59    | +0.0659  | 0.046 ▲ |

Per-intent nDCG_g@10 (tuned, n=349):

| intent          | nDCG_g@10 | mean grade@1 |
| --------------- | --------- | ------------ |
| navigational    | 0.717     | 2.46         |
| exact           | 0.537     | 1.56         |
| troubleshooting | 0.520     | 1.63         |
| typo            | 0.496     | 1.38         |
| concept         | 0.473     | 1.46         |
| identifier      | 0.427     | 1.32         |
| **synonym**     | **0.424** | **1.30**     |

`synonym` is the remaining weakest intent. The expansion to ~150
per-intent queries will (a) sharpen these per-intent estimates from
±0.14 to ±0.08 95% CI, and (b) make per-intent significance tests
powered enough to ship intent-specific fixes with confidence.

## Files of note

| path                                                  | role                                       |
| ----------------------------------------------------- | ------------------------------------------ |
| `scripts/search-eval/orchestrate-opus-rank.ts`        | sampler + batch packer + aggregator        |
| `scripts/search-eval/gold-evalset.json`               | **current shipped gold** (n=349, α median 1.0) |
| `scripts/search-eval/gold-rank-report.json`           | α distribution metadata                    |
| `scripts/search-eval/llm-data/opus-rank/*.ranking.json` | per-(query, session) JSONs (gitignored)  |
| `scripts/search-eval/llm-data/opus-rank/batches/`     | regeneratable dispatch prompts             |
| `scripts/search-eval/llm-data/opus-rank/sample.manifest.json` | sampled query list (for audit)     |
| `scripts/search-eval/sweep-graded.ts`                 | graded-objective coordinate-ascent sweep   |
| `.github/workflows/search-eval.yml`                   | CI: smoke + build + binary + graded report |
