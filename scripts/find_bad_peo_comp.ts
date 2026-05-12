import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  // Find filings with at least one PEO/NEO comp value > $1B
  const r = await pool.query<{ ticker: string | null; accession_number: string; max_comp: number; concept: string }>(
    `select c.ticker, x.accession_number, x.concept, max(x.numeric_value)::float as max_comp
     from ixbrl_facts x
     left join companies c on c.cik = x.cik
     where x.concept in (
       'ecd:PeoTotalCompAmt',
       'ecd:PeoActuallyPaidCompAmt',
       'ecd:NonPeoNeoAvgTotalCompAmt',
       'ecd:NonPeoNeoAvgCompActuallyPaidAmt'
     )
     and x.numeric_value > 1e9
     group by c.ticker, x.accession_number, x.concept
     order by max_comp desc`,
  );
  console.log(`${r.rows.length} (ticker, filing, concept) rows have PvP comp > $1B`);
  for (const row of r.rows.slice(0, 30)) {
    console.log(
      `  ${(row.ticker ?? "—").padEnd(8)} ${row.concept.padEnd(45)} max=$${(row.max_comp / 1e9).toFixed(2)}B accn=${row.accession_number}`,
    );
  }
  if (r.rows.length > 30) console.log(`  … and ${r.rows.length - 30} more`);

  // Unique tickers to re-parse
  const tickers = [...new Set(r.rows.map((row) => row.ticker).filter((t): t is string => !!t))];
  console.log(`\nUnique tickers needing re-parse: ${tickers.length}`);
  console.log(tickers.join(" "));

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
