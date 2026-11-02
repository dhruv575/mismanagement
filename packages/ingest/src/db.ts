// Neon serverless Postgres client. The ingest scripts run in regular Node so
// we use the Pool client directly; the API uses the same library compiled for
// Edge runtime via Vercel.
import { Pool } from "@neondatabase/serverless";
import { DATABASE_URL } from "./env.js";

// Neon serverless defaults to a fairly aggressive idle/query timeout. The
// screen_board_failure query joins a handful of CTEs over the financial_metrics
// table (now ~50K+ rows with the enriched concept set) and can run >10s in
// cold-start mode. Bump both timeouts so heavy reporting queries finish.
export const pool = new Pool({
  connectionString: DATABASE_URL,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 120_000,
});

// Neon's WebSocket connections drop occasionally on long-running scripts.
// Without a pool-level error handler, an emitted "error" event on an idle
// client is uncaught and kills the whole process (we saw this on
// a long ingest run after ~275 issuers). The pool reconnects for
// subsequent queries on its own — we just need to swallow + log here.
pool.on("error", (err) => {
  console.error(`[db] idle client error (auto-reconnect on next query):`, err.message);
});
