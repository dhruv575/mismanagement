import { pool } from "../packages/ingest/src/db.js";
import { EDGAR_USER_AGENT } from "../packages/ingest/src/env.js";

async function main(): Promise<void> {
  const r = await pool.query<{ primary_doc_url: string }>(
    `select primary_doc_url from filings
     where accession_number = '0001193125-25-053042' and primary_doc_url is not null`,
  );
  const url = r.rows[0]!.primary_doc_url;
  console.log("fetching", url);
  const res = await fetch(url, {
    headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
  });
  const html = await res.text();
  // Find TotalShareholderRtnAmt tags
  const tagRe = /<ix:nonFraction[^>]*name="ecd:TotalShareholderRtnAmt"[^>]*>[\s\S]*?<\/ix:nonFraction>/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = tagRe.exec(html)) !== null) {
    console.log(`\n--- TSR match ${++i} ---`);
    console.log(m[0].slice(0, 600));
    if (i > 6) break;
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
