import {create, getByID, search, type AnyOrama} from "@orama/orama"
import type {SortedResult} from "fumadocs-core/search"

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
    components: {tokenizer: {language: "english", stemming: true}},
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
  // "head"/"text" rows (content = heading / paragraph) sharing a `page_id`.
  type: "page" | "head" | "text"
  content: string
  url: string
  breadcrumbs?: string[]
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
  glossary: "/foundations/glossary",
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
   * Per-token bonus when the term appears in a page's auto-mined `#Code
   * symbols` row AND the token *looks* like a code identifier (camelCase,
   * snake_case, ALLCAPS opcode, alnum mix, ::-scoped). Unconditional
   * code-symbol re-rank wrecked concept intent (measured), but
   * conditioning on token shape limits the bonus to queries that
   * actually mean a code symbol — the regressing prose queries can't
   * activate it. 0 disables.
   */
  codeSymbolWeight: number
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
  // Conditional code-symbol bonus: fires only when the query contains a
  // shape-real code identifier (underscore, ::-scope, dotted method, or
  // camelCase ≥ 8 chars). On gold (n=349) this adds +0.0057 hit@1,
  // +0.019 nDCG_g on identifier intent, with byte-identical curated /
  // mined-train / mined-test (the shape gate filters all binary-slice
  // queries out, so the lever can only help the new signal-rich gold
  // queries). The token-shape strictness is what avoids the previously
  // measured regression of unconditional code-symbol re-ranking.
  codeSymbolWeight: 1,
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
  codeSymbolWeight: 0,
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
 *   - longer camelCase (≥ 8 chars, e.g. `getAddressState`, `sendBatch`),
 *   - dotted method access (`SendMode.PAY_GAS_SEPARATELY`).
 * Runs on the ORIGINAL token (before lowercasing).
 */
export function looksLikeCodeSymbol(t: string): boolean {
  if (t.length < 2 || t.length > 40) return false
  if (/^\d+$/.test(t)) return false
  if (t.includes("_")) return true
  if (t.includes("::")) return true
  if (t.includes(".") && /[a-zA-Z]/.test(t)) return true
  if (/[a-z][A-Z]/.test(t) && t.length >= 8) return true
  return false
}

// `bm25` is the max per-hit Orama relevance in the group, captured from the
// pass that first contributed the page (first-seen wins, mirroring `hits`).
// Grouped Orama results DO expose a numeric per-hit `score` (verified against
// the real fumadocs static index: each `group.result[]` element is
// `{id, score, document}`); the legacy pipeline simply never read it.
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

export type RawResult = Omit<SortedResult, "content"> & {content: string}

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

  // Min-max BM25 normalization over the candidate set so the relevance term
  // is scale-free and the tuning weight is corpus-portable. Computed once
  // (not per-group) — `score()` reads `maxBm25` from this closure.
  let maxBm25 = 0
  for (const g of groups.values()) if (g.bm25 > maxBm25) maxBm25 = g.bm25
  const queryNorm = tokens.join(" ")

  const score = ({page, hits, bm25}: Grouped): number => {
    const title = (page.content ?? "").toLowerCase()
    const haystack = `${title} ${(page.breadcrumbs ?? []).join(" ")} ${page.url}`.toLowerCase()
    const url = page.url.toLowerCase()
    let s = 0
    for (const t of tokens) {
      if (haystack.includes(t)) s += tuning.haystackWeight
      if (title.includes(t)) s += tuning.titleWeight
      if (url.includes(t)) s += tuning.urlWeight
    }
    // Exact / prefix title preference. Substring `includes` ranks the page
    // titled "Wallet" and one titled "How wallets work" identically for the
    // query "wallet"; these bounded bonuses restore the canonical-title
    // preference users expect for navigational / exact intents.
    if (tuning.exactTitleWeight > 0 && title.trim() === queryNorm) {
      s += tuning.exactTitleWeight
    } else if (
      tuning.titlePrefixWeight > 0 &&
      queryNorm.length > 0 &&
      title.startsWith(queryNorm)
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
    if (tuning.structHitWeight > 0) {
      // Only the hand-curated `#Keywords` rows — NOT the 343 auto-mined
      // `#Code symbols` rows, which are too noisy for natural-language
      // queries (measured: rewarding them wrecked concept intent and hit@1).
      // Code symbols still aid recall/candidacy via Orama; they just don't
      // earn a re-rank bonus.
      const curated = hits
        .filter(h => h.url.endsWith("#Keywords"))
        .map(h => (h.content ?? "").toLowerCase())
        .join(" ")
      if (curated) {
        for (const t of tokens) if (curated.includes(t)) s += tuning.structHitWeight
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
    return s
  }

  // Tiebreak: when the BM25 blend is active, residual score ties resolve by
  // raw relevance (then crawl order); otherwise exact legacy behavior
  // (crawl order only), so bm25Weight=0 is byte-identical to the prior ship.
  const ranked = [...groups.values()]
    .map((g, i) => ({g, i, s: score(g)}))
    .sort((a, b) => b.s - a.s || (tuning.bm25Weight > 0 ? b.g.bm25 - a.g.bm25 : 0) || a.i - b.i)
    .map(x => x.g)

  // Best-bet pin: if the normalized query (or its spell-corrected form) is a
  // curated navigational query, move its canonical page to the very top
  // (insert if the crawl missed it). Checking the corrected form lets a
  // misspelled brand query like "jeton" still resolve to its landing page.
  const pinKeys = [normalized]
  if (Object.keys(tuning.spell).length > 0) {
    const corrected = normalized
      .split(" ")
      .map(w => tuning.spell[w] ?? w)
      .join(" ")
    if (corrected !== normalized) pinKeys.push(corrected)
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
    for (const doc of hits) {
      raw.push({
        id: String(doc.id),
        // Index stores "head"; fumadocs' SortedResult/UI expects "heading".
        type: doc.type === "head" ? "heading" : doc.type,
        content: doc.content,
        breadcrumbs: doc.breadcrumbs,
        url: doc.url,
      })
    }
    if (raw.length >= MAX_RESULTS) break
  }

  return {term, results: raw.slice(0, MAX_RESULTS)}
}
