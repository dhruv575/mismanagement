import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  for (const t of ["NVRI", "WEX", "OGN"]) {
    console.log(`\n=== ${t} ===`);
    const r = await pool.query(
      `select fiscal_year, peo_total_comp, peo_compensation_actually_paid,
              company_tsr_indexed, peer_group_tsr_indexed, accession_number
       from xbrl_pay_vs_performance x
       join companies c on c.cik = x.cik
       where c.ticker = $1 order by fiscal_year desc`,
      [t],
    );
    for (const row of r.rows) console.log(row);

    // What's in ixbrl_facts for the latest filing's TSR concept?
    if (r.rows[0]) {
      const accn = r.rows[0].accession_number;
      console.log(`-- raw ixbrl facts for ${accn} (TSR + comp):`);
      const f = await pool.query(
        `select concept, period_end::text, numeric_value, unit, dimension_members
         from ixbrl_facts
         where accession_number = $1
           and concept in ('ecd:TotalShareholderRtnAmt','ecd:PeerGroupTotalShareholderRtnAmt',
                           'ecd:PeoTotalCompAmt','ecd:PeoActuallyPaidCompAmt')
         order by period_end desc nulls last, concept`,
        [accn],
      );
      for (const row of f.rows) console.log(row);
    }
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
