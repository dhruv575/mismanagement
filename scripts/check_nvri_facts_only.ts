import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query(
    `select concept, period_end::text, numeric_value
     from ixbrl_facts
     where accession_number = '0001193125-25-053042'
       and concept in ('ecd:TotalShareholderRtnAmt','ecd:PeerGroupTotalShareholderRtnAmt')
     order by period_end desc, concept`,
  );
  for (const row of r.rows) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
