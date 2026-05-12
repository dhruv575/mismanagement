// Two flat concept inventories — for the frontend agent to retarget queries.
import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  console.log("=== financial_metrics (logical concept names) ===");
  const fm = await pool.query<{ concept: string; rows: number; ciks: number }>(
    `select concept, count(*)::int as rows, count(distinct cik)::int as ciks
     from financial_metrics
     group by concept
     order by rows desc
     limit 50`,
  );
  console.log("concept                                rows   ciks");
  for (const r of fm.rows) {
    console.log(`  ${r.concept.padEnd(36)} ${String(r.rows).padStart(6)}  ${String(r.ciks).padStart(5)}`);
  }

  console.log("\n=== ixbrl_facts (raw XBRL concept names, top 50) ===");
  const ix = await pool.query<{ concept: string; rows: number; filings: number; with_numeric: number }>(
    `select concept,
            count(*)::int as rows,
            count(distinct accession_number)::int as filings,
            count(*) filter (where numeric_value is not null)::int as with_numeric
     from ixbrl_facts
     group by concept
     order by rows desc
     limit 50`,
  );
  console.log("concept                                            rows  filings  numeric");
  for (const r of ix.rows) {
    console.log(
      `  ${r.concept.padEnd(48)} ${String(r.rows).padStart(5)}  ${String(r.filings).padStart(6)}  ${String(r.with_numeric).padStart(6)}`,
    );
  }

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
