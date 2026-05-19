import {getPageBreadcrumbs, getPageTag, getVisiblePages} from "@/lib/source"
import type {DocumentRecord} from "fumadocs-core/search/algolia"

/**
 * Builds the Algolia document records from the same visible page set the
 * sidebar uses (`getVisiblePages`), so hidden / unlinked pages stay out of
 * search just as they did with the previous Orama index.
 *
 * `breadcrumbs` and `tag` were previously omitted — the fumadocs search dialog
 * renders breadcrumbs as the only per-result secondary text, and `tag` drives
 * the dialog's filter + Algolia faceting, so both were dead weight until now.
 */
export function exportSearchIndexes(): DocumentRecord[] {
  return getVisiblePages().map(page => ({
    _id: page.url,
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    structured: page.data.structuredData,
    breadcrumbs: getPageBreadcrumbs(page),
    tag: getPageTag(page),
  }))
}
