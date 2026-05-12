import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  const r1 = await pool.query(
    `select c.ticker, count(*)::int as facts,
            count(distinct concept)::int as concepts
     from ixbrl_facts f join companies c on c.cik = f.cik
     group by c.ticker order by c.ticker`,
  );
  console.log("\n--- iXBRL fact counts ---");
  for (const row of r1.rows) {
    console.log(`  ${row.ticker.padEnd(7)} ${row.facts} facts across ${row.concepts} distinct concepts`);
  }

  // Show sample of PEO total comp facts with their dimension members.
  const r2 = await pool.query(
    `select c.ticker, f.concept, f.period_end::text as period_end,
            f.numeric_value, f.dimension_members
     from ixbrl_facts f join companies c on c.cik = f.cik
     where f.concept = 'ecd:PeoTotalCompAmt'
     order by c.ticker, f.period_end`,
  );
  console.log("\n--- ecd:PeoTotalCompAmt facts ---");
  for (const row of r2.rows) {
    const dims = row.dimension_members || {};
    const dimStr = Object.entries(dims).map(([k, v]) => `${(k as string).split(":")[1]}=${(v as string).split(":")[1]}`).join(",");
    console.log(`  ${row.ticker.padEnd(7)} ${row.period_end}  $${(row.numeric_value/1e6).toFixed(2)}M  [${dimStr}]`);
  }

  // PEO names + selected measure names from nonNumeric
  const r3 = await pool.query(
    `select c.ticker, f.concept, f.text_value
     from ixbrl_facts f join companies c on c.cik = f.cik
     where f.concept in ('ecd:PeoName', 'ecd:CoSelectedMeasureName', 'ecd:MeasureName')
     order by c.ticker, f.concept`,
  );
  console.log("\n--- PEO + selected-measure names ---");
  for (const row of r3.rows) {
    console.log(`  ${row.ticker.padEnd(7)} ${row.concept.padEnd(35)} ${(row.text_value || "").slice(0, 60)}`);
  }

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
