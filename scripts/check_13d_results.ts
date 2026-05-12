import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  const r = await pool.query(
    `select t.filing_date::text, t.form, t.filer_name, t.aggregate_percent,
            t.is_active_intent, t.cooperation_agreement_present,
            t.purpose_summary
     from thirteen_d_filings t join companies c on c.cik = t.cik
     where c.ticker = 'ETSY'
     order by t.filing_date desc, t.filer_name`,
  );
  console.log(`${r.rows.length} 13D/G filings on Etsy:`);
  for (const row of r.rows) {
    const pct = row.aggregate_percent != null ? `${row.aggregate_percent}%` : "—";
    const active = row.is_active_intent === true ? "ACTIVE" : row.is_active_intent === false ? "passive" : "?";
    const coop = row.cooperation_agreement_present ? " [coop]" : "";
    console.log(
      `${row.filing_date}  ${row.form.padEnd(10)}  ` +
        `${(row.filer_name || "").slice(0, 38).padEnd(38)} ` +
        `${pct.padStart(6)}  ${active}${coop}`,
    );
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
