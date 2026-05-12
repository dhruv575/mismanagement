// One-shot remediation for filings affected by the iXBRL scale-attribute bug
// on PvP TSR fields (ecd:TotalShareholderRtnAmt / Peer...). The parser fix
// in pull-ixbrl.ts handles the case correctly going forward; this script
// repairs already-ingested data.
//
// Steps:
//   1. Find every (cik, accession) with at least one stored TSR > 10000.
//   2. Re-fetch + re-parse those filings via pull-ixbrl --force.
//   3. Read the corrected ixbrl_facts values and UPDATE
//      xbrl_pay_vs_performance.{company_tsr_indexed,peer_group_tsr_indexed}.
//      Backfill normally uses COALESCE so it won't overwrite the stale values.

import { spawn } from "node:child_process";
import { pool } from "../packages/ingest/src/db.js";

async function run(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: true });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

async function main(): Promise<void> {
  console.log("1) finding affected filings…");
  const affected = await pool.query<{ ticker: string }>(
    `select distinct c.ticker
     from ixbrl_facts x
     join companies c on c.cik = x.cik
     where x.concept in ('ecd:TotalShareholderRtnAmt','ecd:PeerGroupTotalShareholderRtnAmt')
       and x.numeric_value > 10000
       and c.ticker is not null`,
  );
  const tickers = affected.rows.map((r) => r.ticker);
  console.log(`   ${tickers.length} tickers: ${tickers.join(" ")}`);

  if (tickers.length > 0) {
    console.log("\n2) re-parsing with corrected scale logic…");
    await run("pnpm", [
      "--filter", "@activist/ingest", "exec",
      "tsx", "src/pull-ixbrl.ts", "--force", "--concurrency=4", ...tickers,
    ]);
  }

  console.log("\n3) patching xbrl_pay_vs_performance TSR fields from corrected facts…");
  // Use the period-end year to map ixbrl_facts to xbrl_pay_vs_performance rows.
  // We pick the row with no dimension_members (the consolidated row); when
  // multiple rows share a (cik, year) we take min(numeric_value) since for
  // these specific filings the dim-free one is always the smallest.
  const upd = await pool.query<{ cik: string; fiscal_year: number; company_tsr: number | null; peer_tsr: number | null }>(
    `with co as (
       select cik, extract(year from period_end)::int as fy,
              min(numeric_value) as v
       from ixbrl_facts
       where concept = 'ecd:TotalShareholderRtnAmt'
       group by cik, extract(year from period_end)
     ),
     peer as (
       select cik, extract(year from period_end)::int as fy,
              min(numeric_value) as v
       from ixbrl_facts
       where concept = 'ecd:PeerGroupTotalShareholderRtnAmt'
       group by cik, extract(year from period_end)
     )
     update xbrl_pay_vs_performance x
     set company_tsr_indexed = co.v,
         peer_group_tsr_indexed = peer.v,
         pulled_at = now()
     from co
     left join peer on peer.cik = co.cik and peer.fy = co.fy
     where x.cik = co.cik and x.fiscal_year = co.fy
       and (
         (x.company_tsr_indexed is not null and x.company_tsr_indexed > 10000)
         or (x.peer_group_tsr_indexed is not null and x.peer_group_tsr_indexed > 10000)
       )
     returning x.cik, x.fiscal_year, x.company_tsr_indexed as company_tsr, x.peer_group_tsr_indexed as peer_tsr`,
  );
  console.log(`   updated ${upd.rows.length} rows in xbrl_pay_vs_performance`);
  for (const row of upd.rows) {
    console.log(`   cik=${row.cik} fy=${row.fiscal_year} co=${row.company_tsr} peer=${row.peer_tsr}`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
