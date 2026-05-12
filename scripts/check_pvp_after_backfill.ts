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
  console.log("xbrl_pay_vs_performance summary:");
  console.log(r.rows[0]);

  const yrs = await pool.query<{ years_with_data: number; ciks: number }>(
    `with by_cik as (
       select cik, count(*) filter (
         where coalesce(peo_total_comp, peo_compensation_actually_paid) is not null
           and company_tsr_indexed is not null
           and peer_group_tsr_indexed is not null
       )::int as years_with_data
       from xbrl_pay_vs_performance
       group by cik
     )
     select years_with_data, count(*)::int as ciks
     from by_cik
     group by years_with_data
     order by years_with_data desc`,
  );
  console.log("\nCIKs by # of usable PvP years:");
  for (const row of yrs.rows) {
    console.log(`  ${row.years_with_data} years: ${row.ciks} CIKs`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
