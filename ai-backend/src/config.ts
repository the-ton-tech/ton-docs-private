/**
 * Reads and validates environment variables, then exports a typed config object.
 * Throws a clear error on startup if a required variable is missing or invalid.
 */

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${name}: expected a positive integer, got "${raw}"`);
  }
  return parsed;
}

const openrouterKey = process.env.OPENROUTER_KEY?.trim();
if (!openrouterKey) {
  throw new Error(
    "Missing required environment variable OPENROUTER_KEY. " +
      "Copy .env.example to .env and set your OpenRouter API key.",
  );
}

const allowedOrigins = readString("ALLOWED_ORIGINS", "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

export interface Config {
  openrouterKey: string;
  model: string;
  port: number;
  allowedOrigins: string[];
  oramaSearchUrl: string;
  docsBaseUrl: string;
  dailyRequestCap: number;
  perIpDailyCap: number;
}

export const config: Config = {
  openrouterKey,
  model: readString("OPENROUTER_MODEL", "nvidia/nemotron-3-super-120b-a12b:free"),
  port: readInt("PORT", 8787),
  allowedOrigins,
  oramaSearchUrl: readString("ORAMA_SEARCH_URL", "http://127.0.0.1:7700").replace(/\/+$/, ""),
  // Canonical docs origin — the absolute base for the citation links the
  // model emits. Page content itself comes from the co-located Orama service
  // (oramaSearchUrl), not from here. Override during a staging cutover.
  docsBaseUrl: readString("DOCS_BASE_URL", "https://docs.ton.org").replace(/\/+$/, ""),
  dailyRequestCap: readInt("DAILY_REQUEST_CAP", 45),
  perIpDailyCap: readInt("PER_IP_DAILY_CAP", 10),
};
