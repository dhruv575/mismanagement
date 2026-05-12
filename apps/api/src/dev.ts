// Local dev: run the Hono app on Node with @hono/node-server. Loads .env from
// the repo root so DATABASE_URL is available without a Vercel project.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { serve } from "@hono/node-server";
import { app } from "./index.js";

const here = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(here), "..", "..", "..");
config({ path: path.join(repoRoot, ".env") });

const port = Number(process.env.PORT ?? 5071);
serve({ fetch: app.fetch, port });
console.log(`API listening on http://localhost:${port}/api`);
