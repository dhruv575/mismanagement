import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  const upd = await pool.query<{ cik: string; fiscal_year: number; new_co: number | null; new_peer: number | null }>(
    `with co as (
       select cik, extract(year from period_end)::int as fy,
              min(numeric_value) as v
       from ixbrl_facts
       where concept = 'ecd:TotalShareholderRtnAmt'
         and numeric_value is not null
       group by cik, extract(year from period_end)
     ),
     peer as (
       select cik, extract(year from period_end)::int as fy,
              min(numeric_value) as v
       from ixbrl_facts
       where concept = 'ecd:PeerGroupTotalShareholderRtnAmt'
         and numeric_value is not null
       group by cik, extract(year from period_end)
     )
     update xbrl_pay_vs_performance x
     set company_tsr_indexed = co.v,
         peer_group_tsr_indexed = coalesce(peer.v, x.peer_group_tsr_indexed),
         pulled_at = now()
     from co
     left join peer on peer.cik = co.cik and peer.fy = co.fy
     where x.cik = co.cik and x.fiscal_year = co.fy
       and (
         (x.company_tsr_indexed is not null and x.company_tsr_indexed > 10000)
         or (x.peer_group_tsr_indexed is not null and x.peer_group_tsr_indexed > 10000)
       )
     returning x.cik, x.fiscal_year,
               x.company_tsr_indexed as new_co,
               x.peer_group_tsr_indexed as new_peer`,
  );
  console.log(`updated ${upd.rows.length} rows in xbrl_pay_vs_performance`);
  for (const row of upd.rows.slice(0, 30)) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
