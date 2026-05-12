// HTTP-fetch Neon client (NOT the WebSocket Pool).
//
// Why: every Vercel Edge invocation gets a fresh V8 isolate. With the WS
// Pool that meant a brand-new WebSocket handshake to Neon on each cold
// start, and if Neon's free-tier compute had scaled to zero we'd also
// wait 1-5s for it to wake. Parallel queries on the company page
// (~10 fan-out requests) contended on isolate-local connection setup
// and routinely 500'd past the 25s Edge timeout.
//
// The HTTP driver is stateless: each query is a single HTTPS request
// against Neon's pooler. No handshake, no isolate-local state to keep
// warm, and the request body is the parameterized SQL. This matches the
// Neon-recommended pattern for serverless platforms.
//
// We expose a Pool-compatible `pool().query(text, params)` shim so the
// 50+ existing call sites in index.ts don't need to change.
import { neon } from "@neondatabase/serverless";
import { getDatabaseUrl } from "./env.js";

type QueryResult<T> = { rows: T[]; rowCount: number };

// neon() returns a tagged-template SQL function whose call signature
// also accepts (text, params). We use the call form. Types in the
// package don't cleanly expose both signatures, so we cast at the edge.
type SqlFn = (text: string, params: unknown[]) => Promise<unknown[]>;

let _sql: SqlFn | null = null;
function getSql(): SqlFn {
  if (!_sql) _sql = neon(getDatabaseUrl()) as unknown as SqlFn;
  return _sql;
}

export function pool() {
  return {
    async query<T = unknown>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<T>> {
      const sql = getSql();
      const rows = (await sql(text, params)) as T[];
      return { rows, rowCount: rows.length };
    },
  };
}
