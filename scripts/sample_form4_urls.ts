import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query<{ primary_doc_url: string }>(
    `select distinct primary_doc_url from filings where form = '4' and primary_doc_url is not null limit 30`,
  );
  for (const row of r.rows) console.log(row.primary_doc_url);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
