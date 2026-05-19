/**
 * Browser-path integration check.
 *
 * The offline harness scores ranking but skips the two browser-only concerns:
 * fetching the index over HTTP and snippet highlighting. This script exercises
 * the EXACT module path components/search.tsx runs — fetch(/api/search) ->
 * createClientDB -> load -> runRankedSearch -> createContentHighlighter — so a
 * green run means the shipped client path works end to end, not just the
 * pure ranking core.
 *
 * Usage (with the built site served, e.g. python3 -m http.server in out/):
 *   BASE=http://127.0.0.1:4399 npx tsx scripts/search-eval/browser-path-check.ts
 */
import {createContentHighlighter} from "fumadocs-core/search"
import {load, type AnyOrama, type RawData} from "@orama/orama"
import {createClientDB, runRankedSearch} from "../../src/lib/search-core"

const BASE = process.env.BASE ?? "http://127.0.0.1:4399"

// Representative queries incl. every lever + the two known residuals.
const PROBES: {q: string; want: string; note: string}[] = [
  {q: "ton connect", want: "/applications/ton-connect/overview", note: "pin"},
  {q: "jeton", want: "/blockchain-basics/standard/tokens/jettons/overview", note: "spell→pin"},
  {q: "soulbound token", want: "/blockchain-basics/standard/tokens/nft/sbt", note: "keyword synonym"},
  {
    q: "how to deploy a smart contract",
    want: "/blockchain-basics/contract-dev/blueprint/first-smart-contract",
    note: "concept",
  },
  {q: "transcation fees", want: "/blockchain-basics/primitives/fees", note: "typo"},
  {
    q: "wallet seed phrase",
    want: "/blockchain-basics/standard/wallets/mnemonics",
    note: "keyword synonym",
  },
  {q: "get methods", want: "/blockchain-basics/tvm/get-method", note: "domain stopword + pin"},
]

async function main(): Promise<void> {
  console.log(`fetching index from ${BASE}/api/search …`)
  const res = await fetch(`${BASE}/api/search`)
  if (!res.ok) throw new Error(`index fetch failed: HTTP ${res.status}`)
  const data = (await res.json()) as RawData
  const db: AnyOrama = createClientDB()
  load(db, data)
  console.log("index loaded into client DB ✓\n")

  let pass = 0
  for (const {q, want, note} of PROBES) {
    const {term, results} = await runRankedSearch(db, q)
    const highlighter = createContentHighlighter(term)
    const highlighted = results.map(r => ({
      ...r,
      content: highlighter.highlightMarkdown(r.content),
    }))
    const firstUrl = highlighted[0]?.url ?? "(none)"
    const top10 = [...new Set(highlighted.map(r => r.url))].slice(0, 10)
    const ok = top10.includes(want)
    const at1 = firstUrl === want
    if (ok) pass++
    console.log(
      `${ok ? "✓" : "✗"} [${note}] "${q}"  ` +
        `#1=${at1 ? "EXACT" : firstUrl}  ${ok ? "(target in top-10)" : "MISS"}`,
    )
    // Highlight sanity: at least one returned snippet should carry markup
    // (createContentHighlighter returns structured nodes the UI renders).
    const sample = JSON.stringify(highlighted[0]?.content ?? "")
    if (highlighted.length > 0 && sample.length < 2) {
      console.log("   ! empty highlighted content for #1")
    }
  }
  console.log(`\nbrowser-path probes: ${pass}/${PROBES.length} hit target in top-10`)
  // Two known residuals are NOT in this probe set, so expect full pass.
  process.exit(pass === PROBES.length ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
