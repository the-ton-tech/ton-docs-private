/**
 * Parse + validate sub-agent JSON outputs. Sub-agents are instructed to Write
 * pure JSON to a known path, but we don't trust formats; we validate every
 * file against its zod schema and report any failure with enough context to
 * fix or retry the offending sub-agent.
 */
import {readFileSync} from "node:fs"
import {z} from "zod"

export interface ValidationOk<T> {
  ok: true
  value: T
  file: string
}
export interface ValidationErr {
  ok: false
  error: string
  file: string
}
export type ValidationResult<T> = ValidationOk<T> | ValidationErr

export function readAndValidate<T>(
  file: string,
  schema: z.ZodType<T>,
): ValidationResult<T> {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (e) {
    return {ok: false, error: `read failed: ${(e as Error).message}`, file}
  }
  // Tolerate a small amount of agent slop: ```json fences, leading/trailing
  // prose. We extract the first JSON object/array we can balance-parse.
  const cleaned = extractJsonBody(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    return {ok: false, error: `JSON.parse: ${(e as Error).message}`, file}
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    return {
      ok: false,
      error:
        "zod: " +
        result.error.issues
          .slice(0, 5)
          .map(i => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      file,
    }
  }
  return {ok: true, value: result.data, file}
}

/** Find the first {...} or [...] balanced JSON body in the string. */
function extractJsonBody(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed

  // Strip ```json ... ``` fence if present.
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed)
  if (fence) return fence[1].trim()

  // Last resort: find first { or [ and scan to the matching close.
  let start = -1
  let open: "{" | "[" | null = null
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "{" || trimmed[i] === "[") {
      start = i
      open = trimmed[i] as "{" | "["
      break
    }
  }
  if (start < 0 || open === null) return trimmed
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i]
    if (esc) {
      esc = false
      continue
    }
    if (c === "\\") {
      esc = true
      continue
    }
    if (c === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return trimmed.slice(start, i + 1)
    }
  }
  return trimmed.slice(start)
}
