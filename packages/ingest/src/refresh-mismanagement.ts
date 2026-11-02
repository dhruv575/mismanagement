// Recompute the mismanagement_scores table from primary sources. Run this
// after any ingest that changes the underlying data (pull-ecd, pull-form4,
// pull-13d, pull-ixbrl, pull-votes) or on a daily cron.
//
// The pipeline is the same CTE chain the API used to run on every
// /mismanagement request — but here we run it once and write the result.
// The API endpoints then just SELECT … FROM mismanagement_scores, which
// is sub-100ms even cold.
//
// Invocation:
//   pnpm refresh

import { pool } from "./db.js";

const SQL = `
  with pvp_clean as (
    select cik, fiscal_year, company_tsr_indexed, peer_group_tsr_indexed,
           case when abs(peo_total_comp) <= 1e9 then peo_total_comp end as peo_total_comp
    from xbrl_pay_vs_performance
  ),
  pvp_agg as (
    select cik,
           count(*) filter (
             where company_tsr_indexed is not null
               and peer_group_tsr_indexed is not null
               and company_tsr_indexed < peer_group_tsr_indexed
           )::int as years_under,
           count(*) filter (
             where company_tsr_indexed is not null
               and peer_group_tsr_indexed is not null
           )::int as years_tracked,
           percentile_cont(0.5) within group (order by peo_total_comp) as peo_median
    from pvp_clean
    group by cik
  ),
  pvp_latest as (
    select distinct on (cik) cik, fiscal_year, company_tsr_indexed, peer_group_tsr_indexed
    from pvp_clean
    where company_tsr_indexed is not null and peer_group_tsr_indexed is not null
    order by cik, fiscal_year desc
  ),
  latest_annual as (
    select distinct on (cik, concept) cik, concept, value
    from financial_metrics
    where fiscal_year > 0
      and concept in ('revenue','net_income','operating_cash_flow','capex','sbc','buybacks','dividends_paid')
    order by cik, concept, fiscal_year desc
  ),
  fm as (
    select cik,
           max(value) filter (where concept = 'revenue') as revenue,
           max(value) filter (where concept = 'net_income') as net_income,
           max(value) filter (where concept = 'operating_cash_flow') as ocf,
           max(value) filter (where concept = 'capex') as capex,
           max(value) filter (where concept = 'sbc') as sbc,
           max(value) filter (where concept = 'buybacks') as buybacks,
           max(value) filter (where concept = 'dividends_paid') as dividends_paid
    from latest_annual
    group by cik
  ),
  fm_pit as (
    select cik,
           max(value) filter (where concept = 'total_assets_latest') as total_assets,
           max(value) filter (where concept = 'goodwill_latest') as goodwill
    from financial_metrics
    where fiscal_year = -1 and concept in ('total_assets_latest','goodwill_latest')
    group by cik
  ),
  insider_net as (
    select cik, sum(case
                     when transaction_code = 'P' then transaction_value
                     when transaction_code = 'S' then -transaction_value
                     else 0
                   end) as net_dollars
    from insider_transactions
    where transaction_date >= current_date - interval '365 days'
    group by cik
  ),
  active_13d as (
    select cik, count(*)::int as n
    from thirteen_d_filings
    where is_active_intent = true
      and filing_date >= current_date - interval '18 months'
    group by cik
  ),
  vote_latest as (
    select distinct on (cik) cik, meeting_date, sop_support_pct, min_director_support_pct
    from shareholder_votes
    where sop_support_pct is not null or min_director_support_pct is not null
    order by cik, coalesce(meeting_date, filing_date) desc
  ),
  combined as (
    select c.cik,
      pa.years_under, pa.years_tracked, pa.peo_median,
      pl.company_tsr_indexed as latest_company_tsr,
      pl.peer_group_tsr_indexed as latest_peer_tsr,
      pl.fiscal_year as latest_pvp_year,
      fm.revenue, fm.net_income, fm.ocf, fm.capex, fm.sbc,
      fm.buybacks, fm.dividends_paid,
      fm_pit.total_assets, fm_pit.goodwill,
      coalesce(ind.net_dollars, 0)::float as insider_net_365d,
      coalesce(a13.n, 0)::int as active_13d_count,
      coalesce(pa.years_under >= 3, false) as flag_tsr_under,
      coalesce(pa.years_under >= 3 and pa.peo_median is not null and pa.peo_median >= 15e6, false) as flag_pay_through_it,
      (coalesce(a13.n, 0) > 0) as flag_active_13d,
      (coalesce(ind.net_dollars, 0) <= -10e6) as flag_insider_selling,
      coalesce(fm.ocf is not null and fm.net_income is not null and fm.net_income > 0
        and fm.ocf < 0.80 * fm.net_income, false) as flag_earnings_cash,
      coalesce(fm.revenue is not null and fm.revenue > 0 and fm.sbc is not null
        and fm.sbc > 0.10 * fm.revenue, false) as flag_dilutive_sbc,
      coalesce(fm.ocf is not null and fm.ocf > 0
        and (coalesce(fm.buybacks, 0) + coalesce(fm.dividends_paid, 0)) > fm.ocf, false) as flag_returns_over_fcf,
      coalesce(fm_pit.goodwill is not null and fm_pit.total_assets is not null
        and fm_pit.total_assets > 0 and fm_pit.goodwill > 0.40 * fm_pit.total_assets, false) as flag_goodwill_heavy,
      vl.sop_support_pct as latest_sop_support_pct,
      vl.min_director_support_pct as latest_min_director_support_pct,
      vl.meeting_date as latest_vote_meeting_date,
      coalesce(
        (vl.sop_support_pct is not null and vl.sop_support_pct < 80)
        or (vl.min_director_support_pct is not null and vl.min_director_support_pct < 80),
        false
      ) as flag_governance_dissent
    from companies c
    left join pvp_agg pa on pa.cik = c.cik
    left join pvp_latest pl on pl.cik = c.cik
    left join fm on fm.cik = c.cik
    left join fm_pit on fm_pit.cik = c.cik
    left join insider_net ind on ind.cik = c.cik
    left join active_13d a13 on a13.cik = c.cik
    left join vote_latest vl on vl.cik = c.cik
  )
  insert into mismanagement_scores (
    cik, years_under, years_tracked, peo_median,
    latest_company_tsr, latest_peer_tsr, latest_pvp_year,
    revenue, net_income, ocf, capex, sbc, buybacks, dividends_paid,
    total_assets, goodwill, insider_net_365d, active_13d_count,
    flag_tsr_under, flag_pay_through_it, flag_active_13d, flag_insider_selling,
    flag_earnings_cash, flag_dilutive_sbc, flag_returns_over_fcf, flag_goodwill_heavy,
    flag_governance_dissent, latest_sop_support_pct, latest_min_director_support_pct,
    latest_vote_meeting_date,
    flags_fired, tiebreak, refreshed_at
  )
  select
    cik, years_under, years_tracked, peo_median,
    latest_company_tsr, latest_peer_tsr, latest_pvp_year,
    revenue, net_income, ocf, capex, sbc, buybacks, dividends_paid,
    total_assets, goodwill, insider_net_365d, active_13d_count,
    flag_tsr_under, flag_pay_through_it, flag_active_13d, flag_insider_selling,
    flag_earnings_cash, flag_dilutive_sbc, flag_returns_over_fcf, flag_goodwill_heavy,
    flag_governance_dissent, latest_sop_support_pct, latest_min_director_support_pct,
    latest_vote_meeting_date,
    (case when flag_tsr_under then 1 else 0 end
      + case when flag_pay_through_it then 1 else 0 end
      + case when flag_active_13d then 1 else 0 end
      + case when flag_insider_selling then 1 else 0 end
      + case when flag_earnings_cash then 1 else 0 end
      + case when flag_dilutive_sbc then 1 else 0 end
      + case when flag_returns_over_fcf then 1 else 0 end
      + case when flag_goodwill_heavy then 1 else 0 end
      + case when flag_governance_dissent then 1 else 0 end
    ) as flags_fired,
    (coalesce(latest_peer_tsr, 0) - coalesce(latest_company_tsr, 0)) * coalesce(peo_median, 0) as tiebreak,
    now() as refreshed_at
  from combined
`;

async function main() {
  const t0 = performance.now();
  const client = await pool.connect();
  try {
    await client.query("begin");
    // TRUNCATE not DELETE — instant and reclaims space.
    await client.query("truncate mismanagement_scores");
    const r = await client.query(SQL);
    await client.query("commit");
    console.log(`refreshed mismanagement_scores: ${r.rowCount} rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
