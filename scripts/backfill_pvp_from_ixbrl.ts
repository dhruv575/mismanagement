// Backfills xbrl_pay_vs_performance from ixbrl_facts.
//
// The companyfacts JSON drops dimensional rows tagged with NEO/named-person
// axes -- which is exactly how every PvP disclosure is structured in iXBRL.
// pull-ecd.ts therefore misses ~32% of filers (332 of 1,037 R3K issuers had
// the PvP table tagged but null peo_total_comp). Our pull-ixbrl.ts captures
// those dimensional rows directly. This script projects them into the
// (cik, fiscal_year) PvP shape that screen_board_failure.ts ranks on.
//
// Strategy:
//   1. Pull every ixbrl_facts row whose concept is one of the PvP fields.
//   2. Group by (cik, period_end_year) so each fiscal year is one upsert.
//   3. For each year, take the first non-null numeric_value per concept --
//      filers tag the same field multiple times (different rounding, ranges,
//      individual vs. aggregated). The aggregated row usually wins because
//      it appears first in document order; if not, the rest of the values
//      typically differ by < 1%.
//   4. Upsert -- pull-ecd.ts already populated the rows for filers with
//      non-dimensional tagging, so the on-conflict-update only fills nulls.

import { pool } from "../packages/ingest/src/db.js";

interface FactRow {
  cik: string;
  accession_number: string;
  concept: string;
  period_end: string;
  numeric_value: number | null;
  text_value: string | null;
}

const FIELD_MAP: Record<string, keyof PvPRow> = {
  "ecd:PeoTotalCompAmt": "peo_total_comp",
  "ecd:PeoActuallyPaidCompAmt": "peo_compensation_actually_paid",
  "ecd:NonPeoNeoAvgTotalCompAmt": "non_peo_neo_avg_total_comp",
  "ecd:NonPeoNeoAvgCompActuallyPaidAmt": "non_peo_neo_avg_compensation_actually_paid",
  "ecd:TotalShareholderRtnAmt": "company_tsr_indexed",
  "ecd:PeerGroupTotalShareholderRtnAmt": "peer_group_tsr_indexed",
  "ecd:CoSelectedMeasureAmt": "company_selected_measure_value",
  // Net income inside a PvP context (us-gaap:NetIncomeLoss with the PvP
  // period dimension). We accept the plain concept too -- if the filer
  // tagged it inside their PvP table, the period_end_year disambiguates.
  "us-gaap:NetIncomeLoss": "gaap_net_income",
  "ecd:NetIncomeLoss": "gaap_net_income",
};

const TEXT_FIELD_MAP: Record<string, "company_selected_measure_name"> = {
  "ecd:CoSelectedMeasureName": "company_selected_measure_name",
};

interface PvPRow {
  cik: string;
  fiscal_year: number;
  accession_number: string;
  peo_total_comp: number | null;
  peo_compensation_actually_paid: number | null;
  non_peo_neo_avg_total_comp: number | null;
  non_peo_neo_avg_compensation_actually_paid: number | null;
  company_tsr_indexed: number | null;
  peer_group_tsr_indexed: number | null;
  company_selected_measure_name: string | null;
  company_selected_measure_value: number | null;
  gaap_net_income: number | null;
}

async function main(): Promise<void> {
  const concepts = [...Object.keys(FIELD_MAP), ...Object.keys(TEXT_FIELD_MAP)];
  console.log(`pulling ixbrl_facts for ${concepts.length} PvP-related concepts…`);
  const r = await pool.query<FactRow>(
    `select cik, accession_number, concept, period_end::text as period_end,
            numeric_value, text_value
     from ixbrl_facts
     where concept = any($1::text[])
       and period_end is not null`,
    [concepts],
  );
  console.log(`  ${r.rows.length} rows`);

  // Group by (cik, year).
  const byKey = new Map<string, PvPRow>();
  for (const f of r.rows) {
    const year = parseInt(f.period_end.slice(0, 4), 10);
    if (!Number.isFinite(year) || year < 2020 || year > 2030) continue;
    const key = `${f.cik}|${year}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        cik: f.cik,
        fiscal_year: year,
        accession_number: f.accession_number,
        peo_total_comp: null,
        peo_compensation_actually_paid: null,
        non_peo_neo_avg_total_comp: null,
        non_peo_neo_avg_compensation_actually_paid: null,
        company_tsr_indexed: null,
        peer_group_tsr_indexed: null,
        company_selected_measure_name: null,
        company_selected_measure_value: null,
        gaap_net_income: null,
      };
      byKey.set(key, row);
    }
    const numField = FIELD_MAP[f.concept];
    if (numField && f.numeric_value !== null) {
      const cur = row[numField] as number | null;
      // Take the first non-null value we see. Filers often tag the same
      // amount many times (per-NEO, aggregated, restated); document-order
      // first is usually the headline aggregated number.
      if (cur === null) (row as Record<string, unknown>)[numField] = f.numeric_value;
    }
    const textField = TEXT_FIELD_MAP[f.concept];
    if (textField && f.text_value) {
      if (row[textField] === null) row[textField] = f.text_value;
    }
  }

  const rows = [...byKey.values()];
  console.log(`  ${rows.length} (cik, year) rows to upsert`);

  if (rows.length === 0) {
    await pool.end();
    return;
  }

  // Bulk upsert: only overwrite columns where the new value is non-null.
  // pull-ecd.ts may have already filled some columns (when companyfacts had
  // them); ixbrl_facts fills the gaps for dimensional rows.
  await pool.query(
    `insert into xbrl_pay_vs_performance (
       cik, fiscal_year, accession_number,
       peo_total_comp, peo_compensation_actually_paid,
       non_peo_neo_avg_total_comp, non_peo_neo_avg_compensation_actually_paid,
       company_tsr_indexed, peer_group_tsr_indexed,
       company_selected_measure_name, company_selected_measure_value,
       gaap_net_income, pulled_at
     )
     select cik, fy, accn,
            peo_tot, peo_cap,
            neo_tot, neo_cap,
            co_tsr, peer_tsr,
            csm_name, csm_val,
            gaap_ni, now()
     from unnest(
       $1::text[], $2::int[], $3::text[],
       $4::float8[], $5::float8[],
       $6::float8[], $7::float8[],
       $8::float8[], $9::float8[],
       $10::text[], $11::float8[],
       $12::float8[]
     ) as t(cik, fy, accn, peo_tot, peo_cap, neo_tot, neo_cap,
            co_tsr, peer_tsr, csm_name, csm_val, gaap_ni)
     on conflict (cik, fiscal_year) do update set
       peo_total_comp = coalesce(xbrl_pay_vs_performance.peo_total_comp, excluded.peo_total_comp),
       peo_compensation_actually_paid = coalesce(xbrl_pay_vs_performance.peo_compensation_actually_paid, excluded.peo_compensation_actually_paid),
       non_peo_neo_avg_total_comp = coalesce(xbrl_pay_vs_performance.non_peo_neo_avg_total_comp, excluded.non_peo_neo_avg_total_comp),
       non_peo_neo_avg_compensation_actually_paid = coalesce(xbrl_pay_vs_performance.non_peo_neo_avg_compensation_actually_paid, excluded.non_peo_neo_avg_compensation_actually_paid),
       company_tsr_indexed = coalesce(xbrl_pay_vs_performance.company_tsr_indexed, excluded.company_tsr_indexed),
       peer_group_tsr_indexed = coalesce(xbrl_pay_vs_performance.peer_group_tsr_indexed, excluded.peer_group_tsr_indexed),
       company_selected_measure_name = coalesce(xbrl_pay_vs_performance.company_selected_measure_name, excluded.company_selected_measure_name),
       company_selected_measure_value = coalesce(xbrl_pay_vs_performance.company_selected_measure_value, excluded.company_selected_measure_value),
       gaap_net_income = coalesce(xbrl_pay_vs_performance.gaap_net_income, excluded.gaap_net_income),
       accession_number = coalesce(xbrl_pay_vs_performance.accession_number, excluded.accession_number),
       pulled_at = now()`,
    [
      rows.map((r) => r.cik),
      rows.map((r) => r.fiscal_year),
      rows.map((r) => r.accession_number),
      rows.map((r) => r.peo_total_comp),
      rows.map((r) => r.peo_compensation_actually_paid),
      rows.map((r) => r.non_peo_neo_avg_total_comp),
      rows.map((r) => r.non_peo_neo_avg_compensation_actually_paid),
      rows.map((r) => r.company_tsr_indexed),
      rows.map((r) => r.peer_group_tsr_indexed),
      rows.map((r) => r.company_selected_measure_name),
      rows.map((r) => r.company_selected_measure_value),
      rows.map((r) => r.gaap_net_income),
    ],
  );

  // Coverage report.
  const cov = await pool.query<{
    rows: number;
    with_peo_tc: number;
    with_peo_cap: number;
    with_co_tsr: number;
  }>(
    `select count(*)::int as rows,
            count(peo_total_comp)::int as with_peo_tc,
            count(peo_compensation_actually_paid)::int as with_peo_cap,
            count(company_tsr_indexed)::int as with_co_tsr
     from xbrl_pay_vs_performance`,
  );
  console.log(`xbrl_pay_vs_performance after backfill:`);
  console.log(cov.rows[0]);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
