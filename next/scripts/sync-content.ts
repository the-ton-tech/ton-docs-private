import * as fs from "node:fs"
import {algoliasearch} from "algoliasearch"
import {updateDocuments, type DocumentRecord} from "fumadocs-core/search/algolia"

// `next` auto-loads `.env.local`, but this script runs standalone under `tsx`
// which does not — without this the sync would always skip locally. On CI the
// file is absent and the vars come from the real environment instead.
for (const envFile of [".env.local", ".env"]) {
  if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile)
    break
  }
}

const appId = process.env.NEXT_PUBLIC_ALGOLIA_APP_ID
const adminKey = process.env.ALGOLIA_ADMIN_API_KEY
const indexName = process.env.NEXT_PUBLIC_ALGOLIA_INDEX_NAME ?? "ton-docs"

// Local builds and CI without Algolia secrets (e.g. the CUTOVER §1 sanity
// check) must still succeed — skip the sync instead of failing the build.
if (!appId || !adminKey) {
  console.warn(
    "[algolia] NEXT_PUBLIC_ALGOLIA_APP_ID / ALGOLIA_ADMIN_API_KEY not set — skipping search index sync.",
  )
  process.exit(0)
}

// There is a single shared `ton-docs` index. On Vercel, only the production
// deployment may write to it — every preview/branch build would otherwise run
// `replaceAllObjects` against the same index, clobbering production search and
// racing concurrent branch builds. `VERCEL_ENV` is "production" | "preview" |
// "development" on Vercel and unset elsewhere, so local / manual `npm run
// build` still syncs as before (intentional).
const vercelEnv = process.env.VERCEL_ENV
if (vercelEnv && vercelEnv !== "production") {
  console.warn(
    `[algolia] VERCEL_ENV="${vercelEnv}" (not production) — skipping search index sync.`,
  )
  process.exit(0)
}

// `output: "export"` emits the prerendered route to `out/static.json`; a
// plain server build keeps it at `.next/server/app/static.json.body`. Accept
// whichever exists so the sync works under both build modes.
const candidates = ["out/static.json", ".next/server/app/static.json.body"]
const filePath = candidates.find(p => fs.existsSync(p))

if (!filePath) {
  console.error(
    `[algolia] none of [${candidates.join(", ")}] found — run \`next build\` before the sync.`,
  )
  process.exit(1)
}

const records = JSON.parse(fs.readFileSync(filePath, "utf8")) as DocumentRecord[]

// Algolia's free plan rejects any single record larger than 10 KB. Fumadocs'
// `sync` explodes each page into one Algolia object per paragraph/heading, so
// the only thing that can blow the limit is an oversized content chunk (big
// generated tables, long code blocks — some TON pages hit ~128 KB). Split
// such chunks on a whitespace boundary, hard-cutting pathological
// no-whitespace blobs. 8 KB leaves headroom for the per-record
// title/url/breadcrumbs overhead.
const MAX_CONTENT_BYTES = 8000
const bytes = (s: string) => Buffer.byteLength(s, "utf8")

function splitByBytes(text: string, max: number): string[] {
  if (bytes(text) <= max) return [text]
  const out: string[] = []
  let rest = text
  while (bytes(rest) > max) {
    let lo = 1
    let hi = rest.length
    let cut = 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (bytes(rest.slice(0, mid)) <= max) {
        cut = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    const window = rest.slice(0, cut)
    const ws = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "))
    const end = ws > Math.floor(cut * 0.6) ? ws : cut
    out.push(rest.slice(0, end).trim())
    rest = rest.slice(end).replace(/^\s+/, "")
  }
  if (rest.trim()) out.push(rest.trim())
  return out.filter(Boolean)
}

interface Structured {
  headings: {id: string; content: string}[]
  contents: {heading?: string; content: string}[]
}

function capRecord(record: DocumentRecord): DocumentRecord {
  const structured = record.structured as Structured | undefined
  if (!structured || !Array.isArray(structured.contents)) return record
  return {
    ...record,
    structured: {
      headings: structured.headings ?? [],
      contents: structured.contents.flatMap(c =>
        splitByBytes(c.content, MAX_CONTENT_BYTES).map(content => ({
          heading: c.heading,
          content,
        })),
      ),
    },
  }
}

const documents = records.map(capRecord)
const client = algoliasearch(appId, adminKey)

// Fumadocs' `sync()` ALWAYS rewrites index settings with its own hardcoded
// defaults (no `distinct`, no language/relevance tuning), so calling it would
// clobber our config on every deploy. Instead we run only its record-explosion
// step (`updateDocuments` → `replaceAllObjects`) and own the settings here.
const settings = {
  // order = priority; keep content searchable (restricting it zeroes out
  // hyphen/abbreviation queries like `tlb` → "TL-B").
  searchableAttributes: ["title", "section", "content"],
  attributeForDistinct: "page_id",
  // Collapse a page's many section-records to its single best hit, so the
  // result list shows distinct pages instead of one page repeated ~30×.
  distinct: 1,
  attributesForFaceting: ["tag"],
  attributesToRetrieve: [
    "title",
    "section",
    "content",
    "url",
    "section_id",
    "breadcrumbs",
    "tag",
    "page_id",
  ],
  attributesToSnippet: [] as string[],
  // English technical docs: drop stopwords, fold plurals, and recover
  // zero-result multi-word queries by relaxing the last words.
  removeStopWords: true,
  ignorePlurals: true,
  queryLanguages: ["en"],
  indexLanguages: ["en"],
  removeWordsIfNoResults: "lastWords" as const,
  advancedSyntax: true,
}

// TON-domain vocabulary bridging (abbreviation ⇄ expansion). FunC/Tolk/Fift
// are intentionally NOT merged (distinct languages). `replaceExistingSynonyms`
// makes this a deterministic full replace, so editing this list is the single
// source of truth. Pushed every build (idempotent) so a freshly recreated
// index always has them.
const synonyms = [
  {objectID: "ton-net", type: "synonym", synonyms: ["TON", "The Open Network"]},
  {objectID: "tvm", type: "synonym", synonyms: ["TVM", "TON Virtual Machine"]},
  {objectID: "evm", type: "synonym", synonyms: ["EVM", "Ethereum Virtual Machine"]},
  {objectID: "boc", type: "synonym", synonyms: ["BOC", "bag of cells"]},
  {objectID: "tlb", type: "synonym", synonyms: ["TL-B", "TLB", "Type Language - Binary"]},
  {objectID: "adnl", type: "synonym", synonyms: ["ADNL", "Abstract Datagram Network Layer"]},
  {objectID: "smartcontract", type: "synonym", synonyms: ["smart contract", "smartcontract"]},
  {
    objectID: "seedphrase",
    type: "synonym",
    synonyms: ["seed phrase", "mnemonic", "recovery phrase", "mnemonic phrase"],
  },
  {objectID: "toncoin", type: "synonym", synonyms: ["Toncoin", "TON coin", "gram"]},
  {objectID: "masterchain", type: "synonym", synonyms: ["masterchain", "master chain"]},
  {objectID: "workchain", type: "synonym", synonyms: ["workchain", "work chain"]},
  {objectID: "shardchain", type: "synonym", synonyms: ["shardchain", "shard chain"]},
  {objectID: "gas-fee", type: "oneWaySynonym", input: "gas", synonyms: ["fee", "fees", "commission"]},
  {objectID: "token-jetton", type: "oneWaySynonym", input: "token", synonyms: ["jetton"]},
]

async function run() {
  // `replaceAllObjects` copies the live index (settings/synonyms included, by
  // default scope) into a temp index and moves it back, so settings/synonyms
  // must be (re)asserted AFTER it to stay authoritative and to seed a brand
  // new index. All three calls are idempotent — safe to run every build.
  await updateDocuments(client, indexName, documents)
  await client.setSettings({indexName, indexSettings: settings})
  await client.saveSynonyms({
    indexName,
    synonymHit: synonyms as Parameters<typeof client.saveSynonyms>[0]["synonymHit"],
    replaceExistingSynonyms: true,
  })
  console.log(
    `[algolia] synced ${documents.length} page records, settings and ${synonyms.length} synonyms to index "${indexName}".`,
  )
}

run().catch((err: unknown) => {
  console.error("[algolia] sync failed:", err)
  process.exit(1)
})
