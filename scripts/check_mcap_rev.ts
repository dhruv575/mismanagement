import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  // 1. Coverage: shares + price + revenue across the R3K
  const cov = await pool.query<{
    total: number; have_shares: number; have_price: number; have_revenue_any: number; have_mcap: number;
  }>(
    `with
       sh as (select cik from financial_metrics where concept='shares_outstanding_latest' and fiscal_year=-1),
       px as (select distinct ticker from price_history),
       rv as (select distinct cik from financial_metrics where concept='revenue' and fiscal_year > 0)
     select count(*)::int as total,
            count(sh.cik)::int as have_shares,
            count(px.ticker)::int as have_price,
            count(rv.cik)::int as have_revenue_any,
            count(case when sh.cik is not null and px.ticker is not null then 1 end)::int as have_mcap
     from companies c
     left join sh on sh.cik = c.cik
     left join px on px.ticker = c.ticker
     left join rv on rv.cik = c.cik
     where c.is_russell_3000`,
  );
  console.log("R3K coverage:");
  console.log(cov.rows[0]);

  // 2. Sample for a few tickers
  for (const t of ["AAPL", "MSFT", "ETSY", "PLTK", "META"]) {
    const r = await pool.query(
      `select c.ticker,
              (select value from financial_metrics
                where cik=c.cik and concept='shares_outstanding_latest' and fiscal_year=-1) as shares,
              (select adj_close from price_history
                where ticker=c.ticker order by trading_date desc limit 1) as last_price,
              (select value from financial_metrics
                where cik=c.cik and concept='revenue' and fiscal_year > 0
                order by fiscal_year desc limit 1) as latest_revenue,
              (select max(fiscal_year) from financial_metrics
                where cik=c.cik and concept='revenue' and fiscal_year > 0) as latest_rev_year
       from companies c where c.ticker=$1`,
      [t],
    );
    console.log(r.rows[0]);
  }

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
