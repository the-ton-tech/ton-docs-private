import {create, getByID, search, type AnyOrama} from "@orama/orama"
import {tokenizer as oramaTokenizer} from "@orama/orama/components"
import type {SortedResult} from "fumadocs-core/search"

/**
 * Shared Orama English tokenizer used to *stem* re-rank inputs so the score
 * function compares query/title in the same stem space the index uses (e.g.
 * "validating" → "valid", "wallets" → "wallet"). Without this, a query like
 * "validating" misses a title "Validation" on the substring `includes` check
 * even though the Orama pass hits it via the stemmed inverted index. Lazy
 * + memoized so the cost is paid once per process (browser or Node harness),
 * not per query. Awaited once at the top of `runRankedSearch`.
 */
type StemTokenizer = {tokenize: (s: string) => Promise<string[]> | string[]}
let stemTokenizerPromise: Promise<StemTokenizer> | undefined
function getStemTokenizer(): Promise<StemTokenizer> {
  return (stemTokenizerPromise ??= Promise.resolve(
    oramaTokenizer.createTokenizer({language: "english", stemming: true}),
  ) as Promise<StemTokenizer>)
}

async function stemString(s: string): Promise<string[]> {
  const tk = await getStemTokenizer()
  const out = await tk.tokenize(s)
  return Array.isArray(out) ? out : [String(out)]
}

/**
 * Empty Orama instance with the query-time tokenizer. `load()` overwrites
 * schema/index/docs, so the `{_: }` schema is just a placeholder (the pattern
 * Fumadocs uses internally). The tokenizer here MUST mirror the index-time
 * config in app/api/search/route.ts — `language` lives *inside* the tokenizer
 * (Orama forbids a top-level `language` with a custom tokenizer:
 * NO_LANGUAGE_WITH_CUSTOM_TOKENIZER). If the two drift, stemmed query terms
 * stop lining up with the stored stems and recall silently collapses. Both
 * the browser dialog and the offline harness build their DB here so the
 * guarantee is enforced in one place.
 */
export function createClientDB(): AnyOrama {
  return create({
    schema: {_: "string"},
    sort: {enabled: false},
    components: {tokenizer: {language: "english", stemming: true, allowDuplicates: true}},
  })
}

/**
 * Pure, environment-agnostic search ranking pipeline shared by the browser
 * search dialog (components/search.tsx) and the offline relevance harness
 * (scripts/search-eval). Keeping a single implementation here is what makes
 * the eval numbers trustworthy: the harness scores the *exact* code that
 * ships, not a hand-kept reproduction that silently drifts.
 *
 * Nothing in this module touches React, the network, or the filesystem. The
 * caller is responsible for obtaining a loaded Orama instance (browser:
 * fetch + load; harness: fs + load) and for any presentation concern such as
 * snippet highlighting.
 */

export type IndexedDoc = {
  id: string | number
  // Fumadocs `createFromSource` emits one "page" row (content = title) plus
  // "heading"/"text" rows (content = heading / paragraph) sharing a
  // `page_id`. Earlier fumadocs versions used "head" instead of "heading"
  // — the runtime check below tolerates either to avoid an invisible recall
  // drop on a downgrade.
  type: "page" | "heading" | "head" | "text"
  content: string
  url: string
  breadcrumbs?: string[]
  // Optional frontmatter `tag`, attached at index time on the page row
  // (see app/api/search/route.ts). `"deprecated"` triggers the R4 score
  // down-rank in runRankedSearch.
  tag?: string
}

// Emit far more distinct pages than the stock 60 flattened rows. On a 48k-doc
// index a broad query yields hundreds of groups; with the stock 60-cap +
// 8-hits/page the right page is often unreachable past rank ~10. Fewer hits
// per page + a larger cap surfaces many more distinct pages ("breadth").
export const MAX_RESULTS = 120
export const HITS_PER_PAGE = 3

// English stopwords. Stripping them from the query (not the index) removes the
// noise that made e.g. "how to deploy a contract" match "a"-heavy opcode
// pages. NOTE: deliberately omits get/set/use/call/send/run — those are
// load-bearing TON developer terms ("get method", "send message"), and
// dropping them silently tanked recall on the most common dev queries.
export const DEFAULT_STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have how i in into is it its my no not of on or " +
    "that the their then there these this to was what when where which who why with you your " +
    "does could should would about over via using"
  ).split(" "),
)

/**
 * High-traffic navigational ("best bet") queries. When the normalized query
 * matches a key exactly, the mapped page is force-promoted to rank #1. This
 * is bounded and deterministic: it only fires on these exact strings, so it
 * cannot regress the long tail. Targets the queries where users expect the
 * canonical landing page, not the most term-dense page.
 */
export const DEFAULT_PINS: Record<string, string> = {
  "ton connect": "/applications/ton-connect/overview",
  tonconnect: "/applications/ton-connect/overview",
  jetton: "/blockchain-basics/standard/tokens/jettons/overview",
  jettons: "/blockchain-basics/standard/tokens/jettons/overview",
  nft: "/blockchain-basics/standard/tokens/nft/overview",
  nfts: "/blockchain-basics/standard/tokens/nft/overview",
  tvm: "/blockchain-basics/tvm/overview",
  tolk: "/blockchain-basics/tolk/overview",
  func: "/blockchain-basics/languages/func/overview",
  fift: "/blockchain-basics/languages/fift/overview",
  "tl-b": "/blockchain-basics/languages/tl-b/overview",
  tlb: "/blockchain-basics/languages/tl-b/overview",
  wallet: "/blockchain-basics/standard/wallets/how-it-works",
  wallets: "/blockchain-basics/standard/wallets/how-it-works",
  "smart contract": "/blockchain-basics/contract-dev/introduction",
  "smart contracts": "/blockchain-basics/contract-dev/introduction",
  blueprint: "/blockchain-basics/contract-dev/blueprint/overview",
  "get method": "/blockchain-basics/tvm/get-method",
  "get methods": "/blockchain-basics/tvm/get-method",
  toncenter: "/applications/api/toncenter/introduction",
  api: "/applications/api/toncenter/introduction",
  toolset: "/overview/toolset",
  "start here": "/overview/start-here",
  glossary: "/overview/learn-more/glossary",
  appkit: "/applications/appkit/overview",
  "app kit": "/applications/appkit/overview",
  walletkit: "/applications/walletkit/overview",
  "wallet kit": "/applications/walletkit/overview",
  mcp: "/overview/ai/mcp",
  tonpay: "/applications/ton-pay/overview",
  "ton pay": "/applications/ton-pay/overview",
}

/**
 * Curated misspelling -> correction map for terms whose edit distance to the
 * canonical TON term exceeds Orama's fuzzy tolerance ceiling (2), e.g.
 * "jeton" -> "jetton", "transcation" -> "transaction". Purely orthographic
 * and tiny, which is why it can be applied unconditionally (see
 * runRankedSearch) without the noise that sank *semantic* query expansion.
 */
export const DEFAULT_SPELL: Record<string, string> = {
  jeton: "jetton",
  jetons: "jettons",
  transcation: "transaction",
  trasaction: "transaction",
  contrat: "contract",
  contarct: "contract",
  walet: "wallet",
  wallett: "wallet",
  blockchian: "blockchain",
  blokchain: "blockchain",
  smrt: "smart",
  validater: "validator",
  transfor: "transfer",
  tonceter: "toncenter",
  toncentre: "toncenter",
  blueprnt: "blueprint",
  blueprit: "blueprint",
  // hard-cases.json typo_beyond_2: edit distance > 1 typos Orama's
  // tolerance:1 second pass can't reach. All three appear in real user
  // failure traces; corrections are unambiguous.
  valdiator: "validator",
  valdator: "validator",
  dictinary: "dictionary",
  dictionry: "dictionary",
  concensus: "consensus",
  consensous: "consensus",
}

/**
 * Brand compound-token -> space-separated split. The tokenizer splits hyphens
 * (`ton-pay` → `ton`+`pay`), so a squashed brand query like `tonpay` matches
 * nothing in the title/URL surface and falls back to fuzzy, where it edit-1
 * collides with unrelated tokens (e.g. `tonpy`, a Python SDK). This map runs
 * a second pass on the split form and unions, so `tonpay sdk` finds the
 * `ton-pay` pages the same way `ton pay sdk` already does. Bounded to
 * compound brands whose URL slug is hyphenated.
 */
export const DEFAULT_DECOMPOUND: Record<string, string> = {
  tonpay: "ton pay",
  tonconnect: "ton connect",
}

export interface Tuning {
  stopwords: Set<string>
  /** Exact normalized-query -> canonical URL. Empty disables pinning. */
  pins: Record<string, string>
  /**
   * Per-token misspelling -> correction. When any query token matches, a
   * second Orama pass on the corrected query is unioned in and the corrected
   * tokens join the re-rank set. NOT recall-gated: the gate (fire only when
   * few groups found) never tripped — fuzzy search almost always returns
   * *something*, so hard typos fail on ranking, not recall. The noise risk of
   * an always-on corrected pass is bounded because the map is tiny and purely
   * orthographic (unlike semantic synonym expansion, which regressed).
   */
  spell: Record<string, string>
  /**
   * Per-token squashed-brand -> space-split rewrite (e.g. `tonpay` → `ton
   * pay`). When any query token matches a key, a second Orama pass on the
   * decompounded query is unioned in, the decompounded tokens join the
   * re-rank, and the decompounded normalized form joins pin-lookup. Bounded
   * to compound brands whose URL slug is hyphenated, so the squashed token
   * (which the tokenizer never produces) cannot match the indexed surface
   * without this rewrite. Empty disables.
   */
  decompound: Record<string, string>
  /**
   * Per-token bonus when the term appears in a page's *curated* index rows —
   * the synthetic "Keywords" / "Code symbols" blocks (identified by the
   * `#Keywords` / `#Code symbols` URL fragment). High precision because those
   * surfaces are editor-/symbol-curated, not arbitrary prose, so this does
   * NOT have the canonical-page-demotion problem that sank generic proximity.
   * 0 disables.
   */
  structHitWeight: number
  /** Bonus when all query tokens occur in a page's matched text. 0 disables. */
  allTermsWeight: number
  /** Bonus when query tokens occur adjacently in matched text. 0 disables. */
  proximityWeight: number
  /** Re-rank weights for term presence in title / breadcrumbs+url / url. */
  titleWeight: number
  haystackWeight: number
  urlWeight: number
  /**
   * Weight on Orama's own BM25 relevance, folded into the re-rank as
   * `bm25Weight * (groupBM25 / maxGroupBM25)` (∈[0,1] after min-max over the
   * candidate set). The shipped pipeline historically DISCARDED BM25 entirely
   * (groups were ordered only by a coarse integer lexical heuristic with
   * Orama insertion order as the sole tiebreaker), so near-tied canonical
   * pages were separated by crawl order, not relevance. Raw BM25 alone
   * regresses (it floats long term-dense reference pages over short canonical
   * ones — measured), which is exactly why this is a *calibrated blend* on
   * top of the lexical heuristic, not a replacement. >0 also promotes BM25
   * from "unused" to the primary tiebreaker. 0 = exact legacy behavior.
   */
  bm25Weight: number
  /**
   * Optional BM25 parameters threaded into every Orama pass. `b` is the
   * document-length penalty (default 0.75); the corpus mixes short canonical
   * pages with multi-KB reference/whitepaper pages, so this is the principled
   * knob for the long-page-floats problem. undefined = Orama defaults
   * (k=1.2, b=0.75, d=0.5) = exact legacy behavior.
   */
  relevance?: {k?: number; b?: number; d?: number}
  /**
   * Bonus when the page title (normalized) exactly equals the meaningful
   * query, or (titlePrefixWeight) when the title starts with it. Substring
   * `includes` weighting can't tell "Wallet" from "How wallets work" for the
   * query "wallet"; this restores the exact/prefix preference users expect
   * for navigational/exact intents. 0 disables.
   */
  exactTitleWeight: number
  titlePrefixWeight: number
  /**
   * Use stemmed tokens against stemmed title/haystack/url when computing
   * title/haystack/url presence bonuses and the exact-title preference.
   * The index is built with English stemming, but the re-rank historically
   * did a raw `title.includes(t)` on unstemmed query tokens, so a query for
   * "validating" missed a title "Validation" on the substring check even
   * though the Orama pass surfaced the page via the stemmed inverted index
   * (the substring fails because the stems aren't substrings of one another).
   * Stemming both sides lets the re-rank reward the same morphological
   * matches Orama already counted. true = stem-aware; false = legacy.
   */
  stemReRank: boolean
  /**
   * Bonus when an indexed heading (a `type:"heading"` row from
   * `structuredData.headings`) contains the full normalized query, OR the
   * per-token bonus when a heading contains an individual query token.
   * Pages where the query matches a section heading are stronger candidates
   * than pages where the same terms only appear in body paragraphs. 0
   * disables. Phrase-match earns this weight × tokens.length so multi-word
   * heading hits weigh comparably to per-token heading hits.
   */
  headingMatchWeight: number
  /**
   * Weight on Orama's BM25 over a *title-only* second pass (`where:
   * {type:"page"}`). The page rows have content equal to the title, so a
   * second exact-tolerance Orama pass restricted to them returns the
   * per-page BM25 of the title surface alone — high IDF for rare title
   * tokens, document length is the title length (very short). Min-max
   * normalized over the candidate set before being added (`w * tb /
   * maxTb`) so the contribution is bounded and corpus-portable, matching
   * the bm25Weight blend pattern. 0 disables.
   */
  titleBM25Weight: number
  /**
   * When true, each per-token title/haystack/url presence bonus is
   * multiplied by `log(maxDf / df_t)` clamped to [0.5, 2.5], where df_t
   * is the row-level document frequency of the token in the corpus.
   * Rationale: a query "how to deploy a contract" → kept tokens
   * `[deploy, contract]`. Without IDF weighting, both earn `titleWeight=2`
   * per surface; a title hit on "contract" (very common across pages)
   * counts as much as a title hit on "deploy" (much rarer), which floods
   * concept queries with title-noise. The BM25 blend captures IDF *for
   * the whole page*, not per-token-per-surface; this lever extends the
   * IDF signal into the lexical heuristic where it's actually most
   * useful (titles + URLs). false = legacy flat-weight per token.
   */
  idfWeightTokens: boolean
  /**
   * Per-token bonus when the term appears in a page's auto-mined `#Code
   * symbols` row AND the query itself contains a code-identifier-shaped
   * token (camelCase ≥ 8 chars, snake_case, ALLCAPS opcode, alnum mix,
   * ::-scoped, dotted method). Unconditional code-symbol re-rank wrecked
   * concept intent (measured), but conditioning on token shape limits the
   * bonus to queries that actually mean a code symbol — the regressing
   * prose queries can't activate it. 0 disables.
   */
  codeSymbolWeight: number
  /**
   * Multiplier applied to a page's score when its URL is an API reference
   * page (matches `/api-reference/` or `/reference/`) AND the query does not
   * look like the user is hunting an identifier (no code-shaped token) AND
   * the query does not explicitly ask for the reference (no `api` / `reference`
   * token). Catches the common failure shape "tonconnect quick start" where
   * the symbol-dense `/api-reference/ui-react` page out-scores the short
   * canonical landing on raw BM25. 1.0 disables. Same pattern as the
   * deprecated-tag ×0.5 demotion — preserves relative ordering inside the
   * demoted set so the most relevant ref page still wins among its peers.
   */
  apiRefDemotion: number
}

/**
 * Production tuning. The harness clones this and flips one field at a time to
 * ablate each lever in isolation. Defaults reflect what the 100+ query eval
 * set validated as a net improvement; see scripts/search-eval/README.
 */
export const DEFAULT_TUNING: Tuning = {
  stopwords: DEFAULT_STOPWORDS,
  pins: DEFAULT_PINS,
  spell: DEFAULT_SPELL,
  decompound: DEFAULT_DECOMPOUND,
  structHitWeight: 2,
  // Proximity/all-terms bonuses measured net-negative on hit@1 and MRR (they
  // float long reference pages over canonical short pages), so disabled. The
  // code path stays for the harness to re-ablate if the corpus changes.
  allTermsWeight: 0,
  proximityWeight: 0,
  titleWeight: 2,
  haystackWeight: 1,
  urlWeight: 1,
  // Validated on a 1375-query auto-mined, index-grounded HELD-OUT set the
  // tuning never saw (scripts/search-eval/{mine-evalset,report,confirm}.ts).
  // bm25=2.5 + exactTitle=3 is the Pareto knee: mined-test MRR +0.0168,
  // Hit@1 +0.0183, nDCG@10 +0.0150 (all paired-permutation p≤0.0004) with
  // ZERO curated regression (curated metrics byte-identical). bm25=3 buys
  // ~14% more held-out gain but regresses 2 curated queries — rejected, the
  // hand-verified curated set is the higher-confidence signal. `relevance`
  // (BM25 k/b/d) left at Orama defaults: every off-default value measured
  // net-negative on held-out, both directions (the harness's recurring
  // "intuition is wrong on this corpus" result). titlePrefix: not
  // significant on held-out — left off for parsimony.
  bm25Weight: 2.5,
  relevance: undefined,
  exactTitleWeight: 3,
  titlePrefixWeight: 0,
  // stemReRank: small Hit@1 lift on the graded gold slice but a held-out
  // mined-test MRR regression of ~0.009 (p≈0.05) driven by precision loss on
  // synonym/typo intents — the corpus has many morphology-collision pages
  // (test/tests/testing/tester all stem to "test") that the stricter
  // word-equality match cannot disambiguate. Lever stays in the harness for
  // future re-evaluation (esp. on a graded slice ≥ 300) but ships off.
  stemReRank: false,
  // headingMatchWeight: matched ablations swept 0.1 / 0.2 / 0.25 / 0.3 /
  // 0.35 / 0.5 — 0.2 is the Pareto knee. Mined-test all three metrics
  // improve significantly (Hit@1 +0.020 p=0.014, MRR +0.017 p=0.003,
  // nDCG@10 +0.018 p=0.0004) and curated improves with ZERO regressions
  // (curated Hit@1 +0.016, MRR +0.011). Higher weights buy more held-out
  // gain at the cost of curated regressions (0.25 → 1, 0.3+ → 2). Per the
  // harness discipline: no curated regression > marginal held-out delta.
  // On the gold slice this also lifts troubleshooting from 0.497 to 0.527
  // (one of the four worst-performing intents per FUTURE-WORK §2).
  headingMatchWeight: 0.2,
  // titleBM25Weight: measured negative at every weight (0.5/1/2). The
  // shipped bm25Weight already captures title signal because the page
  // row's content IS the title, so a separate title-only Orama pass
  // contributes mostly noise. Curated -1pp Hit@1, mined-test -0.6pp
  // MRR at w=0.5. Kept as a lever for re-ablation if the corpus
  // changes (e.g. very long titles become common), but ships off.
  titleBM25Weight: 0,
  // idfWeightTokens: measured strongly negative across all 3 binary
  // slices (curated Hit@1 -3.2pp, mined-test Hit@1 -1.8pp, MRR -1.2pp).
  // The intuition was that "deploy" (rare) should outweigh "contract"
  // (common) in per-token title bonuses; in practice the BM25 blend
  // already captures the IDF signal at the page level, and adding IDF
  // multipliers to the lexical heuristic creates an opposing signal that
  // demotes canonical landing pages whose titles happen to use common
  // domain words. The harness's recurring "intuition is wrong on this
  // corpus" pattern. Lever stays for re-ablation only if BM25 blending
  // is later replaced; ships off.
  idfWeightTokens: false,
  // codeSymbolWeight: conditional code-symbol bonus, fires only when the
  // query contains a shape-real code identifier (underscore, ::-scope,
  // dotted method, or camelCase ≥ 8 chars). On gold (n=349) this adds
  // +0.0057 hit@1, +0.019 nDCG_g on identifier intent, with byte-identical
  // curated / mined-train / mined-test (the shape gate filters all
  // binary-slice queries out, so the lever can only help the new
  // signal-rich gold queries). Token-shape strictness avoids the previously
  // measured regression of unconditional code-symbol re-ranking.
  codeSymbolWeight: 1,
  // apiRefDemotion: 0.80 is the Pareto knee from the harness sweep over
  // {1.0, 0.9, 0.8, 0.7, 0.6, 0.5}. At 0.8: cov@10 +0.77pp, mrr +0.07pp,
  // fixes "tonconnect quick start" with ZERO regression vs 1.0. At 0.7+
  // below a new fail appears ([concept] "test smart contracts with
  // blueprint" — the testing/reference page over-demotes). Gated by
  // !hasCodeShapedToken && !wantsReference so identifier queries and
  // explicit "api reference" lookups are unaffected — only prose queries
  // on brand pages flip.
  apiRefDemotion: 0.8,
}

/**
 * Baseline tuning == the previously shipped behavior, used by the harness to
 * reproduce the pre-tuning baseline exactly (no pins, no spell, no proximity,
 * old stopword list semantics aside). Levers are added back one by one.
 */
export const BASELINE_TUNING: Tuning = {
  stopwords: new Set(
    (
      "a an and are as at be but by for from has have how i in into is it its my no not of on or " +
      "that the their then there these this to was what when where which who why with you your do " +
      "does can could should would about over via using use get set make"
    ).split(" "),
  ),
  pins: {},
  spell: {},
  decompound: {},
  structHitWeight: 0,
  allTermsWeight: 0,
  proximityWeight: 0,
  titleWeight: 2,
  haystackWeight: 1,
  urlWeight: 1,
  bm25Weight: 0,
  relevance: undefined,
  exactTitleWeight: 0,
  titlePrefixWeight: 0,
  stemReRank: false,
  headingMatchWeight: 0,
  titleBM25Weight: 0,
  idfWeightTokens: false,
  codeSymbolWeight: 0,
  apiRefDemotion: 1,
}

// Vendored from `github-slugger` v2.0.0 (`regex.js`). Mirrors the same
// constant in orama-server/search-core.mjs so the browser-side ranker and
// the server-side ranker produce byte-identical anchor strings for the same
// heading. See the mjs sibling for the full rationale; do not hand-edit the
// character class.
// eslint-disable-next-line no-control-regex, no-misleading-character-class, no-useless-escape
const GITHUB_SLUGGER_REGEX =
  /[\0-\x1F!-,\.\/:-@\[-\^`\{-\xA9\xAB-\xB4\xB6-\xB9\xBB-\xBF\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0378\u0379\u037E\u0380-\u0385\u0387\u038B\u038D\u03A2\u03F6\u0482\u0530\u0557\u0558\u055A-\u055F\u0589-\u0590\u05BE\u05C0\u05C3\u05C6\u05C8-\u05CF\u05EB-\u05EE\u05F3-\u060F\u061B-\u061F\u066A-\u066D\u06D4\u06DD\u06DE\u06E9\u06FD\u06FE\u0700-\u070F\u074B\u074C\u07B2-\u07BF\u07F6-\u07F9\u07FB\u07FC\u07FE\u07FF\u082E-\u083F\u085C-\u085F\u086B-\u089F\u08B5\u08C8-\u08D2\u08E2\u0964\u0965\u0970\u0984\u098D\u098E\u0991\u0992\u09A9\u09B1\u09B3-\u09B5\u09BA\u09BB\u09C5\u09C6\u09C9\u09CA\u09CF-\u09D6\u09D8-\u09DB\u09DE\u09E4\u09E5\u09F2-\u09FB\u09FD\u09FF\u0A00\u0A04\u0A0B-\u0A0E\u0A11\u0A12\u0A29\u0A31\u0A34\u0A37\u0A3A\u0A3B\u0A3D\u0A43-\u0A46\u0A49\u0A4A\u0A4E-\u0A50\u0A52-\u0A58\u0A5D\u0A5F-\u0A65\u0A76-\u0A80\u0A84\u0A8E\u0A92\u0AA9\u0AB1\u0AB4\u0ABA\u0ABB\u0AC6\u0ACA\u0ACE\u0ACF\u0AD1-\u0ADF\u0AE4\u0AE5\u0AF0-\u0AF8\u0B00\u0B04\u0B0D\u0B0E\u0B11\u0B12\u0B29\u0B31\u0B34\u0B3A\u0B3B\u0B45\u0B46\u0B49\u0B4A\u0B4E-\u0B54\u0B58-\u0B5B\u0B5E\u0B64\u0B65\u0B70\u0B72-\u0B81\u0B84\u0B8B-\u0B8D\u0B91\u0B96-\u0B98\u0B9B\u0B9D\u0BA0-\u0BA2\u0BA5-\u0BA7\u0BAB-\u0BAD\u0BBA-\u0BBD\u0BC3-\u0BC5\u0BC9\u0BCE\u0BCF\u0BD1-\u0BD6\u0BD8-\u0BE5\u0BF0-\u0BFF\u0C0D\u0C11\u0C29\u0C3A-\u0C3C\u0C45\u0C49\u0C4E-\u0C54\u0C57\u0C5B-\u0C5F\u0C64\u0C65\u0C70-\u0C7F\u0C84\u0C8D\u0C91\u0CA9\u0CB4\u0CBA\u0CBB\u0CC5\u0CC9\u0CCE-\u0CD4\u0CD7-\u0CDD\u0CDF\u0CE4\u0CE5\u0CF0\u0CF3-\u0CFF\u0D0D\u0D11\u0D45\u0D49\u0D4F-\u0D53\u0D58-\u0D5E\u0D64\u0D65\u0D70-\u0D79\u0D80\u0D84\u0D97-\u0D99\u0DB2\u0DBC\u0DBE\u0DBF\u0DC7-\u0DC9\u0DCB-\u0DCE\u0DD5\u0DD7\u0DE0-\u0DE5\u0DF0\u0DF1\u0DF4-\u0E00\u0E3B-\u0E3F\u0E4F\u0E5A-\u0E80\u0E83\u0E85\u0E8B\u0EA4\u0EA6\u0EBE\u0EBF\u0EC5\u0EC7\u0ECE\u0ECF\u0EDA\u0EDB\u0EE0-\u0EFF\u0F01-\u0F17\u0F1A-\u0F1F\u0F2A-\u0F34\u0F36\u0F38\u0F3A-\u0F3D\u0F48\u0F6D-\u0F70\u0F85\u0F98\u0FBD-\u0FC5\u0FC7-\u0FFF\u104A-\u104F\u109E\u109F\u10C6\u10C8-\u10CC\u10CE\u10CF\u10FB\u1249\u124E\u124F\u1257\u1259\u125E\u125F\u1289\u128E\u128F\u12B1\u12B6\u12B7\u12BF\u12C1\u12C6\u12C7\u12D7\u1311\u1316\u1317\u135B\u135C\u1360-\u137F\u1390-\u139F\u13F6\u13F7\u13FE-\u1400\u166D\u166E\u1680\u169B-\u169F\u16EB-\u16ED\u16F9-\u16FF\u170D\u1715-\u171F\u1735-\u173F\u1754-\u175F\u176D\u1771\u1774-\u177F\u17D4-\u17D6\u17D8-\u17DB\u17DE\u17DF\u17EA-\u180A\u180E\u180F\u181A-\u181F\u1879-\u187F\u18AB-\u18AF\u18F6-\u18FF\u191F\u192C-\u192F\u193C-\u1945\u196E\u196F\u1975-\u197F\u19AC-\u19AF\u19CA-\u19CF\u19DA-\u19FF\u1A1C-\u1A1F\u1A5F\u1A7D\u1A7E\u1A8A-\u1A8F\u1A9A-\u1AA6\u1AA8-\u1AAF\u1AC1-\u1AFF\u1B4C-\u1B4F\u1B5A-\u1B6A\u1B74-\u1B7F\u1BF4-\u1BFF\u1C38-\u1C3F\u1C4A-\u1C4C\u1C7E\u1C7F\u1C89-\u1C8F\u1CBB\u1CBC\u1CC0-\u1CCF\u1CD3\u1CFB-\u1CFF\u1DFA\u1F16\u1F17\u1F1E\u1F1F\u1F46\u1F47\u1F4E\u1F4F\u1F58\u1F5A\u1F5C\u1F5E\u1F7E\u1F7F\u1FB5\u1FBD\u1FBF-\u1FC1\u1FC5\u1FCD-\u1FCF\u1FD4\u1FD5\u1FDC-\u1FDF\u1FED-\u1FF1\u1FF5\u1FFD-\u203E\u2041-\u2053\u2055-\u2070\u2072-\u207E\u2080-\u208F\u209D-\u20CF\u20F1-\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F-\u215F\u2189-\u24B5\u24EA-\u2BFF\u2C2F\u2C5F\u2CE5-\u2CEA\u2CF4-\u2CFF\u2D26\u2D28-\u2D2C\u2D2E\u2D2F\u2D68-\u2D6E\u2D70-\u2D7E\u2D97-\u2D9F\u2DA7\u2DAF\u2DB7\u2DBF\u2DC7\u2DCF\u2DD7\u2DDF\u2E00-\u2E2E\u2E30-\u3004\u3008-\u3020\u3030\u3036\u3037\u303D-\u3040\u3097\u3098\u309B\u309C\u30A0\u30FB\u3100-\u3104\u3130\u318F-\u319F\u31C0-\u31EF\u3200-\u33FF\u4DC0-\u4DFF\u9FFD-\u9FFF\uA48D-\uA4CF\uA4FE\uA4FF\uA60D-\uA60F\uA62C-\uA63F\uA673\uA67E\uA6F2-\uA716\uA720\uA721\uA789\uA78A\uA7C0\uA7C1\uA7CB-\uA7F4\uA828-\uA82B\uA82D-\uA83F\uA874-\uA87F\uA8C6-\uA8CF\uA8DA-\uA8DF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA954-\uA95F\uA97D-\uA97F\uA9C1-\uA9CE\uA9DA-\uA9DF\uA9FF\uAA37-\uAA3F\uAA4E\uAA4F\uAA5A-\uAA5F\uAA77-\uAA79\uAAC3-\uAADA\uAADE\uAADF\uAAF0\uAAF1\uAAF7-\uAB00\uAB07\uAB08\uAB0F\uAB10\uAB17-\uAB1F\uAB27\uAB2F\uAB5B\uAB6A-\uAB6F\uABEB\uABEE\uABEF\uABFA-\uABFF\uD7A4-\uD7AF\uD7C7-\uD7CA\uD7FC-\uD7FF\uE000-\uF8FF\uFA6E\uFA6F\uFADA-\uFAFF\uFB07-\uFB12\uFB18-\uFB1C\uFB29\uFB37\uFB3D\uFB3F\uFB42\uFB45\uFBB2-\uFBD2\uFD3E-\uFD4F\uFD90\uFD91\uFDC8-\uFDEF\uFDFC-\uFDFF\uFE10-\uFE1F\uFE30-\uFE32\uFE35-\uFE4C\uFE50-\uFE6F\uFE75\uFEFD-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF3E\uFF40\uFF5B-\uFF65\uFFBF-\uFFC1\uFFC8\uFFC9\uFFD0\uFFD1\uFFD8\uFFD9\uFFDD-\uFFFF]|\uD800[\uDC0C\uDC27\uDC3B\uDC3E\uDC4E\uDC4F\uDC5E-\uDC7F\uDCFB-\uDD3F\uDD75-\uDDFC\uDDFE-\uDE7F\uDE9D-\uDE9F\uDED1-\uDEDF\uDEE1-\uDEFF\uDF20-\uDF2C\uDF4B-\uDF4F\uDF7B-\uDF7F\uDF9E\uDF9F\uDFC4-\uDFC7\uDFD0\uDFD6-\uDFFF]|\uD801[\uDC9E\uDC9F\uDCAA-\uDCAF\uDCD4-\uDCD7\uDCFC-\uDCFF\uDD28-\uDD2F\uDD64-\uDDFF\uDF37-\uDF3F\uDF56-\uDF5F\uDF68-\uDFFF]|\uD802[\uDC06\uDC07\uDC09\uDC36\uDC39-\uDC3B\uDC3D\uDC3E\uDC56-\uDC5F\uDC77-\uDC7F\uDC9F-\uDCDF\uDCF3\uDCF6-\uDCFF\uDD16-\uDD1F\uDD3A-\uDD7F\uDDB8-\uDDBD\uDDC0-\uDDFF\uDE04\uDE07-\uDE0B\uDE14\uDE18\uDE36\uDE37\uDE3B-\uDE3E\uDE40-\uDE5F\uDE7D-\uDE7F\uDE9D-\uDEBF\uDEC8\uDEE7-\uDEFF\uDF36-\uDF3F\uDF56-\uDF5F\uDF73-\uDF7F\uDF92-\uDFFF]|\uD803[\uDC49-\uDC7F\uDCB3-\uDCBF\uDCF3-\uDCFF\uDD28-\uDD2F\uDD3A-\uDE7F\uDEAA\uDEAD-\uDEAF\uDEB2-\uDEFF\uDF1D-\uDF26\uDF28-\uDF2F\uDF51-\uDFAF\uDFC5-\uDFDF\uDFF7-\uDFFF]|\uD804[\uDC47-\uDC65\uDC70-\uDC7E\uDCBB-\uDCCF\uDCE9-\uDCEF\uDCFA-\uDCFF\uDD35\uDD40-\uDD43\uDD48-\uDD4F\uDD74\uDD75\uDD77-\uDD7F\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDFF\uDE12\uDE38-\uDE3D\uDE3F-\uDE7F\uDE87\uDE89\uDE8E\uDE9E\uDEA9-\uDEAF\uDEEB-\uDEEF\uDEFA-\uDEFF\uDF04\uDF0D\uDF0E\uDF11\uDF12\uDF29\uDF31\uDF34\uDF3A\uDF45\uDF46\uDF49\uDF4A\uDF4E\uDF4F\uDF51-\uDF56\uDF58-\uDF5C\uDF64\uDF65\uDF6D-\uDF6F\uDF75-\uDFFF]|\uD805[\uDC4B-\uDC4F\uDC5A-\uDC5D\uDC62-\uDC7F\uDCC6\uDCC8-\uDCCF\uDCDA-\uDD7F\uDDB6\uDDB7\uDDC1-\uDDD7\uDDDE-\uDDFF\uDE41-\uDE43\uDE45-\uDE4F\uDE5A-\uDE7F\uDEB9-\uDEBF\uDECA-\uDEFF\uDF1B\uDF1C\uDF2C-\uDF2F\uDF3A-\uDFFF]|\uD806[\uDC3B-\uDC9F\uDCEA-\uDCFE\uDD07\uDD08\uDD0A\uDD0B\uDD14\uDD17\uDD36\uDD39\uDD3A\uDD44-\uDD4F\uDD5A-\uDD9F\uDDA8\uDDA9\uDDD8\uDDD9\uDDE2\uDDE5-\uDDFF\uDE3F-\uDE46\uDE48-\uDE4F\uDE9A-\uDE9C\uDE9E-\uDEBF\uDEF9-\uDFFF]|\uD807[\uDC09\uDC37\uDC41-\uDC4F\uDC5A-\uDC71\uDC90\uDC91\uDCA8\uDCB7-\uDCFF\uDD07\uDD0A\uDD37-\uDD39\uDD3B\uDD3E\uDD48-\uDD4F\uDD5A-\uDD5F\uDD66\uDD69\uDD8F\uDD92\uDD99-\uDD9F\uDDAA-\uDEDF\uDEF7-\uDFAF\uDFB1-\uDFFF]|\uD808[\uDF9A-\uDFFF]|\uD809[\uDC6F-\uDC7F\uDD44-\uDFFF]|[\uD80A\uD80B\uD80E-\uD810\uD812-\uD819\uD824-\uD82B\uD82D\uD82E\uD830-\uD833\uD837\uD839\uD83D\uD83F\uD87B-\uD87D\uD87F\uD885-\uDB3F\uDB41-\uDBFF][\uDC00-\uDFFF]|\uD80D[\uDC2F-\uDFFF]|\uD811[\uDE47-\uDFFF]|\uD81A[\uDE39-\uDE3F\uDE5F\uDE6A-\uDECF\uDEEE\uDEEF\uDEF5-\uDEFF\uDF37-\uDF3F\uDF44-\uDF4F\uDF5A-\uDF62\uDF78-\uDF7C\uDF90-\uDFFF]|\uD81B[\uDC00-\uDE3F\uDE80-\uDEFF\uDF4B-\uDF4E\uDF88-\uDF8E\uDFA0-\uDFDF\uDFE2\uDFE5-\uDFEF\uDFF2-\uDFFF]|\uD821[\uDFF8-\uDFFF]|\uD823[\uDCD6-\uDCFF\uDD09-\uDFFF]|\uD82C[\uDD1F-\uDD4F\uDD53-\uDD63\uDD68-\uDD6F\uDEFC-\uDFFF]|\uD82F[\uDC6B-\uDC6F\uDC7D-\uDC7F\uDC89-\uDC8F\uDC9A-\uDC9C\uDC9F-\uDFFF]|\uD834[\uDC00-\uDD64\uDD6A-\uDD6C\uDD73-\uDD7A\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDE41\uDE45-\uDFFF]|\uD835[\uDC55\uDC9D\uDCA0\uDCA1\uDCA3\uDCA4\uDCA7\uDCA8\uDCAD\uDCBA\uDCBC\uDCC4\uDD06\uDD0B\uDD0C\uDD15\uDD1D\uDD3A\uDD3F\uDD45\uDD47-\uDD49\uDD51\uDEA6\uDEA7\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3\uDFCC\uDFCD]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85-\uDE9A\uDEA0\uDEB0-\uDFFF]|\uD838[\uDC07\uDC19\uDC1A\uDC22\uDC25\uDC2B-\uDCFF\uDD2D-\uDD2F\uDD3E\uDD3F\uDD4A-\uDD4D\uDD4F-\uDEBF\uDEFA-\uDFFF]|\uD83A[\uDCC5-\uDCCF\uDCD7-\uDCFF\uDD4C-\uDD4F\uDD5A-\uDFFF]|\uD83B[\uDC00-\uDDFF\uDE04\uDE20\uDE23\uDE25\uDE26\uDE28\uDE33\uDE38\uDE3A\uDE3C-\uDE41\uDE43-\uDE46\uDE48\uDE4A\uDE4C\uDE50\uDE53\uDE55\uDE56\uDE58\uDE5A\uDE5C\uDE5E\uDE60\uDE63\uDE65\uDE66\uDE6B\uDE73\uDE78\uDE7D\uDE7F\uDE8A\uDE9C-\uDEA0\uDEA4\uDEAA\uDEBC-\uDFFF]|\uD83C[\uDC00-\uDD2F\uDD4A-\uDD4F\uDD6A-\uDD6F\uDD8A-\uDFFF]|\uD83E[\uDC00-\uDFEF\uDFFA-\uDFFF]|\uD869[\uDEDE-\uDEFF]|\uD86D[\uDF35-\uDF3F]|\uD86E[\uDC1E\uDC1F]|\uD873[\uDEA2-\uDEAF]|\uD87A[\uDFE1-\uDFFF]|\uD87E[\uDE1E-\uDFFF]|\uD884[\uDF4B-\uDFFF]|\uDB40[\uDC00-\uDCFF\uDDF0-\uDFFF]/g

export function slugify(text: string): string {
  if (typeof text !== "string") return ""
  return text.toLowerCase().replace(GITHUB_SLUGGER_REGEX, "").replace(/ /g, "-")
}

// Mirrors orama-server/search-core.mjs:anchorFromHeadingText. Fumadocs'
// remark-heading parses an explicit-id suffix `## Title [#slug]` and uses
// the captured slug verbatim. Without this, slugifying the raw heading text
// of `## Installation [#installation]` yields `installation-installation`
// and citation deep-links don't land.
// TS target is ES2017 here, so named capture groups are unavailable —
// position-1 capture is functionally equivalent.
const EXPLICIT_ID = /\s*\[#([^\]]+)\]\s*$/
export function anchorFromHeadingText(text: string): string {
  if (typeof text !== "string") return ""
  const m = EXPLICIT_ID.exec(text)
  if (m && m[1]) return m[1]
  const cleaned = text.replace(/\s*\[[^\]]*\]\s*$/, "")
  return slugify(cleaned)
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ")
}

export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

export function meaningfulTokens(query: string, stopwords: Set<string>): string[] {
  const toks = tokenize(query)
  const kept = toks.filter(t => t.length > 1 && !stopwords.has(t))
  return kept.length > 0 ? kept : toks
}

/**
 * Token-shape heuristic for "this query token names a code identifier."
 * Stricter than the index-time `isSymbolLike` mirror would be — we must
 * exclude common TON-domain acronyms (TON, NFT, TVM, TEP, BFT, DAG, SBT)
 * and short camelCase brand names (iOS, FunC, dTON) that trigger false
 * positives on prose queries. Real code identifiers are:
 *   - snake_case / SCREAMING_SNAKE (must contain `_`),
 *   - `::`-scoped (FunC `op::transfer`, Tolk `cell::empty`),
 *   - longer camelCase (≥ 6 chars, e.g. `sendTon`, `loadRef`, `myAddr`),
 *   - dotted method access (`SendMode.PAY_GAS_SEPARATELY`).
 * Runs on the ORIGINAL token (before lowercasing). camelCase floor lowered
 * from 8 → 6 to catch the common short TON identifiers that the previous
 * threshold filtered out as brand-case noise.
 */
export function looksLikeCodeSymbol(t: string): boolean {
  if (t.length < 2 || t.length > 40) return false
  if (/^\d+$/.test(t)) return false
  if (t.includes("_")) return true
  if (t.includes("::")) return true
  if (t.includes(".") && /[a-zA-Z]/.test(t)) return true
  if (/[a-z][A-Z]/.test(t) && t.length >= 6) return true
  return false
}

// `bm25` is the max per-hit Orama relevance in the group, captured from the
// pass that first contributed the page (first-seen wins, mirroring `hits`).
// Grouped Orama results DO expose a numeric per-hit `score` (verified against
// the real fumadocs static index: each `group.result[]` element is
// `{id, score, document}`); the legacy pipeline simply never read it.
//
// First-seen, not max-across-passes: the "merge max" alternative is
// theoretically cleaner (the min-max normalization downstream would compare
// scores from comparable passes), but measured ΔMRR ≈ -0.005 on mined-test
// because the tolerance-1 fuzzy pass occasionally gives an irrelevant
// near-miss page a higher BM25 than its exact-match neighbors and that
// score then outranks the true target. The first-seen tie-break is
// effectively a "trust the exact pass over fuzzy" rule, which the corpus
// rewards. Keep this comment in sync with the FUTURE-WORK §9 "not worth"
// list if the alternative is re-considered.
type Grouped = {page: IndexedDoc; hits: IndexedDoc[]; bm25: number}

function collectGroups(
  db: AnyOrama,
  results: {groups?: {values: unknown[]; result: {score?: number; document: unknown}[]}[]},
  into: Map<string, Grouped>,
): void {
  for (const group of results.groups ?? []) {
    const pageId = String(group.values[0])
    if (into.has(pageId)) continue
    const page = getByID(db, pageId) as IndexedDoc | undefined
    if (!page) continue
    const hits: IndexedDoc[] = []
    let bm25 = 0
    for (const hit of group.result) {
      if (typeof hit.score === "number" && hit.score > bm25) bm25 = hit.score
      const doc = hit.document as IndexedDoc
      if (doc.type !== "page") hits.push(doc)
    }
    into.set(pageId, {page, hits, bm25})
  }
}

async function twoPassGroups(
  db: AnyOrama,
  term: string,
  relevance?: {k?: number; b?: number; d?: number},
): Promise<Map<string, Grouped>> {
  const groups = new Map<string, Grouped>()
  for (const tolerance of [0, 1]) {
    const res = (await search(db, {
      term,
      tolerance,
      limit: MAX_RESULTS,
      properties: ["content"],
      groupBy: {properties: ["page_id"], maxResult: HITS_PER_PAGE},
      ...(relevance ? {relevance} : {}),
    })) as unknown as {
      groups?: {values: unknown[]; result: {score?: number; document: unknown}[]}[]
    }
    collectGroups(db, res, groups)
  }
  return groups
}

/** True if every token appears (substring) in `text`. */
function containsAllTokens(text: string, tokens: string[]): boolean {
  for (const t of tokens) if (!text.includes(t)) return false
  return true
}

/**
 * Heuristic for "looks like a code symbol, not prose/keyword" — query side.
 * The index-side counterpart in app/api/search/route.ts is the case-sensitive
 * predicate that decided which raw code tokens to keep in the synthetic
 * `#Code symbols` block; this one decides at query time whether the user
 * typed something that *resembles* one of those tokens, so the structHit
 * bonus can fire on the right rows without firing on natural-language
 * queries. Tokens here are pre-lowercased (see `tokenize` above), so the
 * camelCase / ALLCAPS branches that the index-side predicate uses cannot
 * fire — relying instead on `_`, `::`, and the alnum-mix branch, which all
 * survive lowercasing. Drop in here if you ever change the indexer's
 * predicate; the two should agree on the "is this a code token?" question.
 */
function querySymbolLike(t: string): boolean {
  if (t.length < 2 || t.length > 40) return false
  if (/^\d+$/.test(t)) return false
  return (
    t.includes("_") || // snake_case, op_sendmsg (lowercased)
    t.includes("::") || // FunC/C++ scope, op::transfer
    /[a-z]\d|\d[a-z]/.test(t) // alnum mix, int257 / v3 / wallet5
  )
}

/**
 * Crude proximity: the smallest window (in characters) spanning a first
 * occurrence of every token. Returns Infinity if any token is missing. Lower
 * is tighter. Used only to award a bounded bonus to pages where the query
 * terms actually appear close together (e.g. an exact phrase) rather than
 * scattered across a long reference page.
 */
function proximitySpan(text: string, tokens: string[]): number {
  if (tokens.length < 2) return Infinity
  let lo = Infinity
  let hi = -Infinity
  for (const t of tokens) {
    const i = text.indexOf(t)
    if (i < 0) return Infinity
    lo = Math.min(lo, i)
    hi = Math.max(hi, i + t.length)
  }
  return hi - lo
}

export type RawResult = Omit<SortedResult, "content"> & {content: string; anchor?: string | null}

/**
 * Run the full relevance pipeline against a loaded Orama index and return
 * ranked, de-duplicated rows ready for presentation (no highlighting applied).
 *
 * Levers (all query-side unless noted), each independently ablatable via
 * `tuning`:
 *  1. stopword-stripped query (domain-aware list);
 *  2. optional exact-query pin -> force canonical page to #1;
 *  3. two Orama passes — exact (tolerance 0) then fuzzy (tolerance 1) —
 *     unioned by page, so typos keep recall without losing precision;
 *  4. low-recall spelling-correction fallback (gated, never unconditional);
 *  5. breadth: small per-page hit cap + large total cap so the re-rank can
 *     reach pages buried past rank ~10;
 *  6. re-rank distinct pages by query-term presence in title / breadcrumbs /
 *     URL, plus optional all-terms and proximity bonuses computed over the
 *     page's matched snippets — floats canonical pages above long,
 *     term-spammy reference pages.
 */
export async function runRankedSearch(
  db: AnyOrama,
  query: string,
  tuning: Tuning = DEFAULT_TUNING,
): Promise<{term: string; results: RawResult[]}> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return {term: "", results: []}

  const normalized = normalizeQuery(trimmed)
  let tokens = meaningfulTokens(trimmed, tuning.stopwords)
  // Mirror `meaningfulTokens` over the un-lowercased query so each token's
  // original casing is available for code-symbol shape detection (which is
  // case-sensitive — camelCase, ALLCAPS, snake_case all matter).
  const stopL = new Set([...tuning.stopwords].map(w => w.toLowerCase()))
  const rawSplit = trimmed.split(/\s+/).filter(Boolean)
  const rawKept = rawSplit.filter(t => t.length > 1 && !stopL.has(t.toLowerCase()))
  const originalTokens = rawKept.length > 0 ? rawKept : rawSplit
  const hasCodeShapedToken = originalTokens.some(looksLikeCodeSymbol)
  // Gate for `apiRefDemotion`: if the user typed "api" or "reference" we
  // assume they want the reference page and skip the demotion. Matches the
  // raw token set (before stopword strip) so the signal survives even when
  // surrounding words are stripped.
  const wantsReference = originalTokens.some(t => {
    const lt = t.toLowerCase()
    return lt === "api" || lt === "reference" || lt === "ref" || lt === "apis"
  })
  const term = tokens.join(" ")

  const groups = await twoPassGroups(db, term, tuning.relevance)

  // Spelling correction: if any token has a curated correction, union a second
  // pass on the corrected query and let the corrected tokens participate in
  // re-ranking. Additive only — never drops the original matches.
  if (Object.keys(tuning.spell).length > 0) {
    const corrected = tokens.map(t => tuning.spell[t] ?? t)
    if (corrected.some((t, i) => t !== tokens[i])) {
      const extra = await twoPassGroups(db, corrected.join(" "), tuning.relevance)
      for (const [k, v] of extra) if (!groups.has(k)) groups.set(k, v)
      tokens = Array.from(new Set([...tokens, ...corrected]))
    }
  }

  // Brand decompound: rewrite squashed compound brand tokens (`tonpay` →
  // `ton pay`) and union a pass on the split form. The tokenizer splits the
  // hyphenated URL slug into the same parts, so this is what lets a
  // multi-token query like `tonpay sdk` reach `/applications/ton-pay/*` —
  // the bare-token case is already covered by pins. Additive only.
  if (Object.keys(tuning.decompound).length > 0) {
    const expanded: string[] = []
    let didExpand = false
    for (const t of tokens) {
      const rewrite = tuning.decompound[t]
      if (rewrite) {
        for (const w of rewrite.split(/\s+/).filter(Boolean)) expanded.push(w)
        didExpand = true
      } else {
        expanded.push(t)
      }
    }
    if (didExpand) {
      const extra = await twoPassGroups(db, expanded.join(" "), tuning.relevance)
      for (const [k, v] of extra) if (!groups.has(k)) groups.set(k, v)
      tokens = Array.from(new Set([...tokens, ...expanded]))
    }
  }

  // Zero-result tolerance-2 retry. The harness previously found that ALWAYS
  // running tolerance:2 regressed (it floats wide-fuzzy near-misses over true
  // exact matches), but as a last-resort fallback when the [0,1] pass returns
  // nothing it gives some hits where the alternative is an empty page.
  // Mirrors orama-server/search-core.mjs:374-386 so the harness can score
  // exactly what production runs after the .mjs is reduced to a thin shim.
  if (groups.size === 0) {
    const res = (await search(db, {
      term,
      tolerance: 2,
      limit: MAX_RESULTS,
      properties: ["content"],
      groupBy: {properties: ["page_id"], maxResult: HITS_PER_PAGE},
      ...(tuning.relevance ? {relevance: tuning.relevance} : {}),
    })) as unknown as {
      groups?: {values: unknown[]; result: {score?: number; document: unknown}[]}[]
    }
    collectGroups(db, res, groups)
  }

  // Min-max BM25 normalization over the candidate set so the relevance term
  // is scale-free and the tuning weight is corpus-portable. Computed once
  // (not per-group) — `score()` reads `maxBm25` from this closure.
  let maxBm25 = 0
  for (const g of groups.values()) if (g.bm25 > maxBm25) maxBm25 = g.bm25
  // `queryNorm` is the user's meaningful query as TYPED — NOT the
  // post-spell-correction expansion. Used downstream for exact-title and
  // heading-phrase comparisons. The earlier code defined this as
  // `tokens.join(" ")` AFTER the spell-correction expansion, which broke
  // exact-title matching on misspelled queries (the comparison became
  // e.g. `"jetton" === "jeton jetton"` → never fires). `correctedQueryNorm`
  // is the spell-corrected variant for the same comparisons — so a page
  // titled "Jetton" matches a user's "jeton" via the corrected form.
  const queryNorm = term
  const correctedQueryNorm =
    Object.keys(tuning.spell).length > 0
      ? term
          .split(" ")
          .map(w => tuning.spell[w] ?? w)
          .join(" ")
      : term

  // Title-only BM25: optional second Orama pass restricted to `type:"page"`
  // rows (content = title). Returns per-page Orama relevance of the title
  // surface alone, which gives high IDF + small document length to rare
  // title tokens. Min-max normalized into [0, titleBM25Weight] so the
  // contribution is bounded the same way bm25Weight is.
  const titleBM25: Map<string, number> = new Map()
  let maxTitleBM25 = 0
  if (tuning.titleBM25Weight > 0) {
    const tRes = (await search(db, {
      term,
      tolerance: 0,
      properties: ["content"],
      where: {type: "page"},
      limit: MAX_RESULTS,
      ...(tuning.relevance ? {relevance: tuning.relevance} : {}),
    })) as unknown as {hits?: {score?: number; document: unknown}[]}
    for (const hit of tRes.hits ?? []) {
      const doc = hit.document as IndexedDoc
      if (typeof hit.score === "number") {
        const prev = titleBM25.get(doc.url) ?? 0
        if (hit.score > prev) titleBM25.set(doc.url, hit.score)
      }
    }
    for (const v of titleBM25.values()) if (v > maxTitleBM25) maxTitleBM25 = v
  }

  // Stem-aware re-rank: pre-compute per-token stem arrays + per-page stemmed
  // title / haystack / url word sets. Without this, the score function does
  // raw `title.includes("validating")` against a title "Validation" and
  // misses — even though Orama's index hit it via the shared stem ("valid").
  // We use word-equality on stems (not substring) so a title "Tokenomics"
  // doesn't spuriously absorb a "token" query (`includes` did).
  //
  // CRITICAL: each query token is stemmed INDIVIDUALLY (not via joined
  // `tokens.join(" ")`). Orama's English splitter splits on `::`, `@`, `.`
  // (e.g. "op::transfer" → ["op","transfer"]) and may filter empties; a
  // single joined pass produces an array whose length does not match
  // `tokens.length`, breaking positional alignment between `tokens[i]`
  // (raw) and the stem the score loop is meant to compare. Per-token
  // stemming keeps the i-th stem(s) attached to the i-th raw token.
  type StemEntry = {
    titleWords: Set<string>
    haystackWords: Set<string>
    urlWords: Set<string>
    titleStr: string
  }
  let tokenStems: string[][] = []
  let stemmedQueryStr = ""
  const stemCache = new Map<string, StemEntry>()
  // Stem cache is computed only for the K candidates most likely to land in
  // the visible top of the page list. The re-rank bonuses cap at ~10 per
  // group; pages further than ~25 down the BM25-ordered candidate set are
  // very unlikely to reach the visible top from a +10 boost, so paying for
  // 100+ stem calls is wasted work. We over-shoot K relative to the visible
  // ~5–10 to keep tiebreak quality.
  const STEM_TOP_K = 32
  if (tuning.stemReRank) {
    tokenStems = await Promise.all(tokens.map(t => stemString(t)))
    stemmedQueryStr = tokenStems.flat().join(" ")
    const topGroups = [...groups.entries()]
      .sort((a, b) => b[1].bm25 - a[1].bm25)
      .slice(0, STEM_TOP_K)
    await Promise.all(
      topGroups.map(async ([pageId, g]) => {
        const t = (g.page.content ?? "").toLowerCase()
        const bc = (g.page.breadcrumbs ?? []).join(" ").toLowerCase()
        // Split URL on slashes / hyphens / underscores so the stemmer sees real
        // words, not a single slug-soup token.
        const u = g.page.url
          .toLowerCase()
          .replace(/[/\-_#]+/g, " ")
          .trim()
        const [tw, hw, uw] = await Promise.all([
          stemString(t),
          stemString(`${t} ${bc} ${u}`),
          stemString(u),
        ])
        stemCache.set(pageId, {
          titleWords: new Set(tw),
          haystackWords: new Set(hw),
          urlWords: new Set(uw),
          titleStr: tw.join(" "),
        })
      }),
    )
  }

  const symbolTokens = tokens.filter(querySymbolLike)

  // Per-token IDF multipliers. Cheap: one zero-limit Orama search per
  // unique token to pull the row-level count. log((maxDf+1)/(df+1)) is
  // monotonic in rarity; clamped to [0.5, 2.5] so a single rare token
  // can't dominate the rerank. Computed once per query, not per group.
  const idfWeights = new Map<string, number>()
  if (tuning.idfWeightTokens) {
    const dfPairs = await Promise.all(
      tokens.map(async t => {
        const r = (await search(db, {
          term: t,
          tolerance: 0,
          properties: ["content"],
          limit: 0,
        })) as unknown as {count?: number}
        return [t, r.count ?? 0] as [string, number]
      }),
    )
    let maxDf = 0
    for (const [, df] of dfPairs) if (df > maxDf) maxDf = df
    for (const [t, df] of dfPairs) {
      const raw = Math.log((maxDf + 1) / (df + 1))
      idfWeights.set(t, Math.max(0.5, Math.min(2.5, raw)))
    }
  }

  const score = ({page, hits, bm25}: Grouped): number => {
    const title = (page.content ?? "").toLowerCase()
    const haystack = `${title} ${(page.breadcrumbs ?? []).join(" ")} ${page.url}`.toLowerCase()
    const url = page.url.toLowerCase()
    const sm = tuning.stemReRank ? stemCache.get(String(page.id)) : undefined
    let s = 0
    // Each surface (haystack/title/url) earns at most one bonus per token.
    // Stem-aware match wins; raw `includes` is the fallback so the lever can't
    // strictly regress recall on tokens the stemmer drops (single chars,
    // pure numerics) or doesn't normalize.
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      const stems = sm ? (tokenStems[i] ?? []) : []
      const stemHay = sm && stems.some(st => sm.haystackWords.has(st))
      const stemTitle = sm && stems.some(st => sm.titleWords.has(st))
      const stemUrl = sm && stems.some(st => sm.urlWords.has(st))
      const idf = tuning.idfWeightTokens ? (idfWeights.get(t) ?? 1) : 1
      if (stemHay || haystack.includes(t)) s += tuning.haystackWeight * idf
      if (stemTitle || title.includes(t)) s += tuning.titleWeight * idf
      if (stemUrl || url.includes(t)) s += tuning.urlWeight * idf
    }
    // Exact / prefix title preference. Substring `includes` ranks the page
    // titled "Wallet" and one titled "How wallets work" identically for the
    // query "wallet"; these bounded bonuses restore the canonical-title
    // preference users expect for navigational / exact intents. Under stem
    // mode, the comparison also fires when the stemmed forms align (e.g.
    // page "Tokens" / query "token", both stem to "token") so morphology
    // doesn't void the canonical-title preference.
    const titleTrim = title.trim()
    // Exact-title also fires on the spell-corrected query form: a user
    // typing "jeton" (which → "jetton" via spell) on a page titled
    // "Jetton" SHOULD earn the exact-title bonus. `queryNorm` is the
    // original typed term (NOT the expanded post-spell token union), and
    // we fall back to the corrected form here so spell correction
    // doesn't accidentally void the bonus it's supposed to enable.
    const titleExact =
      titleTrim === queryNorm ||
      titleTrim === correctedQueryNorm ||
      (sm && sm.titleStr.length > 0 && sm.titleStr === stemmedQueryStr)
    if (tuning.exactTitleWeight > 0 && titleExact) {
      s += tuning.exactTitleWeight
    } else if (
      tuning.titlePrefixWeight > 0 &&
      queryNorm.length > 0 &&
      (title.startsWith(queryNorm) || title.startsWith(correctedQueryNorm))
    ) {
      s += tuning.titlePrefixWeight
    }
    // Calibrated BM25 blend: a continuous relevance signal on top of the
    // coarse integer lexical heuristic. Bounded to [0, bm25Weight] so it
    // separates near-tied pages (the common case — many share the same
    // title/url token hits) without letting a long term-dense page outscore
    // a canonical one on relevance alone (measured to regress if unbounded).
    if (tuning.bm25Weight > 0 && maxBm25 > 0) {
      s += tuning.bm25Weight * (bm25 / maxBm25)
    }
    if (tuning.titleBM25Weight > 0 && maxTitleBM25 > 0) {
      const tb = titleBM25.get(page.url) ?? 0
      if (tb > 0) s += tuning.titleBM25Weight * (tb / maxTitleBM25)
    }
    if (tuning.structHitWeight > 0) {
      // Hand-curated `#Keywords` rows always count. `#Code symbols` rows only
      // count when at least one query token IS itself a symbol-like token (per
      // the same predicate the indexer uses to mine them) — that gate kills
      // the over-firing on natural-language queries (e.g. "wallet", "how to
      // deploy") that wrecked concept intent in the unconditional ablation.
      const curated = hits
        .filter(
          h =>
            h.url.endsWith("#Keywords") ||
            (symbolTokens.length > 0 && h.url.endsWith("#Code symbols")),
        )
        .map(h => (h.content ?? "").toLowerCase())
        .join(" ")
      if (curated) {
        for (const t of tokens) if (curated.includes(t)) s += tuning.structHitWeight
      }
      // `#Description` block: editor-curated prose summary of the page.
      // Lower-confidence than `#Keywords` (which is a deliberate synonym
      // list) but higher than arbitrary body text, so award half the
      // Keywords weight. No symbol-token gate — descriptions are prose.
      const descBag = hits
        .filter(h => h.url.endsWith("#Description"))
        .map(h => (h.content ?? "").toLowerCase())
        .join(" ")
      if (descBag) {
        const descW = tuning.structHitWeight / 2
        for (const t of tokens) if (descBag.includes(t)) s += descW
      }
    }
    if (tuning.headingMatchWeight > 0 && tokens.length > 0) {
      // Heading match: per-token bonus when a query token appears in any of
      // this page's heading rows (`type:"heading"`, content = the heading
      // text). Headings are a higher-signal surface than arbitrary body
      // paragraphs — a page with an H2 literally containing the user's
      // words is more likely the canonical answer than a page where the
      // same words appear in passing prose. Phrase-match (queryNorm in
      // heading) gets an extra tokens.length-weighted bonus so a tight
      // phrase hit dominates a scattered token hit. Accept both "heading"
      // (current fumadocs) and "head" (older index versions) to survive a
      // dependency downgrade.
      const headings = hits.filter(h => h.type === "heading" || h.type === "head")
      if (headings.length > 0) {
        let perTokenMatches = 0
        let phraseHit = false
        for (const h of headings) {
          const ht = (h.content ?? "").toLowerCase()
          if (
            !phraseHit &&
            queryNorm.length > 0 &&
            (ht.includes(queryNorm) || ht.includes(correctedQueryNorm))
          ) {
            phraseHit = true
          }
          for (const t of tokens) if (ht.includes(t)) perTokenMatches++
        }
        s += tuning.headingMatchWeight * perTokenMatches
        if (phraseHit) s += tuning.headingMatchWeight * tokens.length
      }
    }
    if (tuning.codeSymbolWeight > 0 && hasCodeShapedToken) {
      // Conditional code-symbol re-rank: fires ONLY when the query itself
      // contains a code-identifier-shaped token, so prose queries cannot
      // activate it (the regression mode of unconditional code-symbol
      // re-ranking). Awards per token, against lowercased symbol bag.
      const codeSyms = hits
        .filter(h => h.url.endsWith("#Code symbols"))
        .map(h => (h.content ?? "").toLowerCase())
        .join(" ")
      if (codeSyms) {
        for (const t of tokens) if (codeSyms.includes(t)) s += tuning.codeSymbolWeight
      }
    }
    if (tuning.allTermsWeight > 0 || tuning.proximityWeight > 0) {
      const snippets = hits.map(h => (h.content ?? "").toLowerCase())
      snippets.push(title)
      let allTerms = false
      let bestSpan = Infinity
      for (const sn of snippets) {
        if (!allTerms && containsAllTokens(sn, tokens)) allTerms = true
        const sp = proximitySpan(sn, tokens)
        if (sp < bestSpan) bestSpan = sp
      }
      if (allTerms) s += tuning.allTermsWeight
      // Tight co-occurrence (terms within ~80 chars) earns the full bonus,
      // decaying to zero by ~400 chars. Bounded so it tunes, not dominates.
      if (bestSpan !== Infinity) {
        const tightness = Math.max(0, 1 - Math.max(0, bestSpan - 80) / 320)
        s += tuning.proximityWeight * tightness
      }
    }
    // R4: down-rank pages whose frontmatter declares `tag: deprecated`.
    // Fumadocs' buildDocuments propagates `index.tag` onto every row as a
    // `tags: string[]` field, but the score function might also see a
    // scalar `tag` if callers attach it directly — read whichever is
    // present. Multiplier preserves relative ordering inside the
    // deprecated set so the most relevant deprecated page still wins
    // among its peers — it just sinks below comparably-relevant
    // non-deprecated alternatives.
    const pageAny = page as IndexedDoc & {tags?: string[]}
    const pageTags = Array.isArray(pageAny.tags)
      ? pageAny.tags
      : pageAny.tag
        ? [pageAny.tag]
        : []
    if (pageTags.includes("deprecated")) s *= 0.5
    // R5: down-rank API reference pages for prose queries. The symbol-dense
    // `/api-reference/ui-react` page out-scores the short canonical landing
    // for queries like "tonconnect quick start". Same multiplier shape as the
    // deprecated demotion — relative ordering inside the ref-page set is
    // preserved. Gated by !hasCodeShapedToken (skip if user typed an
    // identifier) and !wantsReference (skip if user typed "api"/"reference").
    if (tuning.apiRefDemotion < 1 && !hasCodeShapedToken && !wantsReference) {
      if (/\/(api-)?reference(\/|$)/.test(page.url)) s *= tuning.apiRefDemotion
    }
    return s
  }

  // Tiebreak: when the BM25 blend is active, residual score ties resolve by
  // raw relevance (then crawl order); otherwise exact legacy behavior
  // (crawl order only), so bm25Weight=0 is byte-identical to the prior ship.
  const ranked = [...groups.values()]
    .map((g, i) => ({g, i, s: score(g)}))
    .sort((a, b) => b.s - a.s || (tuning.bm25Weight > 0 ? b.g.bm25 - a.g.bm25 : 0) || a.i - b.i)
    .map(x => x.g)

  // Best-bet pin: if any of {raw normalized query, post-stopword term,
  // spell-corrected forms of either} is a curated navigational pin key,
  // move its canonical page to the very top (insert if the crawl missed
  // it). The post-stopword `term` lookup is what lets a natural-language
  // concept query like "what is a wallet" → term "wallet" → hit the
  // `wallet` pin even though the raw normalized form ("what is a wallet")
  // is not a pin key. The corrected forms let a misspelled brand query
  // like "what is a jeton" → "jetton" still resolve.
  const spellOf = (s: string): string =>
    s
      .split(" ")
      .map(w => tuning.spell[w] ?? w)
      .join(" ")
  const pinKeys = [normalized]
  if (term && term !== normalized) pinKeys.push(term)
  if (Object.keys(tuning.spell).length > 0) {
    for (const k of [...pinKeys]) {
      const c = spellOf(k)
      if (c !== k && !pinKeys.includes(c)) pinKeys.push(c)
    }
  }
  // Also try the decompounded form of every pin key, so `tonpay` → `ton pay`
  // hits the `"ton pay"` pin (and a future compound brand without an exact
  // squashed pin still resolves through the rewrite map).
  if (Object.keys(tuning.decompound).length > 0) {
    for (const k of [...pinKeys]) {
      const d = k
        .split(" ")
        .map(w => tuning.decompound[w] ?? w)
        .join(" ")
      if (d !== k && !pinKeys.includes(d)) pinKeys.push(d)
    }
  }
  let pinnedUrl: string | undefined
  for (const k of pinKeys) {
    if (tuning.pins[k]) {
      pinnedUrl = tuning.pins[k]
      break
    }
  }
  if (pinnedUrl) {
    const idx = ranked.findIndex(g => g.page.url === pinnedUrl)
    if (idx > 0) {
      const [pinned] = ranked.splice(idx, 1)
      ranked.unshift(pinned)
    } else if (idx < 0) {
      const doc = getByID(db, pinnedUrl) as IndexedDoc | undefined
      if (doc) ranked.unshift({page: doc, hits: [], bm25: 0})
    }
  }

  const raw: RawResult[] = []
  for (const {page, hits} of ranked) {
    raw.push({
      id: page.url,
      type: "page",
      content: page.content,
      breadcrumbs: page.breadcrumbs,
      url: page.url,
    })
    // Anchor on heading/text entries so the AI backend (and any other
    // consumer) can build section-precise citation URLs. Text hits inherit
    // the slug of the nearest preceding heading on the same page (null if
    // none yet). MUST match orama-server/search-core.mjs byte-for-byte —
    // `anchorFromHeadingText` mirrors the explicit-id-aware derivation
    // there so both rankers produce identical anchor strings.
    let currentAnchor: string | null = null
    // Same-page near-dup guard: chunkBlockContent emits overlapping windows
    // (200-char overlap), so two `text` hits on one page can share the same
    // opening sentence. We dedupe by the first 80 chars — enough to collapse
    // the overlap region without merging genuinely distinct passages.
    const seenTextPrefix = new Set<string>()
    for (const doc of hits) {
      const type = doc.type === "head" ? "heading" : doc.type
      let anchor: string | null = null
      if (type === "heading") {
        anchor = anchorFromHeadingText(doc.content ?? "") || null
        currentAnchor = anchor
      } else if (type === "text") {
        anchor = currentAnchor
        const prefix = (doc.content ?? "").trim().slice(0, 80)
        if (prefix.length > 0) {
          if (seenTextPrefix.has(prefix)) continue
          seenTextPrefix.add(prefix)
        }
      }
      raw.push({
        id: String(doc.id),
        // Index stores "head"; fumadocs' SortedResult/UI expects "heading".
        type,
        content: doc.content,
        breadcrumbs: doc.breadcrumbs,
        url: doc.url,
        anchor,
      })
    }
    if (raw.length >= MAX_RESULTS) break
  }

  return {term, results: raw.slice(0, MAX_RESULTS)}
}
