/**
 * Zod schemas for every sub-agent output. The sub-agents write JSON to
 * disk; the aggregator parses + validates with these. Strict parsing
 * surfaces malformed outputs at aggregation time (not silently downstream).
 *
 * Convention: each phase's output file is a SINGLE JSON object with a fixed
 * top-level shape (so the file is also human-greppable). Lists of items live
 * inside.
 */
import {z} from "zod"
import {INTENT_LABELS, LENGTH_LABELS, type PersonaKey} from "./personas"

const PERSONA_KEYS = ["novice", "expert", "non_native", "troubleshooter", "explorer"] as const

// ── Phase 2: Haiku candidate generation ───────────────────────────────────
export const haikuQuerySchema = z.object({
  q: z.string().min(2).max(100),
  intent: z.enum(INTENT_LABELS),
  persona: z.enum(PERSONA_KEYS),
  length: z.enum(LENGTH_LABELS),
  rationale: z.string().min(5).max(300),
})
export const haikuOutputSchema = z.object({
  page_url: z.string().startsWith("/"),
  queries: z.array(haikuQuerySchema).min(8).max(12),
  source_file: z.string(),
})
export type HaikuOutput = z.infer<typeof haikuOutputSchema>
export type HaikuQuery = z.infer<typeof haikuQuerySchema>

// ── Phase 3: Sonnet adversarial validation ────────────────────────────────
const VERDICT_LABELS = ["keep", "expand", "correct", "drop"] as const
export const sonnetVerdictSchema = z.object({
  id: z.number().int().min(0),
  verdict: z.enum(VERDICT_LABELS),
  // For keep/expand/correct: which URLs are correct. For drop: empty array.
  expect: z.array(z.string().startsWith("/")),
  reason: z.string().min(3).max(400),
})
export const sonnetOutputSchema = z.object({
  category_path: z.string().startsWith("/"),
  verdicts: z.array(sonnetVerdictSchema).min(1),
  category_observations: z.string().min(0).max(800),
})
export type SonnetVerdict = z.infer<typeof sonnetVerdictSchema>
export type SonnetOutput = z.infer<typeof sonnetOutputSchema>

// ── Phase 4/5: Opus graded ranking ────────────────────────────────────────
export const opusRatingSchema = z.object({
  url: z.string().startsWith("/"),
  grade: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  reason: z.string().nullable(),
})
export const opusRankingOutputSchema = z.object({
  query: z.string().min(1),
  session_id: z.number().int().min(1),
  ratings: z.array(opusRatingSchema).min(1),
  best_url: z.string().startsWith("/").nullable(),
  ambiguity_note: z.string().max(400),
})
export type OpusRating = z.infer<typeof opusRatingSchema>
export type OpusRankingOutput = z.infer<typeof opusRankingOutputSchema>

// ── Phase 6: Opus adversarial red-team ────────────────────────────────────
const FAILURE_CLASSES = [
  "stopword_strip",
  "bm25_length",
  "stem_collision",
  "identifier_miss",
  "pin_missing",
  "synonym_gap",
  "title_ambiguity",
  "exact_intent_drift",
  "typo_beyond_2",
  "other",
] as const
export const redTeamCaseSchema = z.object({
  q: z.string().min(2).max(120),
  intent: z.enum(INTENT_LABELS),
  should_rank_first: z.string().startsWith("/"),
  failure_category: z.enum(FAILURE_CLASSES),
  hypothesis: z.string().min(10).max(800),
})
export const redTeamOutputSchema = z.object({
  session_id: z.number().int().min(1),
  hard_cases: z.array(redTeamCaseSchema).min(1),
})
export type RedTeamCase = z.infer<typeof redTeamCaseSchema>
export type RedTeamOutput = z.infer<typeof redTeamOutputSchema>

// ── Shared structural types (not LLM outputs) ─────────────────────────────
export interface PageInfo {
  url: string
  title: string
  description: string
  breadcrumbs: string[]
  source_file: string // absolute path under content/docs
  h2_h3: string[] // first ~5 H2/H3 headings
}

export interface CandidateRecord {
  page_url: string // source page that proposed this candidate
  q: string
  intent: string
  persona: PersonaKey
  length: string
  rationale: string
}
