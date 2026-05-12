import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query(
    `select x.concept, x.period_end::text, x.numeric_value
     from ixbrl_facts x
     join companies c on c.cik = x.cik
     where c.ticker = 'WOR'
       and x.concept in ('ecd:PeoTotalCompAmt','ecd:PeoActuallyPaidCompAmt','ecd:NonPeoNeoAvgTotalCompAmt','ecd:NonPeoNeoAvgCompActuallyPaidAmt')
     order by period_end desc, concept`,
  );
  for (const row of r.rows) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
