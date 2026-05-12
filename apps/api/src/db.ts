// Lazy Pool initialization so cold Edge invocations don't pay the connection
// cost when a request hits a route that doesn't need the DB.
import { Pool } from "@neondatabase/serverless";
import { getDatabaseUrl } from "./env.js";

let _pool: Pool | null = null;
export function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: getDatabaseUrl() });
  return _pool;
}
