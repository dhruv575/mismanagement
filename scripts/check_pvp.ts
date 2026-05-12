import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  const r = await pool.query(
    `select c.ticker, x.fiscal_year, x.peo_total_comp, x.peo_compensation_actually_paid,
            x.company_tsr_indexed, x.peer_group_tsr_indexed, x.gaap_net_income
     from xbrl_pay_vs_performance x join companies c on c.cik = x.cik
     order by c.ticker, x.fiscal_year`,
  );
  console.log("ticker  fy    PEO total      PEO CAP        Co.TSR   Peer.TSR   NetInc");
  for (const row of r.rows) {
    console.log(
      `${row.ticker.padEnd(7)}${row.fiscal_year}  ` +
        `${fmtMoney(row.peo_total_comp)}  ${fmtMoney(row.peo_compensation_actually_paid)}  ` +
        `${fmtIdx(row.company_tsr_indexed)}  ${fmtIdx(row.peer_group_tsr_indexed)}  ` +
        `${fmtMoney(row.gaap_net_income)}`,
    );
  }
  await pool.end();
}

function fmtMoney(v: number | null): string {
  if (v == null) return "       —     ";
  const m = v / 1e6;
  return `$${m.toFixed(2).padStart(8)}M `;
}

function fmtIdx(v: number | null): string {
  if (v == null) return "    —  ";
  return `$${v.toFixed(2).padStart(6)}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
