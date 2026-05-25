#!/usr/bin/env node
/**
 * Generate Fumadocs MDX pages from the toncenter OpenAPI specs.
 *
 * Specs (next/openapi/) map onto the docs tree like this:
 *   v2.json        -> content/docs/applications/api/toncenter/v2/<tag>/<page>.mdx
 *   v3.yaml        -> content/docs/applications/api/toncenter/v3/<tag>/<page>.mdx
 *   smc-index.json -> content/docs/applications/api/toncenter/smc-index/<page>.mdx
 *
 * Every OpenAPI operation becomes one MDX page. The page carries only
 * frontmatter (no body) and is rendered by `<APIPage>` through the
 * `openapi: <method> <path>` field — see src/lib/openapi.ts.
 *
 * This is a *sync*, not a full rebuild: a page that already exists is never
 * touched, so the hand-curated titles and descriptions stay intact. Each run
 * only:
 *   1. scaffolds a page for every spec operation that has no page yet, and
 *   2. refreshes the meta.json of folders that received new content.
 * When every operation already has a page the run is a no-op.
 *
 * The folder for a v2/v3 operation is its OpenAPI tag. The tag -> folder
 * mapping is *learned* from the pages that already exist, so the current
 * naming (e.g. tag "Api/v2" -> folder "apiv2") is reproduced exactly; a tag
 * with no existing page falls back to a slug of the tag name.
 *
 * Usage:
 *   node scripts/generate-openapi-pages.mjs [--dry-run] [--verbose]
 *
 *   --dry-run   report planned changes, write nothing
 *   --verbose   also list operations that already have a page
 *   --help      print this usage
 */
import {promises as fs} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {parse as parseYaml} from "yaml"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NEXT_ROOT = path.join(HERE, "..")
const OPENAPI_DIR = path.join(NEXT_ROOT, "openapi")
const API_ROOT = path.join(NEXT_ROOT, "content", "docs", "applications", "api", "toncenter")
const ID_PREFIX = "ecosystem/api/toncenter"
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"])

const DRY_RUN = process.argv.includes("--dry-run")
const VERBOSE = process.argv.includes("--verbose")

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    [
      "Usage: node scripts/generate-openapi-pages.mjs [--dry-run] [--verbose]",
      "",
      "Scaffolds an MDX page for every toncenter OpenAPI operation that has no",
      "page yet and refreshes the meta.json of folders that gained pages.",
      "Existing pages are never modified.",
      "",
      "  --dry-run   report planned changes without writing",
      "  --verbose   also list operations that already have a page",
    ].join("\n"),
  )
  process.exit(0)
}

/**
 * @typedef {object} SpecConfig
 * @property {string} key         short id used in logs
 * @property {string} file        file name under next/openapi/
 * @property {string} dir         sub-directory under the toncenter content root
 * @property {boolean} groupByTag  whether operations are foldered by OpenAPI tag
 * @property {string} groupTitle  fallback title for the group meta.json
 */

/** @type {SpecConfig[]} */
const SPECS = [
  {key: "v2", file: "v2.json", dir: "v2", groupByTag: true, groupTitle: "API reference"},
  {key: "v3", file: "v3.yaml", dir: "v3", groupByTag: true, groupTitle: "API reference"},
  {key: "smc-index", file: "smc-index.json", dir: "smc-index", groupByTag: false, groupTitle: ""},
]

const log = (...args) => console.log("[generate-openapi]", ...args)
const toPosix = p => p.split(path.sep).join("/")
const relToNext = abs => toPosix(path.relative(NEXT_ROOT, abs))
const opKey = (method, route) => `${String(method).toLowerCase()} ${route}`

/** Lowercase, collapse every non-alphanumeric run to a single dash, trim dashes. */
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Title-case a summary the way the existing pages read: lower plain Titlecase
 * words ("Account" -> "account"), keep acronyms and mixed-case tokens as-is
 * ("BoC", "JSON-RPC"), capitalise the first word.
 */
function prettifyTitle(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ""
  const out = words.map(w => (/^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w))
  out[0] = out[0].charAt(0).toUpperCase() + out[0].slice(1)
  return out.join(" ")
}

/** First sentence of a description, with all whitespace flattened to spaces. */
function firstSentence(text) {
  const flat = String(text).replace(/\s+/g, " ").trim()
  if (!flat) return ""
  const match = flat.match(/^.*?[.!?](?=\s|$)/)
  return match ? match[0] : flat
}

async function dirExists(p) {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** Load a spec file, parsing YAML or JSON by extension. Returns null if absent. */
async function loadSpec(cfg) {
  let raw
  try {
    raw = await fs.readFile(path.join(OPENAPI_DIR, cfg.file), "utf8")
  } catch {
    return null
  }
  const isYaml = cfg.file.endsWith(".yaml") || cfg.file.endsWith(".yml")
  return isYaml ? parseYaml(raw) : JSON.parse(raw)
}

/** Flatten an OpenAPI document into a list of operations in document order. */
function listOperations(doc) {
  const ops = []
  for (const [route, item] of Object.entries(doc?.paths ?? {})) {
    if (!item || typeof item !== "object") continue
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue
      if (!op || typeof op !== "object") continue
      ops.push({
        method: method.toLowerCase(),
        route,
        tag: Array.isArray(op.tags) && op.tags.length > 0 ? String(op.tags[0]) : undefined,
        summary: op.summary ? String(op.summary) : "",
        description: op.description ? String(op.description) : "",
        operationId: op.operationId ? String(op.operationId) : "",
      })
    }
  }
  return ops
}

/** Recursively collect every .mdx file under `dir` (absolute paths). */
async function walkMdx(dir) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, {withFileTypes: true})
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walkMdx(full)))
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      out.push(full)
    }
  }
  return out
}

/** Read the (string) `openapi` frontmatter field from an MDX source. */
function readOpenapiField(source) {
  const fm = source.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return undefined
  const line = fm[1].match(/^openapi:\s*(.+?)\s*$/m)
  if (!line) return undefined
  let value = line[1].trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return value
}

/** List the .mdx basenames (without extension) directly inside `dir`. */
async function listPageNames(dir) {
  const names = []
  try {
    for (const name of await fs.readdir(dir)) {
      if (name.endsWith(".mdx")) names.push(name.slice(0, -4))
    }
  } catch {
    // directory does not exist yet
  }
  return names
}

/** List the immediate sub-directory names of `dir`. */
async function listSubdirs(dir) {
  const names = []
  try {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      if (entry.isDirectory()) names.push(entry.name)
    }
  } catch {
    // directory does not exist yet
  }
  return names
}

/** Read the `title` of an existing meta.json, or undefined when unavailable. */
async function readMetaTitle(metaAbs) {
  try {
    const parsed = JSON.parse(await fs.readFile(metaAbs, "utf8"))
    if (typeof parsed.title === "string") return parsed.title
  } catch {
    // missing or malformed meta.json
  }
  return undefined
}

/** Render the frontmatter-only MDX page for one operation. */
function renderPage({title, idPath, method, route, description}) {
  return (
    [
      "---",
      `title: ${JSON.stringify(title)}`,
      `sidebarTitle: ${JSON.stringify(title)}`,
      `id: ${idPath}`,
      `openapi: ${method} ${route}`,
      "noindex: true",
      `description: ${JSON.stringify(description)}`,
      "---",
    ].join("\n") + "\n"
  )
}

/** Write `content` to `absPath` only when it differs from what is on disk. */
async function writeIfChanged(absPath, content, changed) {
  let current
  try {
    current = await fs.readFile(absPath, "utf8")
  } catch {
    current = undefined
  }
  if (current === content) return
  const verb = current === undefined ? "create" : "update"
  if (DRY_RUN) {
    log(`would ${verb} ${relToNext(absPath)}`)
  } else {
    await fs.mkdir(path.dirname(absPath), {recursive: true})
    await fs.writeFile(absPath, content, "utf8")
    log(`${verb}d ${relToNext(absPath)}`)
  }
  changed.push(relToNext(absPath))
}

async function main() {
  // Index every operation across all specs, keyed by "method route".
  const specIndex = new Map()
  const opsBySpec = new Map()
  for (const spec of SPECS) {
    const doc = await loadSpec(spec)
    if (!doc) {
      log(`skipped ${spec.file} (not found)`)
      continue
    }
    const ops = listOperations(doc)
    opsBySpec.set(spec.key, ops)
    for (const op of ops) specIndex.set(opKey(op.method, op.route), {spec, op})
  }

  // Scan existing pages: record which operations are covered and learn the
  // tag -> folder naming from where those pages already live.
  const covered = new Set()
  const orphans = []
  const tagFolders = new Map(SPECS.map(s => [s.key, new Map()]))
  for (const file of await walkMdx(API_ROOT)) {
    const field = readOpenapiField(await fs.readFile(file, "utf8"))
    if (!field) continue
    const parts = field.trim().split(/\s+/)
    if (parts.length < 2) continue
    const key = opKey(parts[0], parts[1])
    covered.add(key)
    const indexed = specIndex.get(key)
    if (!indexed) {
      orphans.push({file: relToNext(file), openapi: field})
      continue
    }
    const rel = toPosix(path.relative(API_ROOT, file)).split("/")
    if (indexed.spec.groupByTag && rel.length === 3 && indexed.op.tag) {
      tagFolders.get(indexed.spec.key).set(indexed.op.tag, rel[1])
    }
  }

  // Bucket every uncovered operation by its target folder.
  const buckets = new Map()
  for (const spec of SPECS) {
    for (const op of opsBySpec.get(spec.key) ?? []) {
      const key = opKey(op.method, op.route)
      if (covered.has(key)) {
        if (VERBOSE) log(`ok   ${key}`)
        continue
      }
      let folderRel
      let tag
      if (spec.groupByTag) {
        tag = op.tag ?? "misc"
        const folderName = tagFolders.get(spec.key).get(tag) ?? slugify(tag) ?? "misc"
        folderRel = `${spec.dir}/${folderName}`
      } else {
        folderRel = spec.dir
      }
      if (!buckets.has(folderRel)) {
        buckets.set(folderRel, {
          spec,
          tag,
          folderRel,
          folderAbs: path.join(API_ROOT, folderRel),
          ops: [],
        })
      }
      buckets.get(folderRel).ops.push(op)
    }
  }

  // Record folder existence before any writes (needed for meta.json planning).
  for (const bucket of buckets.values()) {
    bucket.folderExisted = await dirExists(bucket.folderAbs)
  }

  // Assign collision-free filenames and build the page contents.
  const created = []
  for (const bucket of buckets.values()) {
    const taken = new Set(await listPageNames(bucket.folderAbs))
    const slugCount = new Map()
    for (const op of bucket.ops) {
      const slug = slugify(op.summary || op.operationId || op.route)
      slugCount.set(slug, (slugCount.get(slug) ?? 0) + 1)
    }
    for (const op of bucket.ops) {
      const base = slugify(op.summary || op.operationId || op.route) || "endpoint"
      let name = base
      for (let n = 1; taken.has(name); n += 1) name = `${base}-${n}`
      taken.add(name)

      const rawTitle =
        bucket.spec.key === "smc-index"
          ? (op.summary || op.operationId).replace(/\s+method$/i, "")
          : op.summary || op.operationId || op.route
      let title = prettifyTitle(rawTitle) || name
      // Disambiguate pages that share a summary (e.g. GET + POST on one path).
      if ((slugCount.get(base) ?? 0) > 1) title += ` (${op.method.toUpperCase()})`

      const fileRel = `${bucket.folderRel}/${name}.mdx`
      created.push({
        bucket,
        name,
        openapi: `${op.method} ${op.route}`,
        fileAbs: path.join(API_ROOT, fileRel),
        content: renderPage({
          title,
          idPath: `${ID_PREFIX}/${fileRel.replace(/\.mdx$/, "")}`,
          method: op.method,
          route: op.route,
          description: firstSentence(op.description || op.summary),
        }),
      })
    }
  }

  // Write the new pages.
  for (const page of created) {
    if (DRY_RUN) {
      log(`would create ${relToNext(page.fileAbs)}  (${page.openapi})`)
    } else {
      await fs.mkdir(path.dirname(page.fileAbs), {recursive: true})
      await fs.writeFile(page.fileAbs, page.content, "utf8")
      log(`created ${relToNext(page.fileAbs)}  (${page.openapi})`)
    }
  }

  // Refresh meta.json for every leaf folder that gained pages.
  const changedMeta = []
  const leafFolders = new Map()
  for (const page of created) {
    const {bucket} = page
    if (!leafFolders.has(bucket.folderRel)) leafFolders.set(bucket.folderRel, {bucket, names: []})
    leafFolders.get(bucket.folderRel).names.push(page.name)
  }
  for (const {bucket, names} of leafFolders.values()) {
    const metaAbs = path.join(bucket.folderAbs, "meta.json")
    const pages = [...new Set([...(await listPageNames(bucket.folderAbs)), ...names])].sort()
    const title = (await readMetaTitle(metaAbs)) ?? bucket.tag ?? bucket.folderRel
    await writeIfChanged(metaAbs, JSON.stringify({title, pages}, null, 2) + "\n", changedMeta)
  }

  // Register brand-new tag folders in their group's meta.json (v2/, v3/).
  const groupUpdates = new Map()
  for (const bucket of buckets.values()) {
    if (!bucket.spec.groupByTag || bucket.folderExisted) continue
    if (!groupUpdates.has(bucket.spec.dir)) {
      groupUpdates.set(bucket.spec.dir, {spec: bucket.spec, subs: []})
    }
    groupUpdates.get(bucket.spec.dir).subs.push(bucket.folderRel.split("/")[1])
  }
  for (const {spec, subs} of groupUpdates.values()) {
    const groupAbs = path.join(API_ROOT, spec.dir)
    const metaAbs = path.join(groupAbs, "meta.json")
    const pages = [...new Set([...(await listSubdirs(groupAbs)), ...subs])].sort()
    const title = (await readMetaTitle(metaAbs)) ?? spec.groupTitle
    await writeIfChanged(metaAbs, JSON.stringify({title, pages}, null, 2) + "\n", changedMeta)
  }

  // Summary.
  console.log("")
  for (const spec of SPECS) {
    const ops = opsBySpec.get(spec.key)
    if (!ops) continue
    const fresh = created.filter(p => p.bucket.spec.key === spec.key).length
    log(`${spec.key}: ${ops.length} operations, ${ops.length - fresh} covered, ${fresh} new`)
  }
  if (orphans.length > 0) {
    console.log("")
    log(`${orphans.length} page(s) reference an operation absent from the specs:`)
    for (const orphan of orphans) log(`  - ${orphan.file}  (openapi: ${orphan.openapi})`)
  }
  console.log("")
  if (created.length === 0 && changedMeta.length === 0) {
    log("all operations already have a page — nothing to generate.")
  } else {
    const verb = DRY_RUN ? "would generate" : "generated"
    log(
      `${verb} ${created.length} page(s); ` +
        `${changedMeta.length} meta.json file(s) ${DRY_RUN ? "would change" : "updated"}.`,
    )
  }
}

main().catch(error => {
  console.error("[generate-openapi] failed:", error)
  process.exitCode = 1
})
