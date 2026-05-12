import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query<{ last_filing: string; total: number }>(
    `select max(filing_date)::text as last_filing, count(*)::int as total from filings`,
  );
  console.log(r.rows[0]);
  const r2 = await pool.query<{ form: string; cnt: number }>(
    `select form, count(*)::int as cnt from filings
     where filing_date > '2026-01-01'
     group by form order by cnt desc`,
  );
  console.log("forms since 2026-01-01:");
  for (const row of r2.rows) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
