import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Load .env from the repo root regardless of where the script was invoked.
const here = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(here), "..", "..", "..");
config({ path: path.join(repoRoot, ".env") });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (set it in .env at the repo root)`);
  return v;
}

export const DATABASE_URL = required("DATABASE_URL");
// LLM extraction (13D filings, 8-K vote results) goes through Vercel AI
// Gateway's OpenAI-compatible endpoint. The key is required lazily so the
// deterministic pulls run without one.
export function aiGatewayApiKey(): string {
  return required("AI_GATEWAY_API_KEY");
}
export const LLM_MODEL = process.env.LLM_MODEL || "mistral/mistral-nemo";
export const EDGAR_USER_AGENT =
  process.env.EDGAR_USER_AGENT || "Takeover contact@example.com";
export const REPO_ROOT = repoRoot;
export const DATA_DIR = path.join(repoRoot, "data");
