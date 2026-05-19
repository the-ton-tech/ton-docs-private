/**
 * User personas that Haiku is asked to embody when generating search queries
 * for a page. Each persona shapes both vocabulary and phrasing in ways the
 * heuristic miner (`mine-evalset.ts`) cannot reproduce. The set is small (5)
 * and overlapping-by-design: a real user is a mix, not a label. The personas
 * are SYNTHETIC — they don't map to real telemetry (we have none) — but they
 * cover the phrasing axes a docs-search must serve.
 */

export const PERSONAS = {
  novice: {
    description:
      "Newcomer to TON. Uses simple language, may not know precise terms " +
      "(says 'token contract' for jetton, 'address' for account, 'crash' for " +
      "exit code). Tends to ask 'how do I' / 'what is' rather than search by " +
      "identifier. Queries may be slightly verbose because they describe a " +
      "goal instead of naming a concept.",
  },
  expert: {
    description:
      "Senior TON / blockchain developer. Terse. Uses canonical jargon and " +
      "code symbols (OP_SENDMSG, op::transfer, loadUint, msg::value). Often " +
      "searches by identifier or specification term. Queries are short, " +
      "code-flavored, may include version numbers (wallet v5, tolk 0.7).",
  },
  non_native: {
    description:
      "Non-native English speaker (TON's community is global). Grammar may " +
      "be simpler — dropped articles, occasional preposition swaps — but the " +
      "vocabulary is still domain-correct. NOT a caricature: don't write " +
      "broken English; write minimally-marked, plausibly-fluent ESL.",
  },
  troubleshooter: {
    description:
      "Has a problem and wants a fix. Searches with the problem framing: " +
      "'transaction not bouncing', 'contract not deploying', 'blueprint " +
      "fails on testnet', 'mnemonic recovery wrong checksum'. Often pastes " +
      "an error symbol or message fragment.",
  },
  explorer: {
    description:
      "Browsing-style, vague intent. Wants to understand a topic, not solve " +
      "a specific task. Queries are noun-phrasey: 'sharding overview', " +
      "'consensus protocol ton', 'how blockchain works'. Cousin of " +
      "navigational but with broader intent.",
  },
} as const

export type PersonaKey = keyof typeof PERSONAS

export const INTENT_LABELS = [
  "navigational",
  "exact",
  "concept",
  "identifier",
  "synonym",
  "troubleshooting",
  "typo",
] as const

export type IntentLabel = (typeof INTENT_LABELS)[number]

export const LENGTH_LABELS = ["short", "medium", "long"] as const
export type LengthLabel = (typeof LENGTH_LABELS)[number]
