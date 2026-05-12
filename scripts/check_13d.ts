import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query(
    `select accession_number, primary_doc_url, filing_date::text from filings
     where cik='0001370637' and form like 'SC 13%'
     order by filing_date desc limit 5`,
  );
  for (const row of r.rows) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
