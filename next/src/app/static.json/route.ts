import {exportSearchIndexes} from "@/lib/export-search-indexes"

// Prerendered at build time, then read by `scripts/sync-content.ts` and
// pushed to Algolia. `force-static` is required for the route to survive
// `output: "export"` (see next.config.mjs) — without it the static export
// build fails on this handler.
export const dynamic = "force-static"
export const revalidate = false

export function GET() {
  return Response.json(exportSearchIndexes())
}
