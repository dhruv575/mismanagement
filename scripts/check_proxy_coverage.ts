import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query<{
    total_r3k: number;
    extractions: number;
    directors_rows: number;
    distinct_director_ciks: number;
    sct_rows: number;
    distinct_sct_ciks: number;
    eq_owners_rows: number;
    distinct_eq_ciks: number;
    rpt_rows: number;
    distinct_rpt_ciks: number;
  }>(
    `select
       (select count(*)::int from companies where is_russell_3000) as total_r3k,
       (select count(*)::int from proxy_extractions) as extractions,
       (select count(*)::int from directors) as directors_rows,
       (select count(distinct e.cik)::int
          from proxy_extractions e join directors d on d.extraction_id = e.id) as distinct_director_ciks,
       (select count(*)::int from summary_compensation) as sct_rows,
       (select count(distinct e.cik)::int
          from proxy_extractions e join summary_compensation s on s.extraction_id = e.id) as distinct_sct_ciks,
       (select count(*)::int from equity_ownership) as eq_owners_rows,
       (select count(distinct e.cik)::int
          from proxy_extractions e join equity_ownership eo on eo.extraction_id = e.id) as distinct_eq_ciks,
       (select count(*)::int from related_party_transactions) as rpt_rows,
       (select count(distinct e.cik)::int
          from proxy_extractions e join related_party_transactions rpt on rpt.extraction_id = e.id) as distinct_rpt_ciks
    `,
  );
  console.log(r.rows[0]);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
