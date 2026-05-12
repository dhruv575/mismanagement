// Populates companies.market_cap_at_universe_pull from latest price ×
// latest shares outstanding. Idempotent. Run once now to fill the
// universe-wide null; the field is a snapshot, so this script can be
// re-run whenever the team wants to refresh it.
import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  const upd = await pool.query<{ cnt: number }>(
    `with latest_price as (
       select distinct on (ticker) ticker, adj_close
       from price_history
       order by ticker, trading_date desc
     ),
     latest_shares as (
       select cik, value as shares
       from financial_metrics
       where concept = 'shares_outstanding_latest' and fiscal_year = -1
     )
     update companies c
     set market_cap_at_universe_pull = ls.shares * lp.adj_close,
         universe_pulled_at = now()
     from latest_price lp
     join latest_shares ls on true
     where lp.ticker = c.ticker
       and ls.cik = c.cik
     returning c.cik`,
  );
  console.log(`updated ${upd.rowCount} rows`);

  // Quick sanity check
  const cov = await pool.query<{
    total: number;
    have_mcap: number;
    mcap_p25: number;
    mcap_p50: number;
    mcap_p75: number;
  }>(
    `select count(*)::int as total,
            count(market_cap_at_universe_pull)::int as have_mcap,
            percentile_cont(0.25) within group (order by market_cap_at_universe_pull) as mcap_p25,
            percentile_cont(0.50) within group (order by market_cap_at_universe_pull) as mcap_p50,
            percentile_cont(0.75) within group (order by market_cap_at_universe_pull) as mcap_p75
     from companies where is_russell_3000`,
  );
  console.log(cov.rows[0]);

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
