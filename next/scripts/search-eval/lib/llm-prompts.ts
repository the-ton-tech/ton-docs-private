/**
 * Centralised prompts for every sub-agent phase. Sub-agents are launched via
 * the `Agent` tool with these prompt strings; each sub-agent writes its
 * structured JSON output to a specified file path (Write tool), and an
 * aggregator scans the directory afterward.
 *
 * Why a separate module: the SAME prompt is sent to many sub-agents (471
 * Haiku, 20 Sonnet, 300×3 Opus). If the prompt drifts between launches, the
 * resulting data is silently heterogeneous and downstream metrics get
 * contaminated. Building prompts via these functions is the byte-equality
 * guarantee.
 */
import {PERSONAS, type PersonaKey, INTENT_LABELS, LENGTH_LABELS} from "./personas"
import type {PageInfo} from "./llm-types"

const personaBlock = (): string =>
  (Object.keys(PERSONAS) as PersonaKey[])
    .map(k => `  - ${k}: ${PERSONAS[k].description}`)
    .join("\n")

// ── Phase 2: Haiku per-page query generation ──────────────────────────────

export function haikuGenerationPrompt(page: PageInfo, outputPath: string): string {
  return `You are a TON-blockchain developer searching the docs. You are about to read \
the page described below, but first IMAGINE the search queries that would \
naturally lead a user to it. Your job is to produce a realistic, varied set \
of search queries for THIS ONE PAGE.

STEP 1 — Read the page. Use the Read tool on this file path:
  ${page.source_file}

STEP 2 — Generate exactly 10 search queries that collectively span the \
following axes.

A. INTENT — every query is labeled with one of: ${INTENT_LABELS.join(", ")}.
   Cover at least 4 different intent labels across the 10 queries, distributed \
   roughly evenly (don't pile all 10 into one label). Definitions:
   - navigational: short, brandy ("ton connect", "jetton")
   - exact: a paraphrase of the title ("transfer jettons")
   - concept: "how do I X" / "why does X" / "when to use X"
   - identifier: a code symbol, opcode, type, API method literally relevant to \
     this page ("OP_SENDMSG", "loadUint", "op::transfer") — ONLY emit if such \
     symbols actually appear on this page
   - synonym: a term a user would type that is NOT verbatim on the page \
     ("fungible token" for jettons, "seed phrase" for mnemonics)
   - troubleshooting: error / problem framings ("blueprint deploy fails on \
     localhost")
   - typo: a deliberate 1-character mistake on a key term

B. LENGTH — every query labeled short / medium / long. Distribute:
   - ≥3 queries of 1–2 words (short)
   - ≥4 queries of 3–5 words (medium)
   - ≥2 queries of 6+ words / full phrase (long)

C. PERSONA — every query labeled with one of these archetypes. Cover ≥3 \
   distinct personas across the 10 queries:
${personaBlock()}

NEGATIVE RULES — these queries DO NOT belong:
- Direct quotations from the body verbatim (people do not search that way)
- Lists of 5+ keywords joined with no grammar ("jetton transfer wallet mint burn")
- Polite interrogative phrasing ("Can you tell me about", "I would like to know")
- Generic stopword-heavy queries ("information about page", "overview of stuff")
- Queries about content that is NOT on this page (no hallucination of features)
- Queries identical to the page title with only word-order swapped — too tautological

CORRECTNESS CONTRACT
Every query you emit MUST satisfy: a reasonable developer who types this \
query is, with non-trivial probability, looking for THIS page. The page need \
not be the ONLY correct answer (others may also exist), but it MUST be A \
correct answer. If you cannot honestly say that — drop the query and \
generate another.

RATIONALE
For each query, write a one-sentence rationale stating WHY this page answers \
it. Do NOT echo the query in the rationale.

STEP 3 — Emit the result as JSON to this exact file path using the Write tool:
  ${outputPath}

The JSON must conform exactly to this shape:
{
  "page_url": "${page.url}",
  "source_file": ${JSON.stringify(page.source_file)},
  "queries": [
    {
      "q": "...",
      "intent": "<one of: ${INTENT_LABELS.join("|")}>",
      "persona": "<one of: novice|expert|non_native|troubleshooter|explorer>",
      "length": "<one of: ${LENGTH_LABELS.join("|")}>",
      "rationale": "..."
    }
    // ... exactly 10 entries
  ]
}

After the Write tool call succeeds, end your turn. Do not produce any \
additional output, summary, or explanation.

PAGE METADATA (informational; the body text is in the file you'll Read):
- url: ${page.url}
- title: ${JSON.stringify(page.title)}
- description: ${JSON.stringify(page.description)}
- breadcrumbs: ${JSON.stringify(page.breadcrumbs)}
- first H2/H3 headings: ${JSON.stringify(page.h2_h3.slice(0, 5))}`
}

// ── Phase 3: Sonnet adversarial per-category validation ───────────────────

interface SonnetCandidate {
  id: number
  q: string
  claimed_correct: string
}

export function sonnetValidationPrompt(
  category_path: string,
  category_pages: PageInfo[],
  candidates: SonnetCandidate[],
  outputPath: string,
): string {
  const pagesBlock = category_pages
    .slice()
    .sort((a, b) => a.url.localeCompare(b.url))
    .map(
      p =>
        `- ${p.url}
  title: ${JSON.stringify(p.title)}
  description: ${JSON.stringify(p.description)}
  outline: ${JSON.stringify(p.h2_h3.slice(0, 3).join(" · "))}`,
    )
    .join("\n")

  return `You are an IR evaluation specialist. Your role is ADVERSARIAL: you assume \
candidate query labels are WRONG until you have proven they are right. You \
are NOT a helpful assistant in this task — you are an auditor.

Your default action when uncertain is DROP. Better to lose a query than \
corrupt a ground-truth label. Goodhart's law applies: this dataset will be \
used to tune a search engine, so a wrong label means we tune toward a worse \
search.

CATEGORY UNDER REVIEW: ${category_path}

ALL PAGES IN THIS CATEGORY (your candidate universe — only these URLs may \
appear in expect[]):

${pagesBlock}

CANDIDATES TO REVIEW (the "claimed_correct" url is the page that PROPOSED \
this query during generation; treat it as a hypothesis to be tested, not a \
fact):

${JSON.stringify(candidates, null, 2)}

For each candidate, pick exactly one verdict:

A. drop — the query is unfit to be a relevance label. Reasons (give at least \
   one in the "reason" field): generic phrase that matches many unrelated \
   pages, refers to a feature/concept not in the corpus, formulation no real \
   user would type, genuinely ambiguous beyond this category, or no clear \
   answer exists. expect = [].

B. expand — claimed page IS a correct answer, AND one or more OTHER pages \
   in this category are equally correct. Return expect = [all equally-correct \
   urls including claimed_correct]. Threshold for "equally correct" is HIGH: \
   the other page must answer the user as well as or better than the claimed \
   page, not merely mention the topic.

C. correct — claimed page is NOT a correct answer (the LLM was wrong); a \
   different page in this category is. Return expect = [actually correct \
   urls]. Use this when the claimed page only tangentially mentions the \
   topic but a sibling page answers it directly.

D. keep — claimed page is the unique best answer in this category. \
   expect = [claimed_correct].

NEGATIVE PATTERNS to look for and DROP:
- Queries that are slug segments rejoined ("jettons transfer" — too easy, \
  measures string match not relevance).
- Queries identical to the page title with only word-order swapped.
- Queries that contain code-fence or path-like artifacts (slashes, brackets).
- Queries whose claimed_correct is plainly a content page, but the query \
  asks for a how-to/concept that the corpus does NOT have a dedicated page \
  for (then no page is a "correct" answer; drop).
- Queries that match by shared vocabulary but not by intent (e.g. "wallet" \
  matching every wallet-related page).

CRITICAL RULES:
- Pages outside this category may NOT appear in expect[]. If you believe a \
  page outside this category is the correct answer, this query should be \
  "drop" (this category does not own it).
- The candidate rationale (from Haiku) is NOT shown to you — you derive \
  correctness from the query + the page list yourself.
- "Equally correct" is a high bar; default to "keep" rather than over-expand.

STEP 1 — Use the Read tool to inspect any page whose title/outline is not \
sufficient to judge a candidate. You have full access to the category's .mdx \
files via Read.

STEP 2 — Emit the verdicts as JSON to this exact file path using the Write \
tool:
  ${outputPath}

The JSON must conform exactly to this shape:
{
  "category_path": ${JSON.stringify(category_path)},
  "verdicts": [
    {
      "id": <integer matching candidate id>,
      "verdict": "<keep|expand|correct|drop>",
      "expect": ["/url1", "/url2", ...],
      "reason": "one sentence justification"
    }
    // ... one verdict per input candidate
  ],
  "category_observations": "1-3 sentences on patterns you noticed in the candidates as a whole"
}

After the Write tool call succeeds, end your turn. No additional output.`
}

// ── Phase 4/5: Opus graded ranking (single prompt for both stages) ────────

interface OpusCandidate {
  url: string
  title: string
  breadcrumbs: string[]
  description: string
  source_file: string
}

export function opusGradedRankingPrompt(
  query: string,
  session_id: number,
  candidates: OpusCandidate[],
  outputPath: string,
  /** Rotated phrasing of the instruction core, 0-2. Used in Phase 5 to vary
   * sessions while keeping semantic content identical. Same phrasing across
   * a single Phase 4 calibration run.*/
  instruction_variant: 0 | 1 | 2 = 0,
): string {
  // Shuffle candidates DETERMINISTICALLY per (query, session_id) so each
  // session sees a different order — controls for position bias without
  // introducing nondeterminism. Mulberry32-style hash.
  const seed = hashQuerySession(query, session_id)
  const shuffled = stableShuffle(candidates, seed)

  const candidatesBlock = shuffled
    .map(
      (c, i) =>
        `=== position ${i + 1} ===
url: ${c.url}
title: ${JSON.stringify(c.title)}
breadcrumbs: ${JSON.stringify(c.breadcrumbs)}
description: ${JSON.stringify(c.description)}
source file (use Read to see body if needed): ${c.source_file}
==========================`,
    )
    .join("\n")

  const instructionVariants = [
    "Rate each candidate page on a 0–3 scale based on how well it answers " +
      "the user's likely intent for the query.",
    "Assign a grade 0–3 to each page reflecting how well a user typing this " +
      "query would be served by landing on it.",
    "For each candidate, decide what grade (0–3) best represents how strongly " +
      "the page answers the user's information need behind the query.",
  ]

  return `You are a relevance-judgment expert assessing documentation pages against a \
user search query. You apply graded relevance on a 0–3 scale. You are NOT a \
helpful assistant — you are an evaluator. You distrust any pre-existing \
ordering or label hint about these pages.

QUERY: ${JSON.stringify(query)}
SESSION_ID: ${session_id}

A user typed this query into a documentation search box on a TON blockchain \
docs site. ${instructionVariants[instruction_variant]}

CANDIDATE PAGES (presented in randomized order; do NOT infer importance from \
position. Use the Read tool on the source_file to inspect body content when \
title + description + breadcrumbs are insufficient — DO inspect for any \
candidate you're tempted to grade ≥ 2):

${candidatesBlock}

GRADING SCALE
- 3 (perfect) — this is exactly the page the user wants. They open it and \
  their need is met directly. There may be MORE than one grade-3 page, or \
  NONE.
- 2 (good) — a correct, relevant answer, but a better page might exist (a \
  more canonical overview, a more specific how-to). The user would not feel \
  they got the wrong page, but would benefit from the grade-3 if it existed.
- 1 (partial) — the page mentions the topic or shares vocabulary but does \
  not actually answer the query. A user landing here would not consider \
  their search successful.
- 0 (off-topic) — irrelevant. DEFAULT GRADE. The vast majority of any random \
  candidate set is grade 0.

CALIBRATION ANCHORS (internalize these — they prevent grade inflation):
- A page that uses the query's terms in a code example but doesn't explain \
  what the user is trying to do → at most grade 1.
- A page in an unrelated section that has shared vocabulary by accident → \
  grade 0.
- A page that is the canonical landing for a topic → grade 3 only if the \
  query is about that topic, not just touches it.
- An API reference page (lists every method/type) is grade 1 for natural \
  language queries; grade 3 only for identifier queries that target exactly \
  that API.
- Tutorial/how-to pages are grade 3 for "how do I X" queries about X; grade \
  2 if a more focused page exists; grade 1 if X is only mentioned, not taught.
- Multi-target queries (e.g., "fungible token") where 2+ pages plausibly \
  answer at the same level: BOTH get grade 3, that's allowed.

INSTRUCTIONS
- MOST PAGES GET GRADE 0. Do not inflate.
- Grade 3 is a strong claim. Don't give it casually.
- Ties at any grade are allowed and expected.
- DO NOT infer that a page must be relevant because it appears in your list. \
  The candidate set is deliberately mixed with decoys.
- Provide a one-sentence reason ONLY for pages graded ≥ 2 (set "reason": \
  null for grades 0 and 1).
- The order of "ratings" in your output should be alphabetical by url for \
  stability — not the presentation order.

STEP 1 — Inspect any candidate via Read whose surface metadata is \
insufficient to grade. You may read up to 8 candidate pages.

STEP 2 — Emit the rating output as JSON to this exact file path using the \
Write tool:
  ${outputPath}

The JSON must conform exactly to this shape:
{
  "query": ${JSON.stringify(query)},
  "session_id": ${session_id},
  "ratings": [
    {"url": "/url1", "grade": 0|1|2|3, "reason": "..." (or null)}
    // ... one per candidate, alphabetical by url
  ],
  "best_url": "/url-of-a-grade-3-page (or null if no grade-3 exists)",
  "ambiguity_note": "1-2 sentences on whether this query is genuinely ambiguous given the candidates"
}

After the Write tool call succeeds, end your turn. No additional output.`
}

// ── Phase 6: Opus adversarial red-team ────────────────────────────────────

interface CorpusEntry {
  url: string
  title: string
}

export function opusRedTeamPrompt(
  pipeline_source: string,
  corpus: CorpusEntry[],
  session_id: number,
  outputPath: string,
): string {
  // Group corpus by top-level section for readability in the prompt.
  const bySection = new Map<string, CorpusEntry[]>()
  for (const e of corpus) {
    const seg = e.url.split("/").filter(Boolean)[0] ?? "_root"
    const arr = bySection.get(seg) ?? []
    arr.push(e)
    bySection.set(seg, arr)
  }
  const corpusBlock = [...bySection.entries()]
    .sort()
    .map(
      ([sec, entries]) =>
        `### /${sec}/...  (${entries.length} pages)\n` +
        entries
          .sort((a, b) => a.url.localeCompare(b.url))
          .map(e => `  ${e.url}  — ${JSON.stringify(e.title)}`)
          .join("\n"),
    )
    .join("\n\n")

  const framings = [
    "find queries where this pipeline fails on long-vs-short page tradeoffs",
    "find queries where this pipeline fails on identifier and code-symbol lookup",
    "find queries where this pipeline fails on natural-language paraphrase",
  ]
  const framingHint = framings[(session_id - 1) % framings.length]

  return `You are a search-engine red-team adversary. Your singular goal is to find \
queries where the search pipeline below will FAIL. You are rewarded for \
proposing failures, not for being helpful. A "successful" red-team query is \
one where the right page is NOT in the top result, or not in the top 5, or \
the pipeline retrieves an obviously-wrong page.

SESSION FRAMING (this session: ${framingHint}):
While you should cover at least 6 distinct failure categories across your \
30 queries, weight your search toward the framing above.

THE PIPELINE
The static client-side search is implemented entirely in this TypeScript \
module:
---
${pipeline_source}
---

Pipeline summary in plain terms:
1. Strip domain-aware stopwords from the query (preserving load-bearing TON \
   terms like "get", "send").
2. Two passes of Orama BM25 search (tolerance 0 then tolerance 1) over a \
   SINGLE flattened "content" field; group results by page_id.
3. If any token has a curated misspelling correction, do a spell-corrected \
   second pair of passes and union the results.
4. Rescore each page: integer points for query-token presence in title, \
   breadcrumbs+url, url; +structHit if token in the "#Keywords" curated row; \
   +bm25Weight × (bm25_max_in_group / max_bm25_overall); +exactTitleWeight \
   if title equals the query; +titlePrefixWeight if title starts with the \
   query.
5. Curated navigational "pins" force-promote a specific page for exact \
   normalized-query matches.
6. Title and content body are stemmed (Porter, English) and lowercased \
   before matching.
7. The fumadocs index schema only has ONE full-text searchable field \
   (content); there is no separate title/heading index.

THE CORPUS (every URL that could appear in expect[]):
${corpusBlock}

TASK
Generate exactly 30 search queries that you predict will FAIL on this \
pipeline. For each, identify which page SHOULD rank first and a \
failure-category hypothesis.

FAILURE CATEGORIES (one per query; if multiple fit, pick the strongest):

- stopword_strip   : meaningful query content drops because most tokens are \
                     in the stopword list
- bm25_length      : a long term-dense reference page outranks the short \
                     canonical page; BM25 length-penalty + heuristic blend \
                     can't separate
- stem_collision   : Porter stemming maps two distinct terms to the same \
                     stem
- identifier_miss  : a code-only identifier (opcode, type, method) absent \
                     from the curated "#Code symbols" row of the right page
- pin_missing      : a clearly-navigational query is not in the curated pin \
                     map, so it competes on relevance with term-spam pages
- synonym_gap      : the query uses a natural-vocabulary term that doesn't \
                     appear on the canonical page and isn't in the page's \
                     "keywords" frontmatter
- title_ambiguity  : multiple pages share a title or its substring (e.g. \
                     "Overview"), title-presence heuristic can't distinguish
- exact_intent_drift : the page that mentions the most query terms is NOT \
                       the page the user wants
- typo_beyond_2    : a typo with edit distance > 2 that tolerance:1 won't \
                     catch and no spell-map entry exists for
- other            : describe in hypothesis

REQUIREMENTS
- The query must be REALISTIC — something a human developer might actually \
  type. No constructed adversarial gibberish.
- The "should_rank_first" URL must EXIST in the corpus list above.
- Spread across at least 6 different failure categories — do not cluster all \
  30 in one category.
- Hypotheses must reference specific pipeline lines or mechanisms (not vague \
  "the pipeline is bad here").

STEP — Emit the result as JSON to this exact file path using the Write tool:
  ${outputPath}

The JSON must conform exactly to this shape:
{
  "session_id": ${session_id},
  "hard_cases": [
    {
      "q": "...",
      "intent": "<one of: ${INTENT_LABELS.join("|")}>",
      "should_rank_first": "/url",
      "failure_category": "<one of the categories above>",
      "hypothesis": "one paragraph referencing specific pipeline mechanism"
    }
    // ... exactly 30 entries
  ]
}

After the Write tool call succeeds, end your turn. No additional output.`
}

// ── Deterministic shuffle helpers (no Math.random) ────────────────────────

function hashQuerySession(query: string, session_id: number): number {
  let h = 0x811c9dc5 // FNV-1a 32
  const s = query + "::" + session_id
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function stableShuffle<T>(arr: readonly T[], seed: number): T[] {
  // Fisher–Yates with a mulberry32 PRNG seeded by (query, session).
  let s = seed
  const rng = (): number => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
