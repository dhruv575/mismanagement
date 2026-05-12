import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query(
    `select count(*)::int as total,
            count(*) filter (where insider_name is null or insider_name = '')::int as empty_name,
            count(*) filter (where officer_title is null)::int as empty_title,
            count(*) filter (where is_director is null)::int as null_director,
            count(*) filter (where is_officer is null)::int as null_officer,
            count(*) filter (where is_ten_percent_owner is null)::int as null_ten_pct
     from insider_transactions`,
  );
  console.log(r.rows[0]);

  // Sample empty-name rows by transaction value
  const sample = await pool.query(
    `select c.ticker, it.accession_number, it.insider_cik, it.insider_name,
            it.officer_title, it.is_officer, it.is_director, it.is_ten_percent_owner,
            it.transaction_code, it.transaction_value
     from insider_transactions it
     join companies c on c.cik = it.cik
     where (it.insider_name is null or it.insider_name = '')
       and abs(it.transaction_value) > 1e8
     order by abs(it.transaction_value) desc
     limit 10`,
  );
  console.log("\nTop empty-name rows by value:");
  for (const row of sample.rows) console.log(row);

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
