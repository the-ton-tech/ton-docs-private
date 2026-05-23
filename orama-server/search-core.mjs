// Server-side port of next/src/lib/search-core.ts.
//
// Shared with the client implementation: the index schema/tokenizer config
// (`createClientDB`), the full ranking pipeline (`runRankedSearch`), tuning
// constants (`DEFAULT_STOPWORDS`, `DEFAULT_PINS`, `DEFAULT_SPELL`,
// `DEFAULT_TUNING`), and helpers (`normalizeQuery`, `tokenize`,
// `meaningfulTokens`, `looksLikeCodeSymbol`). Same query → same ranked
// page order as the docs site, so the offline eval harness scores still
// describe what users see and the AI backend's developer-heavy traffic
// gets the same code-symbol-aware ranking.
//
// Intentional differences from the .ts source:
//  - imports: no fumadocs-core/search (a client type-only dep) and no React;
//  - no `BASELINE_TUNING` (harness-only, lives in next/scripts/search-eval);
//  - no `IndexedDoc` / `Tuning` / `RawResult` types (plain JS, runtime shape
//    is identical and is what the HTTP response exposes — see server.mjs).
// If you tune `next/src/lib/search-core.ts`, mirror the lever here.

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
  glossary: "/overview/learn-more/glossary",
  appkit: "/applications/appkit/overview",
  "app kit": "/applications/appkit/overview",
  walletkit: "/applications/walletkit/overview",
  "wallet kit": "/applications/walletkit/overview",
  mcp: "/overview/ai/mcp",
  tonpay: "/applications/ton-pay/overview",
  "ton pay": "/applications/ton-pay/overview",
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

export const DEFAULT_DECOMPOUND = {
  tonpay: "ton pay",
  tonconnect: "ton connect",
}

export const DEFAULT_TUNING = {
  stopwords: DEFAULT_STOPWORDS,
  pins: DEFAULT_PINS,
  spell: DEFAULT_SPELL,
  decompound: DEFAULT_DECOMPOUND,
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
  // codeSymbolWeight: conditional code-symbol bonus, fires only when the
  // query contains a shape-real code identifier (underscore, ::-scope,
  // dotted method, or camelCase ≥ 8 chars). Adds +0.0057 hit@1 on gold
  // identifier intent with byte-identical curated/mined-train/mined-test.
  // The shape gate is what avoids the previously measured regression of
  // unconditional code-symbol re-ranking.
  codeSymbolWeight: 1,
  // apiRefDemotion: 0.80 picked by harness sweep (Pareto knee). Multiply
  // score by this when the page URL is an API reference (`/api-reference/`
  // or `/reference/`) AND the query has no code-shaped token AND no
  // explicit `api`/`reference` token. 1.0 disables. Mirrors
  // next/src/lib/search-core.ts.
  apiRefDemotion: 0.8,
}

export function normalizeQuery(query) {
  return query.trim().toLowerCase().replace(/\s+/g, " ")
}

// Vendored from `github-slugger` v2.0.0 (`regex.js`). The docs site renders
// headings via fumadocs-core's remark-heading, which uses github-slugger to
// compute heading ids. We MUST produce byte-identical slugs here so anchor
// citations the model emits round-trip with the actual `<h*>` ids in the
// browser DOM. The character class is auto-generated upstream from Unicode
// data; do not hand-edit. Preserves underscores and CJK/Cyrillic letters,
// strips punctuation/symbols, leaves hyphens uncollapsed.
// eslint-disable-next-line no-control-regex, no-misleading-character-class, no-useless-escape
const GITHUB_SLUGGER_REGEX =
  /[\0-\x1F!-,\.\/:-@\[-\^`\{-\xA9\xAB-\xB4\xB6-\xB9\xBB-\xBF\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0378\u0379\u037E\u0380-\u0385\u0387\u038B\u038D\u03A2\u03F6\u0482\u0530\u0557\u0558\u055A-\u055F\u0589-\u0590\u05BE\u05C0\u05C3\u05C6\u05C8-\u05CF\u05EB-\u05EE\u05F3-\u060F\u061B-\u061F\u066A-\u066D\u06D4\u06DD\u06DE\u06E9\u06FD\u06FE\u0700-\u070F\u074B\u074C\u07B2-\u07BF\u07F6-\u07F9\u07FB\u07FC\u07FE\u07FF\u082E-\u083F\u085C-\u085F\u086B-\u089F\u08B5\u08C8-\u08D2\u08E2\u0964\u0965\u0970\u0984\u098D\u098E\u0991\u0992\u09A9\u09B1\u09B3-\u09B5\u09BA\u09BB\u09C5\u09C6\u09C9\u09CA\u09CF-\u09D6\u09D8-\u09DB\u09DE\u09E4\u09E5\u09F2-\u09FB\u09FD\u09FF\u0A00\u0A04\u0A0B-\u0A0E\u0A11\u0A12\u0A29\u0A31\u0A34\u0A37\u0A3A\u0A3B\u0A3D\u0A43-\u0A46\u0A49\u0A4A\u0A4E-\u0A50\u0A52-\u0A58\u0A5D\u0A5F-\u0A65\u0A76-\u0A80\u0A84\u0A8E\u0A92\u0AA9\u0AB1\u0AB4\u0ABA\u0ABB\u0AC6\u0ACA\u0ACE\u0ACF\u0AD1-\u0ADF\u0AE4\u0AE5\u0AF0-\u0AF8\u0B00\u0B04\u0B0D\u0B0E\u0B11\u0B12\u0B29\u0B31\u0B34\u0B3A\u0B3B\u0B45\u0B46\u0B49\u0B4A\u0B4E-\u0B54\u0B58-\u0B5B\u0B5E\u0B64\u0B65\u0B70\u0B72-\u0B81\u0B84\u0B8B-\u0B8D\u0B91\u0B96-\u0B98\u0B9B\u0B9D\u0BA0-\u0BA2\u0BA5-\u0BA7\u0BAB-\u0BAD\u0BBA-\u0BBD\u0BC3-\u0BC5\u0BC9\u0BCE\u0BCF\u0BD1-\u0BD6\u0BD8-\u0BE5\u0BF0-\u0BFF\u0C0D\u0C11\u0C29\u0C3A-\u0C3C\u0C45\u0C49\u0C4E-\u0C54\u0C57\u0C5B-\u0C5F\u0C64\u0C65\u0C70-\u0C7F\u0C84\u0C8D\u0C91\u0CA9\u0CB4\u0CBA\u0CBB\u0CC5\u0CC9\u0CCE-\u0CD4\u0CD7-\u0CDD\u0CDF\u0CE4\u0CE5\u0CF0\u0CF3-\u0CFF\u0D0D\u0D11\u0D45\u0D49\u0D4F-\u0D53\u0D58-\u0D5E\u0D64\u0D65\u0D70-\u0D79\u0D80\u0D84\u0D97-\u0D99\u0DB2\u0DBC\u0DBE\u0DBF\u0DC7-\u0DC9\u0DCB-\u0DCE\u0DD5\u0DD7\u0DE0-\u0DE5\u0DF0\u0DF1\u0DF4-\u0E00\u0E3B-\u0E3F\u0E4F\u0E5A-\u0E80\u0E83\u0E85\u0E8B\u0EA4\u0EA6\u0EBE\u0EBF\u0EC5\u0EC7\u0ECE\u0ECF\u0EDA\u0EDB\u0EE0-\u0EFF\u0F01-\u0F17\u0F1A-\u0F1F\u0F2A-\u0F34\u0F36\u0F38\u0F3A-\u0F3D\u0F48\u0F6D-\u0F70\u0F85\u0F98\u0FBD-\u0FC5\u0FC7-\u0FFF\u104A-\u104F\u109E\u109F\u10C6\u10C8-\u10CC\u10CE\u10CF\u10FB\u1249\u124E\u124F\u1257\u1259\u125E\u125F\u1289\u128E\u128F\u12B1\u12B6\u12B7\u12BF\u12C1\u12C6\u12C7\u12D7\u1311\u1316\u1317\u135B\u135C\u1360-\u137F\u1390-\u139F\u13F6\u13F7\u13FE-\u1400\u166D\u166E\u1680\u169B-\u169F\u16EB-\u16ED\u16F9-\u16FF\u170D\u1715-\u171F\u1735-\u173F\u1754-\u175F\u176D\u1771\u1774-\u177F\u17D4-\u17D6\u17D8-\u17DB\u17DE\u17DF\u17EA-\u180A\u180E\u180F\u181A-\u181F\u1879-\u187F\u18AB-\u18AF\u18F6-\u18FF\u191F\u192C-\u192F\u193C-\u1945\u196E\u196F\u1975-\u197F\u19AC-\u19AF\u19CA-\u19CF\u19DA-\u19FF\u1A1C-\u1A1F\u1A5F\u1A7D\u1A7E\u1A8A-\u1A8F\u1A9A-\u1AA6\u1AA8-\u1AAF\u1AC1-\u1AFF\u1B4C-\u1B4F\u1B5A-\u1B6A\u1B74-\u1B7F\u1BF4-\u1BFF\u1C38-\u1C3F\u1C4A-\u1C4C\u1C7E\u1C7F\u1C89-\u1C8F\u1CBB\u1CBC\u1CC0-\u1CCF\u1CD3\u1CFB-\u1CFF\u1DFA\u1F16\u1F17\u1F1E\u1F1F\u1F46\u1F47\u1F4E\u1F4F\u1F58\u1F5A\u1F5C\u1F5E\u1F7E\u1F7F\u1FB5\u1FBD\u1FBF-\u1FC1\u1FC5\u1FCD-\u1FCF\u1FD4\u1FD5\u1FDC-\u1FDF\u1FED-\u1FF1\u1FF5\u1FFD-\u203E\u2041-\u2053\u2055-\u2070\u2072-\u207E\u2080-\u208F\u209D-\u20CF\u20F1-\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F-\u215F\u2189-\u24B5\u24EA-\u2BFF\u2C2F\u2C5F\u2CE5-\u2CEA\u2CF4-\u2CFF\u2D26\u2D28-\u2D2C\u2D2E\u2D2F\u2D68-\u2D6E\u2D70-\u2D7E\u2D97-\u2D9F\u2DA7\u2DAF\u2DB7\u2DBF\u2DC7\u2DCF\u2DD7\u2DDF\u2E00-\u2E2E\u2E30-\u3004\u3008-\u3020\u3030\u3036\u3037\u303D-\u3040\u3097\u3098\u309B\u309C\u30A0\u30FB\u3100-\u3104\u3130\u318F-\u319F\u31C0-\u31EF\u3200-\u33FF\u4DC0-\u4DFF\u9FFD-\u9FFF\uA48D-\uA4CF\uA4FE\uA4FF\uA60D-\uA60F\uA62C-\uA63F\uA673\uA67E\uA6F2-\uA716\uA720\uA721\uA789\uA78A\uA7C0\uA7C1\uA7CB-\uA7F4\uA828-\uA82B\uA82D-\uA83F\uA874-\uA87F\uA8C6-\uA8CF\uA8DA-\uA8DF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA954-\uA95F\uA97D-\uA97F\uA9C1-\uA9CE\uA9DA-\uA9DF\uA9FF\uAA37-\uAA3F\uAA4E\uAA4F\uAA5A-\uAA5F\uAA77-\uAA79\uAAC3-\uAADA\uAADE\uAADF\uAAF0\uAAF1\uAAF7-\uAB00\uAB07\uAB08\uAB0F\uAB10\uAB17-\uAB1F\uAB27\uAB2F\uAB5B\uAB6A-\uAB6F\uABEB\uABEE\uABEF\uABFA-\uABFF\uD7A4-\uD7AF\uD7C7-\uD7CA\uD7FC-\uD7FF\uE000-\uF8FF\uFA6E\uFA6F\uFADA-\uFAFF\uFB07-\uFB12\uFB18-\uFB1C\uFB29\uFB37\uFB3D\uFB3F\uFB42\uFB45\uFBB2-\uFBD2\uFD3E-\uFD4F\uFD90\uFD91\uFDC8-\uFDEF\uFDFC-\uFDFF\uFE10-\uFE1F\uFE30-\uFE32\uFE35-\uFE4C\uFE50-\uFE6F\uFE75\uFEFD-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF3E\uFF40\uFF5B-\uFF65\uFFBF-\uFFC1\uFFC8\uFFC9\uFFD0\uFFD1\uFFD8\uFFD9\uFFDD-\uFFFF]|\uD800[\uDC0C\uDC27\uDC3B\uDC3E\uDC4E\uDC4F\uDC5E-\uDC7F\uDCFB-\uDD3F\uDD75-\uDDFC\uDDFE-\uDE7F\uDE9D-\uDE9F\uDED1-\uDEDF\uDEE1-\uDEFF\uDF20-\uDF2C\uDF4B-\uDF4F\uDF7B-\uDF7F\uDF9E\uDF9F\uDFC4-\uDFC7\uDFD0\uDFD6-\uDFFF]|\uD801[\uDC9E\uDC9F\uDCAA-\uDCAF\uDCD4-\uDCD7\uDCFC-\uDCFF\uDD28-\uDD2F\uDD64-\uDDFF\uDF37-\uDF3F\uDF56-\uDF5F\uDF68-\uDFFF]|\uD802[\uDC06\uDC07\uDC09\uDC36\uDC39-\uDC3B\uDC3D\uDC3E\uDC56-\uDC5F\uDC77-\uDC7F\uDC9F-\uDCDF\uDCF3\uDCF6-\uDCFF\uDD16-\uDD1F\uDD3A-\uDD7F\uDDB8-\uDDBD\uDDC0-\uDDFF\uDE04\uDE07-\uDE0B\uDE14\uDE18\uDE36\uDE37\uDE3B-\uDE3E\uDE40-\uDE5F\uDE7D-\uDE7F\uDE9D-\uDEBF\uDEC8\uDEE7-\uDEFF\uDF36-\uDF3F\uDF56-\uDF5F\uDF73-\uDF7F\uDF92-\uDFFF]|\uD803[\uDC49-\uDC7F\uDCB3-\uDCBF\uDCF3-\uDCFF\uDD28-\uDD2F\uDD3A-\uDE7F\uDEAA\uDEAD-\uDEAF\uDEB2-\uDEFF\uDF1D-\uDF26\uDF28-\uDF2F\uDF51-\uDFAF\uDFC5-\uDFDF\uDFF7-\uDFFF]|\uD804[\uDC47-\uDC65\uDC70-\uDC7E\uDCBB-\uDCCF\uDCE9-\uDCEF\uDCFA-\uDCFF\uDD35\uDD40-\uDD43\uDD48-\uDD4F\uDD74\uDD75\uDD77-\uDD7F\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDFF\uDE12\uDE38-\uDE3D\uDE3F-\uDE7F\uDE87\uDE89\uDE8E\uDE9E\uDEA9-\uDEAF\uDEEB-\uDEEF\uDEFA-\uDEFF\uDF04\uDF0D\uDF0E\uDF11\uDF12\uDF29\uDF31\uDF34\uDF3A\uDF45\uDF46\uDF49\uDF4A\uDF4E\uDF4F\uDF51-\uDF56\uDF58-\uDF5C\uDF64\uDF65\uDF6D-\uDF6F\uDF75-\uDFFF]|\uD805[\uDC4B-\uDC4F\uDC5A-\uDC5D\uDC62-\uDC7F\uDCC6\uDCC8-\uDCCF\uDCDA-\uDD7F\uDDB6\uDDB7\uDDC1-\uDDD7\uDDDE-\uDDFF\uDE41-\uDE43\uDE45-\uDE4F\uDE5A-\uDE7F\uDEB9-\uDEBF\uDECA-\uDEFF\uDF1B\uDF1C\uDF2C-\uDF2F\uDF3A-\uDFFF]|\uD806[\uDC3B-\uDC9F\uDCEA-\uDCFE\uDD07\uDD08\uDD0A\uDD0B\uDD14\uDD17\uDD36\uDD39\uDD3A\uDD44-\uDD4F\uDD5A-\uDD9F\uDDA8\uDDA9\uDDD8\uDDD9\uDDE2\uDDE5-\uDDFF\uDE3F-\uDE46\uDE48-\uDE4F\uDE9A-\uDE9C\uDE9E-\uDEBF\uDEF9-\uDFFF]|\uD807[\uDC09\uDC37\uDC41-\uDC4F\uDC5A-\uDC71\uDC90\uDC91\uDCA8\uDCB7-\uDCFF\uDD07\uDD0A\uDD37-\uDD39\uDD3B\uDD3E\uDD48-\uDD4F\uDD5A-\uDD5F\uDD66\uDD69\uDD8F\uDD92\uDD99-\uDD9F\uDDAA-\uDEDF\uDEF7-\uDFAF\uDFB1-\uDFFF]|\uD808[\uDF9A-\uDFFF]|\uD809[\uDC6F-\uDC7F\uDD44-\uDFFF]|[\uD80A\uD80B\uD80E-\uD810\uD812-\uD819\uD824-\uD82B\uD82D\uD82E\uD830-\uD833\uD837\uD839\uD83D\uD83F\uD87B-\uD87D\uD87F\uD885-\uDB3F\uDB41-\uDBFF][\uDC00-\uDFFF]|\uD80D[\uDC2F-\uDFFF]|\uD811[\uDE47-\uDFFF]|\uD81A[\uDE39-\uDE3F\uDE5F\uDE6A-\uDECF\uDEEE\uDEEF\uDEF5-\uDEFF\uDF37-\uDF3F\uDF44-\uDF4F\uDF5A-\uDF62\uDF78-\uDF7C\uDF90-\uDFFF]|\uD81B[\uDC00-\uDE3F\uDE80-\uDEFF\uDF4B-\uDF4E\uDF88-\uDF8E\uDFA0-\uDFDF\uDFE2\uDFE5-\uDFEF\uDFF2-\uDFFF]|\uD821[\uDFF8-\uDFFF]|\uD823[\uDCD6-\uDCFF\uDD09-\uDFFF]|\uD82C[\uDD1F-\uDD4F\uDD53-\uDD63\uDD68-\uDD6F\uDEFC-\uDFFF]|\uD82F[\uDC6B-\uDC6F\uDC7D-\uDC7F\uDC89-\uDC8F\uDC9A-\uDC9C\uDC9F-\uDFFF]|\uD834[\uDC00-\uDD64\uDD6A-\uDD6C\uDD73-\uDD7A\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDE41\uDE45-\uDFFF]|\uD835[\uDC55\uDC9D\uDCA0\uDCA1\uDCA3\uDCA4\uDCA7\uDCA8\uDCAD\uDCBA\uDCBC\uDCC4\uDD06\uDD0B\uDD0C\uDD15\uDD1D\uDD3A\uDD3F\uDD45\uDD47-\uDD49\uDD51\uDEA6\uDEA7\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3\uDFCC\uDFCD]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85-\uDE9A\uDEA0\uDEB0-\uDFFF]|\uD838[\uDC07\uDC19\uDC1A\uDC22\uDC25\uDC2B-\uDCFF\uDD2D-\uDD2F\uDD3E\uDD3F\uDD4A-\uDD4D\uDD4F-\uDEBF\uDEFA-\uDFFF]|\uD83A[\uDCC5-\uDCCF\uDCD7-\uDCFF\uDD4C-\uDD4F\uDD5A-\uDFFF]|\uD83B[\uDC00-\uDDFF\uDE04\uDE20\uDE23\uDE25\uDE26\uDE28\uDE33\uDE38\uDE3A\uDE3C-\uDE41\uDE43-\uDE46\uDE48\uDE4A\uDE4C\uDE50\uDE53\uDE55\uDE56\uDE58\uDE5A\uDE5C\uDE5E\uDE60\uDE63\uDE65\uDE66\uDE6B\uDE73\uDE78\uDE7D\uDE7F\uDE8A\uDE9C-\uDEA0\uDEA4\uDEAA\uDEBC-\uDFFF]|\uD83C[\uDC00-\uDD2F\uDD4A-\uDD4F\uDD6A-\uDD6F\uDD8A-\uDFFF]|\uD83E[\uDC00-\uDFEF\uDFFA-\uDFFF]|\uD869[\uDEDE-\uDEFF]|\uD86D[\uDF35-\uDF3F]|\uD86E[\uDC1E\uDC1F]|\uD873[\uDEA2-\uDEAF]|\uD87A[\uDFE1-\uDFFF]|\uD87E[\uDE1E-\uDFFF]|\uD884[\uDF4B-\uDFFF]|\uDB40[\uDC00-\uDCFF\uDDF0-\uDFFF]/g

// Anchor links must round-trip with the docs site's heading ids. The site
// renders headings via fumadocs-core, which uses github-slugger; we mirror
// its exact rule here. Underscores are preserved (so `get_method` stays
// `get_method`, NOT `get-method`) and Cyrillic/CJK letters survive intact.
// Symbol-only headings legitimately slug to "" — server.mjs treats that as
// "no anchor" rather than colliding all such headings on the empty key.
export function slugify(text) {
  if (typeof text !== "string") return ""
  return text.toLowerCase().replace(GITHUB_SLUGGER_REGEX, "").replace(/ /g, "-")
}

// Fumadocs' remark-heading parses an explicit-id suffix `## Title [#slug]` and
// uses the captured slug verbatim as the heading id (no further slugifying).
// 5,876 headings in the rendered llms.mdx corpus use this form, so deriving
// an anchor by `slugify(rawHeadingText)` produces broken keys like
// `installation-installation` that no real anchor in the DOM matches. This
// helper mirrors the fumadocs rule: if the trailing `[#…]` exists, return the
// captured slug as-is; otherwise strip any other trailing `[…]` content
// (footnote refs etc.) and slugify the cleaned text.
const EXPLICIT_ID = /\s*\[#(?<slug>[^\]]+)\]\s*$/
export function anchorFromHeadingText(text) {
  if (typeof text !== "string") return ""
  const m = EXPLICIT_ID.exec(text)
  if (m && m.groups && m.groups.slug) return m.groups.slug
  const cleaned = text.replace(/\s*\[[^\]]*\]\s*$/, "")
  return slugify(cleaned)
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

// Stricter than `querySymbolLike`: runs on the ORIGINAL (case-preserving)
// token and gates the conditional `codeSymbolWeight` re-rank. Real code
// identifiers are snake_case (`_`), `::`-scoped (`op::transfer`), longer
// camelCase (≥ 6 chars), or dotted method access (`SendMode.PAY_GAS`).
// Short brand-case tokens (TON, NFT, iOS, FunC, dTON) must NOT trigger,
// which is why this is separate from the lowercased-token predicate above.
// camelCase floor lowered from 8 → 6 to catch the common TON identifiers
// `sendTon`, `loadRef`, `myAddr` that the previous threshold missed.
export function looksLikeCodeSymbol(t) {
  if (t.length < 2 || t.length > 40) return false
  if (/^\d+$/.test(t)) return false
  if (t.includes("_")) return true
  if (t.includes("::")) return true
  if (t.includes(".") && /[a-zA-Z]/.test(t)) return true
  if (/[a-z][A-Z]/.test(t) && t.length >= 6) return true
  return false
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
  // Mirror `meaningfulTokens` over the un-lowercased query so each token's
  // original casing is available for code-symbol shape detection (which is
  // case-sensitive — camelCase, ALLCAPS, snake_case all matter).
  const stopL = new Set([...tuning.stopwords].map(w => w.toLowerCase()))
  const rawSplit = trimmed.split(/\s+/).filter(Boolean)
  const rawKept = rawSplit.filter(t => t.length > 1 && !stopL.has(t.toLowerCase()))
  const originalTokens = rawKept.length > 0 ? rawKept : rawSplit
  const hasCodeShapedToken = originalTokens.some(looksLikeCodeSymbol)
  // Gate for `apiRefDemotion`: explicit "api"/"reference" in the query means
  // the user wants the ref page, so skip the demotion.
  const wantsReference = originalTokens.some(t => {
    const lt = t.toLowerCase()
    return lt === "api" || lt === "reference" || lt === "ref" || lt === "apis"
  })
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

  // Brand decompound: squashed compound brand tokens (`tonpay` → `ton pay`)
  // are rewritten into the parts the tokenizer actually produces from the
  // hyphenated URL slug. Union a pass on the split form so `tonpay sdk`
  // reaches `/applications/ton-pay/*`. Mirrors next/src/lib/search-core.ts.
  if (tuning.decompound && Object.keys(tuning.decompound).length > 0) {
    const expanded = []
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

  // Zero-result tolerance-2 retry: pay the wider-tolerance cost only when
  // the alternative would be no result at all.
  if (groups.size === 0) {
    const res = await search(db, {
      term,
      tolerance: 2,
      limit: MAX_RESULTS,
      properties: ["content"],
      groupBy: {properties: ["page_id"], maxResult: HITS_PER_PAGE},
      ...(tuning.relevance ? {relevance: tuning.relevance} : {}),
    })
    collectGroups(db, res, groups)
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
      // `#Description` is editor-curated like `#Keywords` but written as
      // prose, so it's a softer signal — award half the Keywords weight.
      // No symbol-token gate (descriptions are natural language).
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
      if (bestSpan !== Infinity) {
        const tightness = Math.max(0, 1 - Math.max(0, bestSpan - 80) / 320)
        s += tuning.proximityWeight * tightness
      }
    }
    // R4: down-rank pages whose frontmatter declares `tag: deprecated`.
    // Fumadocs' buildDocuments propagates `index.tag` onto every row as a
    // `tags: string[]` field (see node_modules/fumadocs-core/.../build-doc).
    // Read whichever is present: `tags` (array, fumadocs runtime form) or
    // `tag` (scalar, when callers attach it directly). Multiplier (not
    // subtraction) preserves relative ordering inside the deprecated set so
    // the most relevant deprecated page still wins among its peers — it
    // just sinks below comparably-relevant non-deprecated alternatives.
    const pageTags = Array.isArray(page.tags) ? page.tags : page.tag ? [page.tag] : []
    if (pageTags.includes("deprecated")) s *= 0.5
    // Demote API reference pages on prose queries (no code-shaped token,
    // no explicit api/reference token). Mirrors next/src/lib/search-core.ts.
    if (
      typeof tuning.apiRefDemotion === "number" &&
      tuning.apiRefDemotion < 1 &&
      !hasCodeShapedToken &&
      !wantsReference &&
      /\/(api-)?reference(\/|$)/.test(page.url)
    ) {
      s *= tuning.apiRefDemotion
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
  if (tuning.decompound && Object.keys(tuning.decompound).length > 0) {
    for (const k of [...pinKeys]) {
      const d = k
        .split(" ")
        .map(w => tuning.decompound[w] ?? w)
        .join(" ")
      if (d !== k && !pinKeys.includes(d)) pinKeys.push(d)
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
    // Anchor on heading/text entries lets the ai-backend build
    // section-precise citation URLs. Text hits inherit the slug of the
    // nearest preceding heading hit on the same page (null if none yet).
    let currentAnchor = null
    for (const doc of hits) {
      const type = doc.type === "head" ? "heading" : doc.type
      let anchor = null
      if (type === "heading") {
        // Use the explicit-id-aware derivation so anchors round-trip with
        // the DOM ids produced by fumadocs' remark-heading on `## T [#id]`.
        anchor = anchorFromHeadingText(doc.content ?? "") || null
        currentAnchor = anchor
      } else if (type === "text") {
        anchor = currentAnchor
      }
      raw.push({
        id: String(doc.id),
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
