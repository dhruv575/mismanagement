import { pool } from "../packages/ingest/src/db.js";
import { EDGAR_USER_AGENT } from "../packages/ingest/src/env.js";

async function main(): Promise<void> {
  const ticker = process.argv[2]!;
  const r = await pool.query<{ primary_doc_url: string; accession_number: string }>(
    `select f.primary_doc_url, f.accession_number from filings f
     join companies c on c.cik = f.cik
     where c.ticker = $1 and f.form = 'DEF 14A'
     order by f.filing_date desc limit 1`,
    [ticker],
  );
  const url = r.rows[0]!.primary_doc_url;
  console.log("fetching", url);
  const res = await fetch(url, {
    headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
  });
  const html = await res.text();
  const tagRe = /<ix:nonFraction[^>]*name="ecd:(?:TotalShareholderRtnAmt|PeerGroupTotalShareholderRtnAmt)"[^>]*>[\s\S]*?<\/ix:nonFraction>/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = tagRe.exec(html)) !== null) {
    console.log(`\n--- match ${++i} ---`);
    console.log(m[0].slice(0, 400));
    if (i > 10) break;
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
