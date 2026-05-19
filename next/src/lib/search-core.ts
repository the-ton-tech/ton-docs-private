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

type Grouped = {page: IndexedDoc; hits: IndexedDoc[]}

function collectGroups(
  db: AnyOrama,
  results: {groups?: {values: unknown[]; result: {document: unknown}[]}[]},
  into: Map<string, Grouped>,
): void {
  for (const group of results.groups ?? []) {
    const pageId = String(group.values[0])
    if (into.has(pageId)) continue
    const page = getByID(db, pageId) as IndexedDoc | undefined
    if (!page) continue
    const hits: IndexedDoc[] = []
    for (const hit of group.result) {
      const doc = hit.document as IndexedDoc
      if (doc.type !== "page") hits.push(doc)
    }
    into.set(pageId, {page, hits})
  }
}

async function twoPassGroups(db: AnyOrama, term: string): Promise<Map<string, Grouped>> {
  const groups = new Map<string, Grouped>()
  for (const tolerance of [0, 1]) {
    const res = (await search(db, {
      term,
      tolerance,
      limit: MAX_RESULTS,
      properties: ["content"],
      groupBy: {properties: ["page_id"], maxResult: HITS_PER_PAGE},
    })) as unknown as {
      groups?: {values: unknown[]; result: {document: unknown}[]}[]
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
  const term = tokens.join(" ")

  const groups = await twoPassGroups(db, term)

  // Spelling correction: if any token has a curated correction, union a second
  // pass on the corrected query and let the corrected tokens participate in
  // re-ranking. Additive only — never drops the original matches.
  if (Object.keys(tuning.spell).length > 0) {
    const corrected = tokens.map(t => tuning.spell[t] ?? t)
    if (corrected.some((t, i) => t !== tokens[i])) {
      const extra = await twoPassGroups(db, corrected.join(" "))
      for (const [k, v] of extra) if (!groups.has(k)) groups.set(k, v)
      tokens = Array.from(new Set([...tokens, ...corrected]))
    }
  }

  const score = ({page, hits}: Grouped): number => {
    const title = (page.content ?? "").toLowerCase()
    const haystack = `${title} ${(page.breadcrumbs ?? []).join(" ")} ${page.url}`.toLowerCase()
    const url = page.url.toLowerCase()
    let s = 0
    for (const t of tokens) {
      if (haystack.includes(t)) s += tuning.haystackWeight
      if (title.includes(t)) s += tuning.titleWeight
      if (url.includes(t)) s += tuning.urlWeight
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

  const ranked = [...groups.values()]
    .map((g, i) => ({g, i, s: score(g)}))
    .sort((a, b) => b.s - a.s || a.i - b.i)
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
      if (doc) ranked.unshift({page: doc, hits: []})
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
