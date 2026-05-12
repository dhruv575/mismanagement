// Deterministic ranking of R3K companies by quantitative "board failing"
// signals. No LLM, no editorial framing -- pure SQL over the persisted
// fact tables. Each row carries the underlying numbers so a reader can
// audit why it's on the list.
//
// The composite score combines:
//
//   underperformance_pts = (peer_group_tsr_indexed - company_tsr_indexed)
//                          for the most recent fiscal year in PvP
//   peo_total_comp_median = median of PEO comp across available PvP years
//   score                = underperformance_pts * (peo_total_comp_median / 1e6)
//
// Filters:
//   * market_cap >= --min-mcap (default $500M) to avoid microcap noise
//   * pvp_years >= 3 (need persistent data, not one-off)
//   * --strict: company TSR < peer TSR in EVERY year of available PvP data
//
// Reader's job to interpret. Default sort is by composite_score desc.
//
// IMPLEMENTATION NOTE: After enriching the data set (financial_metrics now
// has 24 concepts × ~5 years × 2.5K issuers; xbrl_pay_vs_performance has
// ~10K rows) the original single-query CTE chain consistently exceeded
// Neon serverless's WS query timeout. We now run 4 small queries and join
// in JavaScript.

import { pool } from "../packages/ingest/src/db.js";

interface ScreenRow {
  ticker: string;
  cik: string;
  name: string;
  market_cap: number | null;
  pvp_years: number;
  years_underperformed: number;
  latest_pvp_year: number;
  company_tsr_indexed: number;
  peer_group_tsr_indexed: number;
  underperformance_pts: number;
  avg_underperformance_pts: number;
  peo_cap_total: number;
  peo_total_comp_median: number;
  peo_cap_latest: number | null;
  peo_total_comp_latest: number | null;
  net_income_latest: number | null;
  rev_5y_cagr: number | null;
  active_13d_count: number;
  insider_net_sales_12m: number | null;
  composite_score: number;
}

interface PvpAggRow {
  cik: string;
  ticker: string;
  name: string;
  pvp_years: number;
  years_underperformed: number;
  latest_pvp_year: number;
  peo_total_comp_5y: number;
  peo_total_comp_median: number;
  avg_gap: number | null;
  // Latest-year fields:
  latest_company_tsr: number | null;
  latest_peer_tsr: number | null;
  latest_peo_total_comp: number | null;
  latest_peo_cap: number | null;
  latest_peo_chosen: number | null;
  latest_gaap_ni: number | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = parseInt(argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "10", 10);
  const minMarketCap = parseFloat(argv.find((a) => a.startsWith("--min-mcap="))?.split("=")[1] ?? "500e6");
  const skipMarketCap = argv.includes("--no-mcap");
  const minPeoLatest = parseFloat(argv.find((a) => a.startsWith("--min-peo-latest="))?.split("=")[1] ?? "5e6");
  const maxPeoLatest = parseFloat(argv.find((a) => a.startsWith("--max-peo-latest="))?.split("=")[1] ?? "50e6");
  const strict = argv.includes("--strict");
  const minYearsUnder = parseInt(
    argv.find((a) => a.startsWith("--min-years-under="))?.split("=")[1] ?? (strict ? "0" : "3"),
    10,
  );

  // === Query 1: PvP aggregations + latest-year fields, joined to companies.
  // The double-join on xbrl_pay_vs_performance is the intentional shape:
  // one pass aggregates across years, the other picks the latest year row.
  console.log("query 1/4: pvp aggregates…");
  const pvpRes = await pool.query<PvpAggRow>(
    `with pvp_norm as (
       -- Scrub implausible per-executive-per-year values (~0.5% of rows
       -- are filer-tagging errors where decimals/scale/visible disagree;
       -- we can't disambiguate at parse time without table-caption HTML
       -- context). $1B cap is well above realistic annual exec comp; the
       -- Musk-tier outliers (TSLA, etc.) sit above it and are intentionally
       -- excluded from ranking. Raw values remain in
       -- xbrl_pay_vs_performance for audit / editorial copy.
       select x.cik, x.fiscal_year,
              case when abs(peo_total_comp) <= 1e9 then peo_total_comp end as peo_total_comp,
              case when abs(peo_compensation_actually_paid) <= 1e9 then peo_compensation_actually_paid end as peo_compensation_actually_paid,
              case when abs(non_peo_neo_avg_total_comp) <= 1e9 then non_peo_neo_avg_total_comp end as non_peo_neo_avg_total_comp,
              case when abs(non_peo_neo_avg_compensation_actually_paid) <= 1e9 then non_peo_neo_avg_compensation_actually_paid end as non_peo_neo_avg_compensation_actually_paid,
              company_tsr_indexed, peer_group_tsr_indexed,
              gaap_net_income,
              coalesce(
                case when abs(peo_total_comp) <= 1e9 then peo_total_comp end,
                case when abs(peo_compensation_actually_paid) <= 1e9 then peo_compensation_actually_paid end
              ) as peo_chosen
       from xbrl_pay_vs_performance x
     ),
     pvp_agg as (
       select cik,
              count(*)::int as pvp_years,
              count(*) filter (
                where company_tsr_indexed is not null
                  and peer_group_tsr_indexed is not null
                  and company_tsr_indexed < peer_group_tsr_indexed
              )::int as years_underperformed,
              max(fiscal_year) as latest_year_with_any_data,
              sum(coalesce(peo_chosen, 0)) as peo_total_comp_5y,
              percentile_cont(0.5) within group (order by peo_chosen) as peo_total_comp_median,
              avg(case
                    when company_tsr_indexed is not null and peer_group_tsr_indexed is not null
                    then peer_group_tsr_indexed - company_tsr_indexed
                  end) as avg_gap
       from pvp_norm
       group by cik
     ),
     pvp_latest as (
       select distinct on (cik) cik, fiscal_year as latest_pvp_year,
              company_tsr_indexed, peer_group_tsr_indexed,
              peo_total_comp, peo_compensation_actually_paid,
              peo_chosen, gaap_net_income
       from pvp_norm
       where company_tsr_indexed is not null and peer_group_tsr_indexed is not null
       order by cik, fiscal_year desc
     )
     select c.cik, c.ticker, c.name,
            pa.pvp_years, pa.years_underperformed, pl.latest_pvp_year,
            pa.peo_total_comp_5y, pa.peo_total_comp_median, pa.avg_gap,
            pl.company_tsr_indexed as latest_company_tsr,
            pl.peer_group_tsr_indexed as latest_peer_tsr,
            pl.peo_total_comp as latest_peo_total_comp,
            pl.peo_compensation_actually_paid as latest_peo_cap,
            pl.peo_chosen as latest_peo_chosen,
            pl.gaap_net_income as latest_gaap_ni
     from companies c
     join pvp_agg pa on pa.cik = c.cik
     join pvp_latest pl on pl.cik = c.cik
     where pa.pvp_years >= 3
       and pl.company_tsr_indexed < pl.peer_group_tsr_indexed
       and pl.peo_chosen between $1::float8 and $2::float8
       and ($3::boolean = false or pa.years_underperformed = pa.pvp_years)
       and pa.years_underperformed >= $4::int`,
    [minPeoLatest, maxPeoLatest, strict, minYearsUnder],
  );
  const candidates = pvpRes.rows;
  console.log(`  ${candidates.length} candidates pass PvP filters`);

  if (candidates.length === 0) {
    console.log("No rows. Try --min-mcap=100e6 or drop --strict.");
    await pool.end();
    return;
  }

  const candidateCiks = candidates.map((r) => r.cik);
  const candidateTickers = candidates.map((r) => r.ticker);

  // === Query 2: market cap (latest price × shares outstanding).
  console.log("query 2/4: market cap…");
  const mcRes = await pool.query<{ cik: string; market_cap: number }>(
    `with latest_price as (
       select distinct on (ticker) ticker, adj_close
       from price_history
       where ticker = any($1::text[])
       order by ticker, trading_date desc
     ),
     latest_shares as (
       select cik, value as shares
       from financial_metrics
       where concept = 'shares_outstanding_latest'
         and fiscal_year = -1
         and cik = any($2::text[])
     )
     select c.cik, ls.shares * lp.adj_close as market_cap
     from companies c
     join latest_price lp on lp.ticker = c.ticker
     join latest_shares ls on ls.cik = c.cik
     where c.cik = any($2::text[])`,
    [candidateTickers, candidateCiks],
  );
  const mcByCik = new Map(mcRes.rows.map((r) => [r.cik, r.market_cap]));

  // === Query 3: 5-year revenue CAGR for the candidate set only.
  console.log("query 3/4: revenue cagr…");
  const cagrRes = await pool.query<{ cik: string; cagr: number | null }>(
    `with rmy as (
       select cik, max(fiscal_year) as max_year
       from financial_metrics
       where concept = 'revenue' and fiscal_year > 0
         and cik = any($1::text[])
       group by cik
     )
     select rmy.cik,
            case
              when min(case when fm.fiscal_year = (rmy.max_year - 5) then fm.value end) > 0
              then power(
                max(case when fm.fiscal_year = rmy.max_year then fm.value end) /
                nullif(min(case when fm.fiscal_year = (rmy.max_year - 5) then fm.value end), 0),
                1.0/5
              ) - 1
            end as cagr
     from rmy
     join financial_metrics fm
       on fm.cik = rmy.cik and fm.concept = 'revenue'
      and fm.fiscal_year in (rmy.max_year, rmy.max_year - 5)
     group by rmy.cik`,
    [candidateCiks],
  );
  const cagrByCik = new Map(cagrRes.rows.map((r) => [r.cik, r.cagr]));

  // === Query 4: 13D activity + insider net flow for the candidate set.
  console.log("query 4/4: 13d + insider flow…");
  const sigRes = await pool.query<{ cik: string; cnt: number; net_buy_dollars: number | null }>(
    `with active_13d as (
       select cik, count(*)::int as cnt
       from filings
       where form in ('SC 13D', 'SC 13D/A')
         and filing_date > current_date - interval '18 months'
         and cik = any($1::text[])
       group by cik
     ),
     insider_net as (
       select cik,
              sum(case when transaction_code = 'P' then transaction_value
                       when transaction_code = 'S' then -transaction_value
                       else 0 end) as net_buy_dollars
       from insider_transactions
       where transaction_date > current_date - interval '12 months'
         and cik = any($1::text[])
       group by cik
     )
     select c.cik,
            coalesce(a.cnt, 0) as cnt,
            i.net_buy_dollars
     from companies c
     left join active_13d a on a.cik = c.cik
     left join insider_net i on i.cik = c.cik
     where c.cik = any($1::text[])`,
    [candidateCiks],
  );
  const sigByCik = new Map(sigRes.rows.map((r) => [r.cik, r]));

  // === Combine + filter by market cap + score in JS.
  const enriched: ScreenRow[] = [];
  for (const c of candidates) {
    const mc = mcByCik.get(c.cik) ?? null;
    if (!skipMarketCap && (mc === null || mc < minMarketCap)) continue;

    const gap = (c.latest_peer_tsr ?? 0) - (c.latest_company_tsr ?? 0);
    const score = gap * ((c.peo_total_comp_median ?? 0) / 1e6);

    enriched.push({
      ticker: c.ticker,
      cik: c.cik,
      name: c.name,
      market_cap: mc,
      pvp_years: c.pvp_years,
      years_underperformed: c.years_underperformed,
      latest_pvp_year: c.latest_pvp_year,
      company_tsr_indexed: c.latest_company_tsr ?? 0,
      peer_group_tsr_indexed: c.latest_peer_tsr ?? 0,
      underperformance_pts: gap,
      avg_underperformance_pts: c.avg_gap ?? 0,
      peo_cap_total: c.peo_total_comp_5y,
      peo_total_comp_median: c.peo_total_comp_median,
      peo_cap_latest: c.latest_peo_cap,
      peo_total_comp_latest: c.latest_peo_total_comp,
      net_income_latest: c.latest_gaap_ni,
      rev_5y_cagr: cagrByCik.get(c.cik) ?? null,
      active_13d_count: sigByCik.get(c.cik)?.cnt ?? 0,
      insider_net_sales_12m: sigByCik.get(c.cik)?.net_buy_dollars ?? null,
      composite_score: score,
    });
  }
  enriched.sort((a, b) => b.composite_score - a.composite_score);
  const rows = enriched.slice(0, limit);

  if (rows.length === 0) {
    console.log("No rows after market-cap filter. Try --no-mcap or lower --min-mcap.");
    await pool.end();
    return;
  }

  const mode = strict ? "strict" : minYearsUnder > 0 ? `min-${minYearsUnder}-years-under` : "loose";
  console.log(
    `\nTop ${rows.length} R3K board-failure candidates ` +
      `(mode=${mode}, min_mcap=$${(minMarketCap / 1e9).toFixed(1)}B):`,
  );
  console.log(
    "rank ticker  market_cap  yrs   Co  Peer  gap  avg     PEO    PEO_5y  rev5y  13D  insider   score",
  );
  console.log(
    "                          un.   TSR  TSR  pts  gap     med    total                                ",
  );
  let rank = 0;
  for (const row of rows) {
    rank++;
    const mc = row.market_cap != null ? `$${(row.market_cap / 1e9).toFixed(2)}B` : "—";
    const cagr = row.rev_5y_cagr != null ? `${(row.rev_5y_cagr * 100).toFixed(1)}%` : "—";
    const insider =
      row.insider_net_sales_12m != null
        ? `$${(row.insider_net_sales_12m / 1e6).toFixed(1)}M`
        : "—";
    const cap_total = `$${(row.peo_cap_total / 1e6).toFixed(0)}M`;
    const med = `$${(row.peo_total_comp_median / 1e6).toFixed(1)}M`;
    const yrs = `${row.years_underperformed}/${row.pvp_years}`;
    console.log(
      `${String(rank).padStart(3)}  ` +
        `${row.ticker.padEnd(7)} ` +
        `${mc.padStart(10)}  ` +
        `${yrs.padStart(5)}  ` +
        `${row.company_tsr_indexed.toFixed(0).padStart(4)} ` +
        `${row.peer_group_tsr_indexed.toFixed(0).padStart(4)}  ` +
        `${row.underperformance_pts.toFixed(0).padStart(4)}  ` +
        `${row.avg_underperformance_pts.toFixed(0).padStart(5)}  ` +
        `${med.padStart(7)}  ` +
        `${cap_total.padStart(7)}  ` +
        `${cagr.padStart(5)} ` +
        `${String(row.active_13d_count).padStart(3)} ` +
        `${insider.padStart(9)}  ` +
        `${row.composite_score.toFixed(0).padStart(5)}`,
    );
    console.log(`     ${row.name}`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
