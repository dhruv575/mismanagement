import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query(
    `select c.ticker, fm.concept, fm.value, fm.unit
     from companies c join financial_metrics fm on fm.cik = c.cik
     where c.ticker in ('META','OKTA','ETSY')
       and fm.concept in (
         'shares_outstanding_latest','total_assets_latest','total_equity_latest',
         'goodwill_latest','accounts_receivable_latest','inventory_latest',
         'total_debt_latest','short_term_debt_latest'
       )
     order by c.ticker, fm.concept`,
  );
  for (const row of r.rows) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
