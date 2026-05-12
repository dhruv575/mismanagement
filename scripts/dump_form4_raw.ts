import { pool } from "../packages/ingest/src/db.js";
import { EDGAR_USER_AGENT } from "../packages/ingest/src/env.js";

async function main(): Promise<void> {
  const accn = process.argv[2]!;
  const r = await pool.query<{ primary_doc_url: string; cik: string }>(
    `select primary_doc_url, cik from filings where accession_number = $1`,
    [accn],
  );
  const url = r.rows[0]!.primary_doc_url;
  console.log("primary_doc_url:", url);
  // Derive raw xml
  const guess = url.replace(/\/xslF345X0\d\//, "/");
  console.log("trying:", guess);
  const res = await fetch(guess, { headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" } });
  if (!res.ok) {
    console.log("guess failed", res.status);
    process.exit(1);
  }
  const xml = await res.text();
  console.log(xml.slice(0, 3500));
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
