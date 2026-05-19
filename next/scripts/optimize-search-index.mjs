// Post-build: turn the raw Fumadocs static Orama export (`out/api/search`,
// tens of MB of JSON) into a gzip-compressed, size-capped artifact the
// browser fetches and inflates client-side (see src/components/search.tsx).
//
// The raw export compresses ~6-11x. We additionally hard-split the gzip
// stream into <=45MB files so no single emitted asset can ever exceed the
// 50MB ceiling, then delete the oversized raw export.
import {readFileSync, writeFileSync, mkdirSync, rmSync, existsSync} from "node:fs"
import {gzipSync} from "node:zlib"
import path from "node:path"

const OUT = path.resolve(process.cwd(), "out")
const SRC = path.join(OUT, "api", "search")
const DIR = path.join(OUT, "api", "search-index")
// Keep every emitted file comfortably under the 50MB ceiling.
const MAX_FILE_BYTES = 45 * 1024 * 1024

if (!existsSync(SRC)) {
  console.error(
    `[optimize-search-index] ${SRC} not found — did \`next build\` run and emit the search route?`,
  )
  process.exit(1)
}

const raw = readFileSync(SRC)
const gz = gzipSync(raw, {level: 9})

mkdirSync(DIR, {recursive: true})
const segments = []
for (let offset = 0, i = 0; offset < gz.length; offset += MAX_FILE_BYTES, i++) {
  const name = `seg-${String(i).padStart(3, "0")}`
  writeFileSync(path.join(DIR, name), gz.subarray(offset, offset + MAX_FILE_BYTES))
  segments.push(name)
}
// Concatenating the segments in order byte-for-byte reproduces the gzip
// stream, so the client just fetches all segments, joins, and inflates.
writeFileSync(
  path.join(DIR, "manifest.json"),
  JSON.stringify({encoding: "gzip", bytes: gz.length, segments}),
)
rmSync(SRC)

const mb = n => (n / 1048576).toFixed(2)
console.log(
  `[optimize-search-index] raw ${mb(raw.length)}MB -> gzip ${mb(gz.length)}MB ` +
    `across ${segments.length} file(s) (cap ${mb(MAX_FILE_BYTES)}MB each); ` +
    `removed raw export ${path.relative(process.cwd(), SRC)}`,
)
