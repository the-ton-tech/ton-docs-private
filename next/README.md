# TON Docs (Next.js + Fumadocs)

A Fumadocs-based replacement for the previous Mintlify build of `docs.ton.org`. The design system mirrors [Acton's docs](https://ton-blockchain.github.io/acton/) but uses TON's brand color **#0098EA**.

- **Production:** <https://docs.ton.org>
- **Pilot (Ask AI / MCP):** <https://docs-ton.space>
- **Issues:** <https://github.com/the-ton-tech/ton-docs-private/issues>

This README covers the **`next/`** Next.js app. The repo root still contains legacy Mintlify-era files (`start-here.mdx`, top-level content folders) that are mid-migration into `next/content/docs/`.

Stack: Next 16.2 · React 19.2 · Fumadocs 16.7 · Tailwind v4 · TypeScript 5 (strict) · ESLint 9 · Prettier 3.4. The site is a **static export** (`next.config.mjs` → `output: "export"`): everything dynamic — search, Ask AI, the MCP server — is an external service the static client talks to over HTTP.

---

## Quickstart

Prerequisites: **Node ≥ 22.18** (enforced by `package.json` → `engines`). `nvm` users: `nvm install 22 && nvm use 22`.

```sh
npm install
npm run dev
```

Open <http://localhost:3000>. No env vars are required to boot — editing a single page just needs `npm run dev` and a browser refresh; you don't need to run any of the validators until you're ready to push.

Production build (static export to `out/`):

```sh
npm run build
```

---

## Structure overview

```
next/
├── src/
│   ├── app/                       Next.js App Router
│   │   ├── (docs)/                docs route group (sidebar + search)
│   │   ├── api/search/            Fumadocs search route — emits the Orama index
│   │   ├── llms.txt/              compact AI context endpoint
│   │   ├── llms-full.txt/         extended AI context
│   │   ├── llms.mdx/[[...slug]]/  per-page AI context
│   │   ├── og/docs/[...slug]/     OG image generator
│   │   ├── robots.ts, sitemap.ts  robots.txt & sitemap.xml
│   │   ├── layout.tsx, page.tsx   root layout + home
│   │   ├── not-found.tsx, provider.tsx
│   │   └── globals.css
│   │
│   ├── components/
│   │   ├── mintlify/              shim layer so Mintlify-era MDX components
│   │   │                          (Accordion, Card, CodeGroup, FileTree,
│   │   │                          Note, Tabs, …) keep working
│   │   ├── legacy/                old Mintlify implementations (frozen)
│   │   ├── ui/, layouts/          Fumadocs UI customizations
│   │   ├── search.tsx             search dialog (talks to Orama)
│   │   ├── Mermaid.tsx, Callout.tsx, page-actions.tsx, …
│   │
│   ├── lib/
│   │   ├── source.ts              Fumadocs source loader
│   │   ├── search-core.ts         shared ranking pipeline (see "Search")
│   │   ├── openapi.ts             OpenAPI schema loader
│   │   ├── get-llm-text.ts        llms.txt generator
│   │   ├── og/                    OG image renderer
│   │   ├── mdx-components.tsx     custom MDX elements
│   │   └── layout.shared.tsx, nav-types.ts, cn.ts, mono.tsx, …
│   │
│   └── styles/
│
├── content/docs/                  MDX source — applications/, blockchain-basics/,
│                                  ecosystem/, overview/. Edited directly.
│
├── scripts/                       see "npm scripts"
│   ├── validate-links.ts          full link / redirect / SEO auditor
│   ├── validate-links-internal.ts independent internal-link checker
│   ├── validate-links-external.ts external HTTP(S) reachability
│   ├── validate-navigation.ts     every .mdx reachable from meta.json
│   ├── apply-nav.mjs              navigation.config.json → fs moves + meta.json
│   ├── generate-redirect-pages.mjs
│   ├── generate-openapi-pages.mjs
│   ├── migrate-content.mjs        ⚠️ legacy (Mintlify→Fumadocs one-shot)
│   └── nav-config.mjs
│
├── grammars/                      custom Shiki TextMate grammars:
│                                  Tolk, FunC, TASM, TL-B, Fift
├── openapi/                       toncenter specs — v2.json, v3.yaml, smc-index.json
├── public/                        static assets (logos, /resources/…)
│
├── navigation.config.json         source of truth for sidebar order
├── nav-overlays.json              sidebar UI overlays
├── redirects.mjs                  redirect rules (managed by apply-nav)
├── source.config.ts               Fumadocs MDX config + grammars + remark/rehype
├── next.config.mjs                output: "export", MDX plugin, redirects
├── eslint.config.mjs, postcss.config.mjs, tsconfig.json
├── vercel.json                    Vercel deploy config
└── cspell-dict.txt                project spell-check dictionary
```

---

## AI assistant & MCP

> **Status: in-flight.** "Ask AI" and the MCP server are introduced in [PR #58 — *feat: add OpenRouter AI assistant to the docs site*](https://github.com/the-ton-tech/ton-docs-private/pull/58) (still open at the time of writing). The pilot deploy is live at [docs-ton.space](https://docs-ton.space) since 2026-05-22.

### Ask AI

Triggered by a floating "Ask AI" button (kbd `⌘/`) mounted by `src/app/(docs)/layout.tsx`. Client implementation in `src/components/ai/` uses `@ai-sdk/react` `useChat` → `DefaultChatTransport` pointed at `NEXT_PUBLIC_AI_BACKEND_URL`.

| Component | Detail |
| --- | --- |
| Backend | `ai-backend/` — Hono + AI SDK v6 + Node |
| Endpoints | `POST /api/chat` (UI message stream), `POST /api/feedback` (thumbs, hashed IP), `GET /api/health` |
| Model | OpenRouter, default `nvidia/nemotron-3-super-120b-a12b:free` (overridable via `OPENROUTER_MODEL`) |
| Attribution | `HTTP-Referer: https://docs.ton.org`, `X-Title: TON Docs Assistant` |
| Retrieval | Forced `search` tool call → Orama hits fused with RRF → anchor-aware citations against `DOCS_BASE_URL` |
| Hardening | 64 KB body cap, 20 messages / 16 KB total text, NFKC + zero-width strip + literal-marker scrub for prompt injection; single-flight cache + SWR replay |
| Rate limits | 1 req/sec per IP · 10 req/day per IP · 45 req/day global (`X-Real-IP` trusted from nginx) |
| Deploy | `ai-backend/deploy/ton-docs-ai.service` (systemd, hardened: `NoNewPrivileges`, `ProtectSystem=strict`, binds `127.0.0.1:8787`) + `ai-backend/deploy/nginx.conf.example` (TLS, 2 r/s zone, 32 K body cap, 300 s read timeout) |

**Pilot constraints.** OpenRouter's `:free` tier caps total throughput at roughly 50 req/day — that's why the global cap is 45. A one-time top-up unlocks ~1 000 req/day.

### MCP server

`mcp-server/` (Node ESM, Express + `@modelcontextprotocol/sdk`) listens on `127.0.0.1:7701`, fronted by nginx at `docs-ton.space/mcp`.

- **Transport:** stateless `StreamableHTTPServerTransport` — fresh server + transport per `POST /mcp`. `GET /mcp` returns a JSON manifest; SSE returns 405. `GET /health` returns `{ok, name, version}`.
- **Tools:**
  - **`search_ton_docs(query)`** — proxies the Orama backend (`ORAMA_URL`, default `http://127.0.0.1:7700`), returns markdown page groups.
  - **`query_docs_filesystem_ton_docs(command)`** — sandboxed read-only shell over an in-memory FS of `.mdx` pages and OpenAPI specs. Allows `rg`, `grep`, `find`, `tree`, `ls`, `cat`, `head`, `tail`, `stat`, `wc`, `sort`, `uniq`, `cut`, `sed`, `awk`, `jq`. Stateless per call. 30 KB output cap.
- **Resource:** `mintlify://skills/mintlify` — a TON-skill markdown blob (URI naming is a Mintlify-era holdover; likely to be renamed before merge).

### Caveats when running the stack yourself

- `DOCS_BASE_URL` defaults to `docs.ton.org` while the pilot runs on `docs-ton.space`; staging deploys must set it explicitly or citations resolve to the wrong host.
- The `ai-backend` refuses to start without `OPENROUTER_KEY`.
- The retrieval path expects an Orama HTTP backend at `ORAMA_SEARCH_URL` (default `http://127.0.0.1:7700`); start `orama-server/` first.

---

## Search engine

Search runs on **Orama**. On `main` today, the browser downloads the full static JSON index and ranks queries locally — correct, but ~1000–2000 ms of cold-load tax before the first result. [PR #58](https://github.com/the-ton-tech/ton-docs-private/pull/58) ships a Node service in `orama-server/` ([`3fd7926`](https://github.com/the-ton-tech/ton-docs-private/commit/3fd7926)) that loads the index at boot and answers `/search?q=…` in ~25 ms; the browser pipeline stays as a fallback so an outage degrades latency, not correctness. The same PR also lands the API-reference demotion ([`7bbdc96`](https://github.com/the-ton-tech/ton-docs-private/commit/7bbdc96)) described below — base ranking (`src/lib/search-core.ts`, last touched by [`c331b18`](https://github.com/the-ton-tech/ton-docs-private/commit/c331b18)) is the only piece already on `main`.

### Index shape

- Built by `src/app/api/search/route.ts` via `fumadocs-core`'s `createFromSource`, which emits **three rows per page** — `page` / `heading` / `text` — sharing a `page_id` for hierarchical scoring.
- Long sections capped at `MAX_BLOCK_CHARS = 2000`.
- Synthetic blocks appended per page:
  - **Keywords** — curated terms from frontmatter.
  - **Description** — auto-mined from page metadata (acts as synonyms).
  - **Code symbols** — mined from fenced / inline code via `isSymbolLike` (`snake_case`, `::scope`, ALLCAPS opcodes, camelCase ≥ 8, mixed alnum). Cap 2 500 chars. Targets queries like `tonconnect.restoreConnection` that don't appear in prose.

### Tokenization

English tokenizer, **stemming on**, **`allowDuplicates: true`** at both index- and query-time (`src/lib/search-core.ts`). `allowDuplicates` restores real BM25 term-frequency that Orama's default clamps to 1 — without it, `bm25Weight` collapses to a binary signal.

### Ranking pipeline — `runRankedSearch` in `src/lib/search-core.ts`

1. **Query normalization** with a domain-aware stopword list that **keeps** load-bearing TON terms like `get`, `set`, `send`, `call`, `run`.
2. **Two Orama passes** — exact (tolerance 0) ∪ fuzzy (tolerance 1), unioned by `page_id`.
3. **Spelling correction & brand decompounding** — `jeton → jetton`, `transcation → transaction`, `tonpay → ton pay`. Additive: corrected forms join scoring, originals stay.
4. **Navigational pins** (`DEFAULT_PINS`) — high-traffic queries (`ton connect`, `jetton`, `wallet`, `block explorer`, …) force their canonical page to #1.
5. **Composite re-rank:**
   - Per-token presence in **title** (×2), **haystack** title + breadcrumbs + URL (×1), **URL** (×1).
   - **Exact / prefix title** bonus (`exactTitleWeight 3`).
   - **BM25 blend** — min-max normalized Orama score, clamped to `[0, 2.5]` (`bm25Weight 2.5`). The clamp matters: unclamped, long term-dense reference pages outscore canonical landing pages.
   - **Structural hits** — keyword block always; code-symbol block **only when the query itself contains a code-shaped token**.
   - **Heading matches** (`headingMatchWeight 0.2`) with phrase-match multiplier.
   - **API-reference demotion** (×0.8, commit [`7bbdc96`](https://github.com/the-ton-tech/ton-docs-private/commit/7bbdc96)) — `/api-reference/` and `/reference/` pages are demoted when the query has no code-shaped tokens and doesn't ask for "api" / "reference". Fixes regressions like `tonconnect quick start` matching symbol-dense reference pages over landing pages.
   - **All-terms** and **proximity** bonuses are present but disabled — measured net-negative on hit@1 / MRR.
6. **Breadth before depth** — up to 120 pages × 3 hits per page, so the re-rank reaches results buried past Orama's first 10.
7. **Stem-aware re-rank** — implemented behind `stemReRank` (currently **off**: slight hit@1 lift on the curated slice but −0.009 MRR on the mined held-out set).

---

## npm scripts

### Day-to-day

| Script | What it does |
| --- | --- |
| `dev` | `next dev` — local dev server on :3000. |
| `build` | `next build --webpack` — static export to `out/`. |
| `start` | `next start` — serve the production build. |
| `lint` | `eslint`. |
| `fmt` / `fmt:check` | `prettier --write .` / `--check .`. |
| `generated-source` | `fumadocs-mdx` — regenerate `.source/` MDX metadata. |

### Link & navigation validation

| Script | What it does | Writes? |
| --- | --- | --- |
| `lint:links` | Composite: `lint:links:validate && lint:links:internal && lint:links:external`. | no |
| `lint:links:validate` / `lint:links:internal` | `scripts/validate-links-internal.ts` — independent internal-link checker, intentionally a separate implementation from `validate-links.ts` for cross-validation. Scans markdown `[](path)` and JSX `href=` against pages, `public/` assets, and `redirects.mjs` sources. | no |
| `lint:links:external` | `scripts/validate-links-external.ts` — HEAD/GET external URLs (15 s timeout, 8 parallel workers; RFC 2606 example domains whitelisted). | no |
| `lint:redirects` | `validate-links.ts --check-redirects --check-chains` — redirect coverage + loop detection. | no |
| `lint:seo` | Full SEO audit: redirects + chains + stale internal links + sitemap wiring + orphan assets. | no |
| `lint:links:fix` | Two-phase auto-repair: flatten chains `A→B→C` to `A→C`, enforce permanent, fix stale MDX targets via fuzzy basename matching. | **yes** |
| `lint:navigation` | `scripts/validate-navigation.ts` — every `.mdx` under `content/docs/**` is reachable from its ancestor `meta.json`. | no |

### Codegen

| Script | What it does | Writes? |
| --- | --- | --- |
| `generate-redirects` | `scripts/generate-redirect-pages.mjs` — write `out/<source>/index.html` with `<meta http-equiv="refresh">` + `location.replace()` for every non-wildcard entry in `redirects.mjs`. Skips existing files; preserves query/hash. | **yes** (`out/`) |
| `generate-openapi` | `scripts/generate-openapi-pages.mjs` — sync MDX pages from `openapi/v2.json`, `v3.yaml`, `smc-index.json`. One MDX per operation with `openapi: <method> <path>` frontmatter rendered by `<APIPage>`. Skips existing pages so curated titles / descriptions survive. Flags: `--dry-run`, `--verbose`, `--help`. | **yes** (`content/docs/applications/api/toncenter/**`) |

### Navigation source-of-truth

| Script | What it does | Writes? |
| --- | --- | --- |
| `nav:apply` | `scripts/apply-nav.mjs` — applies `navigation.config.json` to disk in 8 phases: load config → build id index from frontmatter → validate → plan `fs.rename` moves → apply moves + prune empty dirs → write `meta.json` per directory (tabs get `root: true`) → append permanent redirects to `redirects.mjs` (deduped) → cross-check orphans. Flags: `--dry-run`, `--allow-orphans`, `--no-redirects`, `--verbose`. | **yes** |
| `nav:apply:plan` | `apply-nav.mjs --dry-run` — show the plan without touching anything. | no |

### Legacy

- **`migrate-content`** — `scripts/migrate-content.mjs`. **One-shot, do not run.** It was the Mintlify → Fumadocs cutover: walked legacy `.mdx` / `.md` at repo root, stamped stable `id` into frontmatter, rewrote `:::admonition` → `<Aside>`, mirrored `resources/{images,logo,pdfs,tvm,videos}/` into `public/`, seeded redirects from the legacy `docs.json`. Commit [`f934d0f`](https://github.com/the-ton-tech/ton-docs-private/commit/f934d0f) disabled it ("the next/ app is now edited directly, so the migrate-content pipeline would only overwrite hand-edits"); revert [`8d1bea6`](https://github.com/the-ton-tech/ton-docs-private/commit/8d1bea6) restored the script. **Don't run it on a hand-edited tree.**

---

## How to contribute

1. **Fork** the repo and create a feature branch off `main`.
2. **Edit MDX** under `next/content/docs/`. Frontmatter pattern (real example: [`content/docs/overview/start-here.mdx`](content/docs/overview/start-here.mdx)):
   ```yaml
   ---
   id: path/to/page              # immutable — kept by nav:apply across moves
   title: "Page Title"
   sidebarTitle: "Short Title"   # optional
   description: ""
   ---
   ```
   For tone and conventions read [`style-guide.mdx`](./content/docs/overview/contribute/style-guide.mdx).
3. **Preview** with `npm run dev` — that's enough for a typo or content fix.
4. **Run the checks** before pushing anything bigger:
   ```sh
   npm run fmt
   npm run lint
   npm run lint:links         # link / redirect sanity
   npm run lint:navigation    # every page reachable from meta.json
   ```
   If you reorganized the sidebar via `navigation.config.json`, preview with `npm run nav:apply:plan` first, then `npm run nav:apply`.
5. **Spell check.** CSpell runs in CI against `next/**/*.{md,mdx}`. New domain terms / proper names go into `next/cspell-dict.txt` (`*term` for combinations, `!term` to forbid).
6. **Commit messages** follow Conventional Commits — `feat:`, `fix:`, `chore:`, `docs:`, … one logical change per commit. Recent `main` history is the reference.
7. **Open a PR to `main`.** CI gates ([`.github/workflows/`](../.github/workflows/)):
   - [`next-build.yml`](../.github/workflows/next-build.yml) — production build must succeed.
   - [`linter.yml`](../.github/workflows/linter.yml) — Prettier on changed `.md` / `.mdx`.
   - [`spell-check.yml`](../.github/workflows/spell-check.yml) — CSpell.
   - link / navigation validation.

   PRs that change navigation or do mass renames should run `npm run lint:links:fix` and commit the resulting `redirects.mjs` diff.

---

## License

Code under [`LICENSE-code`](../LICENSE-code), documentation prose under [`LICENSE-docs`](../LICENSE-docs) (both at the repo root).
