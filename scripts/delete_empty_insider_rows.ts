import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query<{ accession_number: string; min_date: string }>(
    `select accession_number, min(filed_at)::text as min_date
     from insider_transactions
     where insider_name is null or insider_name = ''
     group by accession_number`,
  );
  console.log(`${r.rows.length} affected accessions`);
  const minDate = r.rows.map((x) => x.min_date).filter(Boolean).sort()[0];
  console.log(`min date: ${minDate}`);

  if (r.rows.length === 0) {
    await pool.end();
    return;
  }
  const accns = r.rows.map((x) => x.accession_number);
  const del = await pool.query(
    `delete from insider_transactions where accession_number = any($1::text[])`,
    [accns],
  );
  console.log(`deleted ${del.rowCount} rows`);
  console.log(`now re-run: pnpm exec tsx src/pull-form4.ts --since=${minDate} --concurrency=8`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
