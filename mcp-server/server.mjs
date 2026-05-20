// MCP server for TON Docs.
//
// Exposes two tools — search_ton_docs (Orama proxy) and
// query_docs_filesystem_ton_docs (sandboxed read-only shell over the corpus)
// — over the Streamable HTTP transport on a loopback port. nginx terminates
// TLS and forwards docs-ton.space/mcp to us.
//
// We run stateless: every POST /mcp gets a fresh McpServer + transport pair,
// the request is handled, and both are torn down on response close. This is
// fine because our tools are pure RPC — no notifications, no resumable
// streams — and it sidesteps any cross-request session bookkeeping.

import express from "express"
import {randomUUID} from "node:crypto"
import {z} from "zod"
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js"
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js"

import {searchTonDocs} from "./search.mjs"
import {runSandboxedCommand} from "./sandbox.mjs"

const PORT = Number(process.env.PORT ?? 7701)
const HOST = process.env.HOST ?? "127.0.0.1"

const SEARCH_DESCRIPTION =
  "Search across the TON Docs knowledge base to find relevant information, code examples, API references, and guides. " +
  "Use this tool when you need to answer questions about TON Docs, find specific documentation, understand how features work, or locate implementation details. " +
  "The search returns contextual content with titles and direct links to the documentation pages. " +
  "If you need the full content of a specific page, use the query_docs_filesystem tool to `head` or `cat` the page path " +
  "(append `.mdx` to the path returned from search — e.g. `head -200 /api-reference/create-customer.mdx`)."

const FS_DESCRIPTION = [
  "Run a read-only shell-like query against a virtualized, in-memory filesystem rooted at `/` that contains ONLY the TON Docs documentation pages and OpenAPI specs.",
  "This is NOT a shell on any real machine — nothing runs on the user's computer, the server host, or any network. The filesystem is a sandbox backed by documentation chunks.",
  "",
  "This is how you read documentation pages: there is no separate \"get page\" tool. To read a page, pass its `.mdx` path (e.g. `/quickstart.mdx`, `/api-reference/create-customer.mdx`) to `head` or `cat`. " +
    "To search the docs with exact keyword or regex matches, use `rg`. To understand the docs structure, use `tree` or `ls`.",
  "",
  "**Workflow:** Start with the search tool for broad or conceptual queries like \"how to authenticate\" or \"rate limiting\". Use this tool when you need exact keyword/regex matching, structural exploration, or to read the full content of a specific page by path.",
  "",
  "Supported commands: rg (ripgrep), grep, find, tree, ls, cat, head, tail, stat, wc, sort, uniq, cut, sed, awk, jq, plus basic text utilities. No writes, no network, no process control. Run `--help` on any command for usage.",
  "",
  "Each call is STATELESS: the working directory always resets to `/` and no shell variables, aliases, or history carry over between calls. If you need to operate in a subdirectory, chain commands in one call with `&&` or pass absolute paths (e.g., `cd /api-reference && ls` or `ls /api-reference`). Do NOT assume that `cd` in one call affects the next call.",
  "",
  "Examples:",
  "- `tree / -L 2` — see the top-level directory layout",
  "- `rg -il \"rate limit\" /` — find all files mentioning \"rate limit\"",
  "- `rg -C 3 \"apiKey\" /api-reference/` — show matches with 3 lines of context around each hit",
  "- `head -80 /quickstart.mdx` — read the top 80 lines of a specific page",
  "- `head -80 /quickstart.mdx /installation.mdx /guides/first-deploy.mdx` — read multiple pages in one call",
  "- `cat /api-reference/create-customer.mdx` — read a full page when you need everything",
  "- `cat /openapi/spec.json | jq '.paths | keys'` — list OpenAPI endpoints",
  "",
  "Output is truncated to 30KB per call. Prefer targeted `rg -C` or `head -N` over broad `cat` on large files. To read only the relevant sections of a large file, use `rg -C 3 \"pattern\" /path/file.mdx`. Batch multiple file reads into a single `head` or `cat` call whenever possible.",
  "",
  "When referencing pages in your response to the user, convert filesystem paths to URL paths by removing the `.mdx` extension. For example, `/quickstart.mdx` becomes `/quickstart` and `/api-reference/overview.mdx` becomes `/api-reference/overview`.",
].join("\n")

const SKILL_BODY = [
  "# TON Docs skill",
  "",
  "Use when building smart contracts, deploying to mainnet/testnet, working with wallets and tokens (Jettons/NFTs), querying blockchain data via APIs, or developing dApps on TON. " +
    "Reach for this skill when agents need to understand contract development workflows, blockchain interactions, or TON-specific patterns.",
  "",
  "Start with `search_ton_docs` for conceptual questions, then drill into specific pages with `query_docs_filesystem_ton_docs` (e.g. `head -200 /foundations/intro.mdx`).",
].join("\n")

function buildMcpServer() {
  const server = new McpServer({name: "TON Docs", version: "1.0.0"})

  server.registerTool(
    "search_ton_docs",
    {
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z.string().describe("A query to search the content with."),
      },
    },
    async ({query}) => {
      const text = await searchTonDocs(query)
      return {content: [{type: "text", text}]}
    },
  )

  server.registerTool(
    "query_docs_filesystem_ton_docs",
    {
      description: FS_DESCRIPTION,
      inputSchema: {
        command: z
          .string()
          .describe(
            "A shell command to run against the virtualized documentation filesystem " +
              "(e.g., `rg -il \"keyword\" /`, `tree / -L 2`, `head -80 /path/file.mdx`).",
          ),
      },
    },
    async ({command}) => {
      const text = await runSandboxedCommand(command)
      return {content: [{type: "text", text}]}
    },
  )

  server.registerResource(
    "mintlify-skill",
    "mintlify://skills/mintlify",
    {
      name: "mintlify",
      description:
        "Use when building smart contracts, deploying to mainnet/testnet, working with wallets and tokens " +
        "(Jettons/NFTs), querying blockchain data via APIs, or developing dApps on TON. Reach for this skill " +
        "when agents need to understand contract development workflows, blockchain interactions, or TON-specific patterns.",
      mimeType: "text/markdown",
    },
    async uri => ({
      contents: [{uri: uri.href, mimeType: "text/markdown", text: SKILL_BODY}],
    }),
  )

  return server
}

const app = express()
app.use(express.json({limit: "1mb"}))

app.get("/health", (_req, res) => {
  res.json({ok: true, name: "TON Docs MCP", version: "1.0.0"})
})

app.post("/mcp", async (req, res) => {
  const reqId = randomUUID()
  try {
    const server = buildMcpServer()
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined})
    res.on("close", () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    console.error(`[mcp ${reqId}] handler error`, err)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {code: -32603, message: "Internal server error"},
        id: null,
      })
    }
  }
})

// The Streamable HTTP transport defines GET and DELETE for stateful sessions
// (server -> client SSE, session termination). We do not run sessions, so
// return 405 explicitly per the spec to keep clients honest.
const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: {code: -32000, message: "Method not allowed."},
    id: null,
  })
app.get("/mcp", methodNotAllowed)
app.delete("/mcp", methodNotAllowed)

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`[mcp] listening on http://${HOST}:${PORT}`)
})

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[mcp] ${sig} received, shutting down`)
    httpServer.close(() => process.exit(0))
  })
}
