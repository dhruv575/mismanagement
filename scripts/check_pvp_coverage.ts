import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query(
    `with norm as (
       select cik, fiscal_year,
              coalesce(peo_total_comp, peo_compensation_actually_paid) as peo
       from xbrl_pay_vs_performance
     )
     select
       count(distinct cik)::int as ciks_with_pvp,
       count(distinct cik) filter (where peo is not null)::int as ciks_with_comp,
       count(*)::int as fact_rows,
       count(*) filter (where peo is not null)::int as fact_rows_with_comp
     from norm`,
  );
  console.log(r.rows[0]);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
