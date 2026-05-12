import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const tickers = ['MTCH','PYPL','KSS','PARA','INTC','F','UAL','BIIB','LYFT','PINS','CHWY','BBWI','TRIP','SBUX'];
  const r = await pool.query(
    `with pvp_norm as (
       select *, coalesce(peo_total_comp, peo_compensation_actually_paid) as peo_chosen
       from xbrl_pay_vs_performance
     )
     select c.ticker,
       count(*)::int as total_pvp,
       count(*) filter (where peo_chosen is not null)::int as with_comp,
       round(max(case when fiscal_year >= 2024 then peer_group_tsr_indexed - company_tsr_indexed end))::int as latest_gap
     from companies c
     join pvp_norm p on p.cik = c.cik
     where c.ticker = any($1)
     group by c.ticker
     order by c.ticker`,
    [tickers],
  );
  for (const row of r.rows) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
