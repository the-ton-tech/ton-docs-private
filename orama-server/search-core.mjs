// Server-side port of next/src/lib/search-core.ts.
//
// Algorithm is byte-identical with the client implementation so the offline
// eval harness scores still describe what users see. Only the imports change:
// no fumadocs-core/search (type-only on the client), no React.

import {create, getByID, search} from "@orama/orama"
import {tokenizer as oramaTokenizer} from "@orama/orama/components"

let stemTokenizerPromise
function getStemTokenizer() {
  return (stemTokenizerPromise ??= Promise.resolve(
    oramaTokenizer.createTokenizer({language: "english", stemming: true}),
  ))
}

async function stemString(s) {
  const tk = await getStemTokenizer()
  const out = await tk.tokenize(s)
  return Array.isArray(out) ? out : [String(out)]
}

export function createClientDB() {
  return create({
    schema: {_: "string"},
    sort: {enabled: false},
    components: {tokenizer: {language: "english", stemming: true, allowDuplicates: true}},
  })
}

export const MAX_RESULTS = 120
export const HITS_PER_PAGE = 3

export const DEFAULT_STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have how i in into is it its my no not of on or " +
    "that the their then there these this to was what when where which who why with you your " +
    "does could should would about over via using"
  ).split(" "),
)

export const DEFAULT_PINS = {
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

export const DEFAULT_SPELL = {
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
  valdiator: "validator",
  valdator: "validator",
  dictinary: "dictionary",
  dictionry: "dictionary",
  concensus: "consensus",
  consensous: "consensus",
}

export const DEFAULT_TUNING = {
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
  stemReRank: false,
  headingMatchWeight: 0.2,
  titleBM25Weight: 0,
  idfWeightTokens: false,
}

export function normalizeQuery(query) {
  return query.trim().toLowerCase().replace(/\s+/g, " ")
}

export function tokenize(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

export function meaningfulTokens(query, stopwords) {
  const toks = tokenize(query)
  const kept = toks.filter(t => t.length > 1 && !stopwords.has(t))
  return kept.length > 0 ? kept : toks
}

function collectGroups(db, results, into) {
  for (const group of results.groups ?? []) {
    const pageId = String(group.values[0])
    if (into.has(pageId)) continue
    const page = getByID(db, pageId)
    if (!page) continue
    const hits = []
    let bm25 = 0
    for (const hit of group.result) {
      if (typeof hit.score === "number" && hit.score > bm25) bm25 = hit.score
      const doc = hit.document
      if (doc.type !== "page") hits.push(doc)
    }
    into.set(pageId, {page, hits, bm25})
  }
}

async function twoPassGroups(db, term, relevance) {
  const groups = new Map()
  for (const tolerance of [0, 1]) {
    const res = await search(db, {
      term,
      tolerance,
      limit: MAX_RESULTS,
      properties: ["content"],
      groupBy: {properties: ["page_id"], maxResult: HITS_PER_PAGE},
      ...(relevance ? {relevance} : {}),
    })
    collectGroups(db, res, groups)
  }
  return groups
}

function containsAllTokens(text, tokens) {
  for (const t of tokens) if (!text.includes(t)) return false
  return true
}

function querySymbolLike(t) {
  if (t.length < 2 || t.length > 40) return false
  if (/^\d+$/.test(t)) return false
  return t.includes("_") || t.includes("::") || /[a-z]\d|\d[a-z]/.test(t)
}

function proximitySpan(text, tokens) {
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

export async function runRankedSearch(db, query, tuning = DEFAULT_TUNING) {
  const trimmed = query.trim()
  if (trimmed.length === 0) return {term: "", results: []}

  const normalized = normalizeQuery(trimmed)
  let tokens = meaningfulTokens(trimmed, tuning.stopwords)
  const term = tokens.join(" ")

  const groups = await twoPassGroups(db, term, tuning.relevance)

  if (Object.keys(tuning.spell).length > 0) {
    const corrected = tokens.map(t => tuning.spell[t] ?? t)
    if (corrected.some((t, i) => t !== tokens[i])) {
      const extra = await twoPassGroups(db, corrected.join(" "), tuning.relevance)
      for (const [k, v] of extra) if (!groups.has(k)) groups.set(k, v)
      tokens = Array.from(new Set([...tokens, ...corrected]))
    }
  }

  let maxBm25 = 0
  for (const g of groups.values()) if (g.bm25 > maxBm25) maxBm25 = g.bm25
  const queryNorm = term
  const correctedQueryNorm =
    Object.keys(tuning.spell).length > 0
      ? term
          .split(" ")
          .map(w => tuning.spell[w] ?? w)
          .join(" ")
      : term

  const titleBM25 = new Map()
  let maxTitleBM25 = 0
  if (tuning.titleBM25Weight > 0) {
    const tRes = await search(db, {
      term,
      tolerance: 0,
      properties: ["content"],
      where: {type: "page"},
      limit: MAX_RESULTS,
      ...(tuning.relevance ? {relevance: tuning.relevance} : {}),
    })
    for (const hit of tRes.hits ?? []) {
      const doc = hit.document
      if (typeof hit.score === "number") {
        const prev = titleBM25.get(doc.url) ?? 0
        if (hit.score > prev) titleBM25.set(doc.url, hit.score)
      }
    }
    for (const v of titleBM25.values()) if (v > maxTitleBM25) maxTitleBM25 = v
  }

  let tokenStems = []
  let stemmedQueryStr = ""
  const stemCache = new Map()
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
        const u = g.page.url.toLowerCase().replace(/[/\-_#]+/g, " ").trim()
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

  const idfWeights = new Map()
  if (tuning.idfWeightTokens) {
    const dfPairs = await Promise.all(
      tokens.map(async t => {
        const r = await search(db, {
          term: t,
          tolerance: 0,
          properties: ["content"],
          limit: 0,
        })
        return [t, r.count ?? 0]
      }),
    )
    let maxDf = 0
    for (const [, df] of dfPairs) if (df > maxDf) maxDf = df
    for (const [t, df] of dfPairs) {
      const raw = Math.log((maxDf + 1) / (df + 1))
      idfWeights.set(t, Math.max(0.5, Math.min(2.5, raw)))
    }
  }

  const score = ({page, hits, bm25}) => {
    const title = (page.content ?? "").toLowerCase()
    const haystack = `${title} ${(page.breadcrumbs ?? []).join(" ")} ${page.url}`.toLowerCase()
    const url = page.url.toLowerCase()
    const sm = tuning.stemReRank ? stemCache.get(String(page.id)) : undefined
    let s = 0
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      const stems = sm ? tokenStems[i] ?? [] : []
      const stemHay = sm && stems.some(st => sm.haystackWords.has(st))
      const stemTitle = sm && stems.some(st => sm.titleWords.has(st))
      const stemUrl = sm && stems.some(st => sm.urlWords.has(st))
      const idf = tuning.idfWeightTokens ? (idfWeights.get(t) ?? 1) : 1
      if (stemHay || haystack.includes(t)) s += tuning.haystackWeight * idf
      if (stemTitle || title.includes(t)) s += tuning.titleWeight * idf
      if (stemUrl || url.includes(t)) s += tuning.urlWeight * idf
    }
    const titleTrim = title.trim()
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
    if (tuning.bm25Weight > 0 && maxBm25 > 0) {
      s += tuning.bm25Weight * (bm25 / maxBm25)
    }
    if (tuning.titleBM25Weight > 0 && maxTitleBM25 > 0) {
      const tb = titleBM25.get(page.url) ?? 0
      if (tb > 0) s += tuning.titleBM25Weight * (tb / maxTitleBM25)
    }
    if (tuning.structHitWeight > 0) {
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
    }
    if (tuning.headingMatchWeight > 0 && tokens.length > 0) {
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
      if (bestSpan !== Infinity) {
        const tightness = Math.max(0, 1 - Math.max(0, bestSpan - 80) / 320)
        s += tuning.proximityWeight * tightness
      }
    }
    return s
  }

  const ranked = [...groups.values()]
    .map((g, i) => ({g, i, s: score(g)}))
    .sort((a, b) => b.s - a.s || (tuning.bm25Weight > 0 ? b.g.bm25 - a.g.bm25 : 0) || a.i - b.i)
    .map(x => x.g)

  const spellOf = s =>
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
  let pinnedUrl
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
      const doc = getByID(db, pinnedUrl)
      if (doc) ranked.unshift({page: doc, hits: [], bm25: 0})
    }
  }

  const raw = []
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
