import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  // Count and list (cik, accession) pairs that have at least one TSR value > 10000.
  const r = await pool.query<{ cik: string; accession_number: string; ticker: string | null; max_tsr: number }>(
    `select x.cik, x.accession_number, c.ticker, max(x.numeric_value)::float as max_tsr
     from ixbrl_facts x
     left join companies c on c.cik = x.cik
     where x.concept in ('ecd:TotalShareholderRtnAmt','ecd:PeerGroupTotalShareholderRtnAmt')
       and x.numeric_value > 10000
     group by x.cik, x.accession_number, c.ticker
     order by max_tsr desc`,
  );
  console.log(`${r.rows.length} filings have at least one TSR > 10000 (scale bug)`);
  for (const row of r.rows.slice(0, 30)) {
    console.log(`  ${row.ticker?.padEnd(8) ?? "—"} max_tsr=${row.max_tsr.toFixed(0).padStart(10)} accn=${row.accession_number}`);
  }
  if (r.rows.length > 30) console.log(`  … and ${r.rows.length - 30} more`);

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
