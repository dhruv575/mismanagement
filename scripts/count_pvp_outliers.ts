import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query<{
    total_rows: number;
    peo_tc_gt_1b: number;
    peo_cap_gt_1b: number;
    neo_tc_gt_1b: number;
    neo_cap_gt_1b: number;
  }>(
    `select count(*)::int as total_rows,
            count(*) filter (where peo_total_comp > 1e9)::int as peo_tc_gt_1b,
            count(*) filter (where peo_compensation_actually_paid > 1e9 or peo_compensation_actually_paid < -1e9)::int as peo_cap_gt_1b,
            count(*) filter (where non_peo_neo_avg_total_comp > 1e9)::int as neo_tc_gt_1b,
            count(*) filter (where non_peo_neo_avg_compensation_actually_paid > 1e9 or non_peo_neo_avg_compensation_actually_paid < -1e9)::int as neo_cap_gt_1b
     from xbrl_pay_vs_performance`,
  );
  console.log(r.rows[0]);
  // Show the rows
  const top = await pool.query(
    `select c.ticker, x.fiscal_year, x.peo_total_comp, x.peo_compensation_actually_paid
     from xbrl_pay_vs_performance x
     join companies c on c.cik = x.cik
     where peo_total_comp > 1e9 or abs(peo_compensation_actually_paid) > 1e9
     order by greatest(coalesce(peo_total_comp,0), abs(coalesce(peo_compensation_actually_paid,0))) desc
     limit 20`,
  );
  for (const row of top.rows) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
