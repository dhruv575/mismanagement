// Pulls Pay-vs-Performance facts from EDGAR's companyfacts JSON via the
// SEC's `ecd:` (Executive Compensation Disclosure) taxonomy. Deterministic --
// no LLM. Each row in the resulting `xbrl_pay_vs_performance` table is the
// issuer's own tagged values from their proxy XBRL filings.
//
// Concepts used (Dodd-Frank Pay-vs-Performance disclosure rule):
//   ecd:PeoTotalCompAmt                       PEO ("CEO") total comp from SCT
//   ecd:PeoActuallyPaidCompAmt                PEO Compensation Actually Paid (CAP)
//   ecd:NonPeoNeoAvgTotalCompAmt              avg of other-NEO total comp
//   ecd:NonPeoNeoAvgCompActuallyPaidAmt       avg of other-NEO CAP
//   ecd:TotalShareholderRtnAmt                indexed company TSR ($100 base)
//   ecd:PeerGroupTotalShareholderRtnAmt       indexed peer-group TSR ($100 base)
//   ecd:CoSelectedMeasureAmt                  company-selected measure value
//
// GAAP net income is matched separately from us-gaap:NetIncomeLoss by period.
//
// CLI:
//   tsx src/pull-ecd.ts                  # all issuers in companies table
//   tsx src/pull-ecd.ts ETSY EBAY        # subset by ticker

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";

interface FactRow {
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
  accn?: string;
}

interface CompanyFacts {
  facts: { ecd?: Record<string, { units: Record<string, FactRow[]> }> } & {
    "us-gaap"?: Record<string, { units: Record<string, FactRow[]> }>;
  };
}

const ECD_CONCEPTS = [
  "PeoTotalCompAmt",
  "PeoActuallyPaidCompAmt",
  "NonPeoNeoAvgTotalCompAmt",
  "NonPeoNeoAvgCompActuallyPaidAmt",
  "TotalShareholderRtnAmt",
  "PeerGroupTotalShareholderRtnAmt",
  "CoSelectedMeasureAmt",
] as const;

type EcdConcept = (typeof ECD_CONCEPTS)[number];

const COLUMN_BY_CONCEPT: Record<EcdConcept, string> = {
  PeoTotalCompAmt: "peo_total_comp",
  PeoActuallyPaidCompAmt: "peo_compensation_actually_paid",
  NonPeoNeoAvgTotalCompAmt: "non_peo_neo_avg_total_comp",
  NonPeoNeoAvgCompActuallyPaidAmt: "non_peo_neo_avg_compensation_actually_paid",
  TotalShareholderRtnAmt: "company_tsr_indexed",
  PeerGroupTotalShareholderRtnAmt: "peer_group_tsr_indexed",
  CoSelectedMeasureAmt: "company_selected_measure_value",
};

async function fetchFacts(cik: string): Promise<CompanyFacts> {
  const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
    headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
  });
  if (!res.ok) throw new Error(`companyfacts ${cik}: ${res.status}`);
  return (await res.json()) as CompanyFacts;
}

// Pick the canonical row per period: prefer rows with `frame` set, then most
// recently filed. Same logic as in pull-edgar.ts -- deduplicated here so
// pull-ecd.ts can run standalone.
function bestRowsByYear(rows: FactRow[]): Map<number, FactRow> {
  const byYear = new Map<number, FactRow[]>();
  for (const r of rows) {
    if (!r.end) continue;
    const year = parseInt(r.end.slice(0, 4), 10);
    if (!Number.isFinite(year)) continue;
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(r);
  }
  const out = new Map<number, FactRow>();
  for (const [year, list] of byYear) {
    const sorted = [...list].sort((a, b) => {
      const af = a.frame ? 1 : 0;
      const bf = b.frame ? 1 : 0;
      if (af !== bf) return bf - af;
      return (b.filed ?? "").localeCompare(a.filed ?? "");
    });
    out.set(year, sorted[0]!);
  }
  return out;
}

interface PvPRow {
  fiscal_year: number;
  peo_total_comp: number | null;
  peo_compensation_actually_paid: number | null;
  non_peo_neo_avg_total_comp: number | null;
  non_peo_neo_avg_compensation_actually_paid: number | null;
  company_tsr_indexed: number | null;
  peer_group_tsr_indexed: number | null;
  company_selected_measure_value: number | null;
  gaap_net_income: number | null;
  accession_number: string | null;
}

function buildRowsForCik(facts: CompanyFacts): PvPRow[] {
  const ecd = facts.facts.ecd ?? {};
  const usgaap = facts.facts["us-gaap"] ?? {};

  // Find the union of all years across the seven ecd: concepts. Some filers
  // start tagging mid-window so we can't assume contiguous coverage.
  const yearsSet = new Set<number>();
  const conceptByYear: Record<EcdConcept, Map<number, FactRow>> = {
    PeoTotalCompAmt: new Map(),
    PeoActuallyPaidCompAmt: new Map(),
    NonPeoNeoAvgTotalCompAmt: new Map(),
    NonPeoNeoAvgCompActuallyPaidAmt: new Map(),
    TotalShareholderRtnAmt: new Map(),
    PeerGroupTotalShareholderRtnAmt: new Map(),
    CoSelectedMeasureAmt: new Map(),
  };
  for (const concept of ECD_CONCEPTS) {
    const usdRows = ecd[concept]?.units?.["USD"];
    if (!usdRows || usdRows.length === 0) continue;
    const picked = bestRowsByYear(usdRows);
    conceptByYear[concept] = picked;
    for (const y of picked.keys()) yearsSet.add(y);
  }

  // GAAP net income is mapped from us-gaap:NetIncomeLoss for the same year.
  // We use the same dimension-collapsing helper -- frame'd rows preferred,
  // most recent restatement wins.
  const niRows = usgaap.NetIncomeLoss?.units?.["USD"] ?? [];
  const niAnnual = bestRowsByYear(
    niRows.filter((r) => {
      // Only annual-length periods.
      if (!r.start || !r.end) return false;
      const days = (Date.parse(r.end) - Date.parse(r.start)) / 86_400_000;
      return days >= 340 && days <= 380;
    }),
  );

  const rows: PvPRow[] = [];
  for (const year of [...yearsSet].sort((a, b) => a - b)) {
    const get = (c: EcdConcept) => conceptByYear[c].get(year)?.val ?? null;
    const accn =
      conceptByYear.PeoActuallyPaidCompAmt.get(year)?.accn ??
      conceptByYear.PeoTotalCompAmt.get(year)?.accn ??
      null;
    rows.push({
      fiscal_year: year,
      peo_total_comp: get("PeoTotalCompAmt"),
      peo_compensation_actually_paid: get("PeoActuallyPaidCompAmt"),
      non_peo_neo_avg_total_comp: get("NonPeoNeoAvgTotalCompAmt"),
      non_peo_neo_avg_compensation_actually_paid: get("NonPeoNeoAvgCompActuallyPaidAmt"),
      company_tsr_indexed: get("TotalShareholderRtnAmt"),
      peer_group_tsr_indexed: get("PeerGroupTotalShareholderRtnAmt"),
      company_selected_measure_value: get("CoSelectedMeasureAmt"),
      gaap_net_income: niAnnual.get(year)?.val ?? null,
      accession_number: accn,
    });
  }
  return rows;
}

async function pullOne(cik: string, ticker: string): Promise<void> {
  const facts = await fetchFacts(cik);
  const rows = buildRowsForCik(facts);
  if (rows.length === 0) {
    console.log(`[${ticker}] no ecd: PvP facts (filer hasn't tagged Pay-vs-Performance)`);
    return;
  }
  for (const r of rows) {
    await pool.query(
      `insert into xbrl_pay_vs_performance (
         cik, fiscal_year, peo_total_comp, peo_compensation_actually_paid,
         non_peo_neo_avg_total_comp, non_peo_neo_avg_compensation_actually_paid,
         company_tsr_indexed, peer_group_tsr_indexed,
         company_selected_measure_value, gaap_net_income, accession_number, pulled_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       on conflict (cik, fiscal_year) do update set
         peo_total_comp = excluded.peo_total_comp,
         peo_compensation_actually_paid = excluded.peo_compensation_actually_paid,
         non_peo_neo_avg_total_comp = excluded.non_peo_neo_avg_total_comp,
         non_peo_neo_avg_compensation_actually_paid = excluded.non_peo_neo_avg_compensation_actually_paid,
         company_tsr_indexed = excluded.company_tsr_indexed,
         peer_group_tsr_indexed = excluded.peer_group_tsr_indexed,
         company_selected_measure_value = excluded.company_selected_measure_value,
         gaap_net_income = excluded.gaap_net_income,
         accession_number = excluded.accession_number,
         pulled_at = now()`,
      [
        cik,
        r.fiscal_year,
        r.peo_total_comp,
        r.peo_compensation_actually_paid,
        r.non_peo_neo_avg_total_comp,
        r.non_peo_neo_avg_compensation_actually_paid,
        r.company_tsr_indexed,
        r.peer_group_tsr_indexed,
        r.company_selected_measure_value,
        r.gaap_net_income,
        r.accession_number,
      ],
    );
  }
  console.log(`[${ticker}] ${rows.length} year(s) of PvP upserted`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const concurrency = parseInt(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "1", 10);
  const skipExisting = argv.includes("--skip-existing");
  const r3kOnly = argv.includes("--r3k-only");
  const tickers = argv.filter((a) => !a.startsWith("--")).map((a) => a.toUpperCase());

  let sql = `select cik, ticker from companies`;
  const params: unknown[] = [];
  const conds: string[] = [];
  if (tickers.length > 0) { params.push(tickers); conds.push(`ticker = any($${params.length})`); }
  if (r3kOnly) conds.push(`is_russell_3000 = true`);
  if (conds.length > 0) sql += ` where ${conds.join(" and ")}`;
  sql += ` order by ticker`;
  const all = (await pool.query<{ cik: string; ticker: string }>(sql, params)).rows;

  // Single bulk query for skip-existing -- avoids 2.5K+ roundtrips at start.
  let existing = new Set<string>();
  if (skipExisting) {
    const r = await pool.query<{ cik: string }>(
      `select distinct cik from xbrl_pay_vs_performance`,
    );
    existing = new Set(r.rows.map((row) => row.cik));
  }
  const targets = all.filter((row) => !existing.has(row.cik));
  console.log(`pull-ecd: ${targets.length} issuer(s) (concurrency=${concurrency})`);

  let cursor = 0;
  let done = 0;
  let failures = 0;
  let withData = 0;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const row = targets[idx]!;
      try {
        const before = (await pool.query<{ count: number }>(
          `select count(*)::int as count from xbrl_pay_vs_performance where cik = $1`,
          [row.cik],
        )).rows[0]?.count ?? 0;
        await pullOne(row.cik, row.ticker);
        const after = (await pool.query<{ count: number }>(
          `select count(*)::int as count from xbrl_pay_vs_performance where cik = $1`,
          [row.cik],
        )).rows[0]?.count ?? 0;
        if (after > before) withData++;
      } catch (e) {
        failures++;
        // most errors are "no companyfacts" for sub-issuer CIKs that don't exist
        // -- not worth logging individually at R3K scale.
      }
      done++;
      if (done % 50 === 0 || done === targets.length) {
        const secs = (Date.now() - startedAt) / 1000;
        const eta = ((targets.length - done) / done) * secs;
        console.log(`--- progress: ${done}/${targets.length} (${withData} with PvP, ${failures} failed) ETA ${(eta/60).toFixed(1)} min ---`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  await pool.end();
}

await main();
