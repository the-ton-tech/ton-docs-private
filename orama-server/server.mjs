// Standalone Orama search service for ton-docs.
//
// Loads the static index JSON once at startup, then serves ranked search
// results over HTTP. nginx terminates TLS and reverse-proxies to us on
// 127.0.0.1, so we bind locally only.

import {createServer} from "node:http"
import {readFile, stat} from "node:fs/promises"
import {load} from "@orama/orama"
import {createClientDB, runRankedSearch} from "./search-core.mjs"

const INDEX_PATH = process.env.ORAMA_INDEX_PATH ?? "/opt/orama-search/index.json"
const PORT = Number(process.env.PORT ?? 7700)
const HOST = process.env.HOST ?? "127.0.0.1"

const t0 = Date.now()
const stats = await stat(INDEX_PATH)
console.log(`[orama] loading index ${INDEX_PATH} (${(stats.size / 1e6).toFixed(1)} MB)`)
const indexJson = JSON.parse(await readFile(INDEX_PATH, "utf8"))
const db = createClientDB()
load(db, indexJson)
console.log(`[orama] index loaded in ${Date.now() - t0} ms`)

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(buf.length),
    ...CORS_HEADERS,
  })
  res.end(buf)
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }
    const url = new URL(req.url ?? "/", "http://localhost")

    if (url.pathname === "/health") {
      json(res, 200, {ok: true, loadedAt: new Date(t0).toISOString()})
      return
    }

    if (url.pathname === "/search" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? ""
      if (!q.trim()) {
        json(res, 200, {term: "", results: []})
        return
      }
      const started = Date.now()
      const out = await runRankedSearch(db, q)
      const elapsed = Date.now() - started
      res.setHeader("x-orama-ms", String(elapsed))
      json(res, 200, out)
      return
    }

    json(res, 404, {error: "not found"})
  } catch (err) {
    console.error("[orama] request error", err)
    json(res, 500, {error: "internal"})
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[orama] listening on http://${HOST}:${PORT}`)
})

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[orama] ${sig} received, shutting down`)
    server.close(() => process.exit(0))
  })
}
