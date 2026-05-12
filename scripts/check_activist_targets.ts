import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const tickers = ['INTC','M','DIS','BBWI','PARA','SBUX','TRIP','PINS','MTCH','HOG','VFC','BIIB','CVS','BA','TPR','LYFT','PYPL','KSS','GPS','PTON'];
  const r = await pool.query(
    `select c.ticker, x.fiscal_year, round(x.peo_total_comp/1e6)::int as peo_m,
            x.company_tsr_indexed::int as tsr_co, x.peer_group_tsr_indexed::int as tsr_pr
     from xbrl_pay_vs_performance x join companies c on c.cik = x.cik
     where c.ticker = any($1) order by c.ticker, x.fiscal_year desc`,
    [tickers],
  );
  console.log("ticker fy  peo$M  Co.TSR  Peer.TSR  gap");
  for (const row of r.rows) {
    const gap = row.tsr_pr - row.tsr_co;
    console.log(`${row.ticker.padEnd(7)}${row.fiscal_year}  ${String(row.peo_m).padStart(5)}  ${String(row.tsr_co).padStart(6)}  ${String(row.tsr_pr).padStart(8)}  ${String(gap).padStart(4)}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
