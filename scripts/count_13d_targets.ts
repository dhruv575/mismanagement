import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query<{ since: string; cnt: number }>(
    `select 'all' as since, count(*)::int as cnt from filings
     where form in ('SC 13D','SC 13D/A')
     union all
     select 'since 2024-01-01', count(*)::int from filings
     where form in ('SC 13D','SC 13D/A') and filing_date > '2024-01-01'
     union all
     select 'since 2025-01-01', count(*)::int from filings
     where form in ('SC 13D','SC 13D/A') and filing_date > '2025-01-01'
     union all
     select 'already extracted', count(*)::int from thirteen_d_filings`,
  );
  for (const row of r.rows) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
