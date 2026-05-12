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
export const OPENROUTER_API_KEY = required("OPENROUTER_API_KEY");
// Default to DeepSeek V4 Flash for text-only extraction (proxy narrative
// sections, 13D filings, transcripts). 1M context, fast + cheap. For vision
// tasks (rendered PDFs etc.) callers override with the Gemini model below.
export const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash";

// Vision tasks (rendered PDF pages, page images, etc.) -- the same model the
// UFO project uses for multimodal page extraction. Pass explicitly via
// `callOpenRouter({ model: VLM_MODEL })` at the call site.
export const VLM_MODEL =
  process.env.OPENROUTER_VLM_MODEL || "google/gemini-3-flash-preview";
export const EDGAR_USER_AGENT =
  process.env.EDGAR_USER_AGENT || "Activist Investing Research contact@example.com";
export const REPO_ROOT = repoRoot;
export const DATA_DIR = path.join(repoRoot, "data");
