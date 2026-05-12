// Repair xbrl_pay_vs_performance rows whose PEO/NEO comp values were
// over-scaled by the iXBRL parser before the decimals/scale-consistency
// heuristic was added. We trust ixbrl_facts as the corrected source.
import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  // For each (cik, year) with a stored comp value > $1B, replace with the
  // corresponding ixbrl_facts numeric_value (now correctly parsed).
  // Pull the corrected facts grouped by (cik, period_end_year, concept).
  const upd = await pool.query<{
    cik: string;
    fiscal_year: number;
    peo_tc: number | null;
    peo_cap: number | null;
    neo_avg_tc: number | null;
    neo_avg_cap: number | null;
  }>(
    `with corrected as (
       select cik, extract(year from period_end)::int as fy,
              min(case when concept='ecd:PeoTotalCompAmt' then numeric_value end) as peo_tc,
              min(case when concept='ecd:PeoActuallyPaidCompAmt' then numeric_value end) as peo_cap,
              min(case when concept='ecd:NonPeoNeoAvgTotalCompAmt' then numeric_value end) as neo_avg_tc,
              min(case when concept='ecd:NonPeoNeoAvgCompActuallyPaidAmt' then numeric_value end) as neo_avg_cap
       from ixbrl_facts
       where concept in (
         'ecd:PeoTotalCompAmt','ecd:PeoActuallyPaidCompAmt',
         'ecd:NonPeoNeoAvgTotalCompAmt','ecd:NonPeoNeoAvgCompActuallyPaidAmt'
       )
       and period_end is not null
       and numeric_value is not null
       group by cik, extract(year from period_end)
     )
     update xbrl_pay_vs_performance x
     set peo_total_comp = coalesce(c.peo_tc, x.peo_total_comp),
         peo_compensation_actually_paid = coalesce(c.peo_cap, x.peo_compensation_actually_paid),
         non_peo_neo_avg_total_comp = coalesce(c.neo_avg_tc, x.non_peo_neo_avg_total_comp),
         non_peo_neo_avg_compensation_actually_paid = coalesce(c.neo_avg_cap, x.non_peo_neo_avg_compensation_actually_paid),
         pulled_at = now()
     from corrected c
     where x.cik = c.cik and x.fiscal_year = c.fy
       and (
         coalesce(x.peo_total_comp, 0) > 1e9
         or coalesce(x.peo_compensation_actually_paid, 0) > 1e9
         or abs(coalesce(x.peo_compensation_actually_paid, 0)) > 1e9
         or coalesce(x.non_peo_neo_avg_total_comp, 0) > 1e9
         or coalesce(x.non_peo_neo_avg_compensation_actually_paid, 0) > 1e9
       )
     returning x.cik, x.fiscal_year,
               x.peo_total_comp as peo_tc,
               x.peo_compensation_actually_paid as peo_cap,
               x.non_peo_neo_avg_total_comp as neo_avg_tc,
               x.non_peo_neo_avg_compensation_actually_paid as neo_avg_cap`,
  );
  console.log(`updated ${upd.rows.length} rows`);
  for (const r of upd.rows) console.log(r);

  // Verify no stragglers
  const stragglers = await pool.query<{ cnt: number }>(
    `select count(*)::int as cnt from xbrl_pay_vs_performance
     where peo_total_comp > 1e9
        or peo_compensation_actually_paid > 1e9
        or non_peo_neo_avg_total_comp > 1e9
        or non_peo_neo_avg_compensation_actually_paid > 1e9`,
  );
  console.log(`remaining rows with comp > $1B: ${stragglers.rows[0]!.cnt}`);

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
