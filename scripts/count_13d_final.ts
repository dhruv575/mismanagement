import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where is_active_intent)::int as active_13d,
            count(distinct cik)::int as ciks_with_13d_or_g,
            count(distinct cik) filter (where is_active_intent)::int as ciks_with_active_13d,
            count(*) filter (where filing_date > current_date - interval '18 months')::int as last_18mo
     from thirteen_d_filings`,
  );
  console.log(r.rows[0]);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
