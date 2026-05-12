import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query(
    `select fiscal_year, peo_total_comp, peo_compensation_actually_paid,
            company_tsr_indexed, peer_group_tsr_indexed, gaap_net_income, accession_number
     from xbrl_pay_vs_performance x join companies c on c.cik = x.cik
     where c.ticker = 'KSS' order by fiscal_year desc`,
  );
  for (const row of r.rows) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
