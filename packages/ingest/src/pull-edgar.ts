// Pulls the SEC EDGAR data we need per issuer:
//   1. submissions JSON  -> companies row + filings rows
//   2. companyfacts JSON -> financial_metrics rows for a fixed set of concepts
//
// Idempotent. Re-running upserts the latest values; existing rows are updated
// in place. The filings table accumulates -- we never delete, since accession
// numbers are stable forever.
//
// CLI:
//   tsx src/pull-edgar.ts                 # all issuers
//   tsx src/pull-prices.ts ETSY EBAY      # subset

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { resolveTargets, type IssuerSeed } from "./issuers.js";

// EDGAR's submissions JSON only carries the primary filing-index fields per
// filing -- there are no fiscalPeriod / fiscalYear columns here (those live
// in companyfacts JSON). We derive fiscal year for 10-K/10-Q from reportDate
// (the period-end date) and for DEF 14A from filingDate-1 at the call site.
interface RecentFilings {
  accessionNumber: string[];
  filingDate: string[];
  reportDate: string[];
  form: string[];
  primaryDocument: string[];
}

interface SubmissionsResponse {
  cik: string;
  name: string;
  sicDescription: string | null;
  fiscalYearEnd: string | null;
  filings: {
    recent: RecentFilings;
    files?: {
      name: string;
      filingCount: number;
      filingFrom: string;
      filingTo: string;
    }[];
  };
}

// Older filings (beyond the most recent ~1000) live in pagination shards
// referenced by `submissions.filings.files[]`. Each shard is a JSON file at
// data.sec.gov/submissions/{name} with the same `recent`-shaped fields.
// We fetch them all and merge so pull-edgar covers full history, not just
// ~last 3 years.
async function fetchRecentOnlyForCik(cik: string): Promise<{ name: string; sicDescription: string | null; fiscalYearEnd: string | null; filings: RecentFilings }> {
  const sub = await fetchJson<SubmissionsResponse>(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
  );
  return {
    name: sub.name,
    sicDescription: sub.sicDescription,
    fiscalYearEnd: sub.fiscalYearEnd,
    filings: sub.filings.recent,
  };
}

async function fetchAllFilingsForCik(cik: string): Promise<{ name: string; sicDescription: string | null; fiscalYearEnd: string | null; filings: RecentFilings }> {
  const sub = await fetchJson<SubmissionsResponse>(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
  );
  const merged: RecentFilings = {
    accessionNumber: [...sub.filings.recent.accessionNumber],
    filingDate: [...sub.filings.recent.filingDate],
    reportDate: [...sub.filings.recent.reportDate],
    form: [...sub.filings.recent.form],
    primaryDocument: [...sub.filings.recent.primaryDocument],
  };
  for (const shard of sub.filings.files ?? []) {
    const shardData = await fetchJson<RecentFilings>(
      `https://data.sec.gov/submissions/${shard.name}`,
    );
    merged.accessionNumber.push(...shardData.accessionNumber);
    merged.filingDate.push(...shardData.filingDate);
    merged.reportDate.push(...shardData.reportDate);
    merged.form.push(...shardData.form);
    merged.primaryDocument.push(...shardData.primaryDocument);
  }
  return {
    name: sub.name,
    sicDescription: sub.sicDescription,
    fiscalYearEnd: sub.fiscalYearEnd,
    filings: merged,
  };
}

// Backstop for 13D/G/A filings: when an external party files about an issuer,
// the filing is sometimes only registered under the *filer's* CIK and not
// echoed in the issuer's submissions feed. EDGAR's full-text search index
// (efts.sec.gov) lets us query by subject CIK directly. Returns rows in the
// same shape as RecentFilings so we can merge into the main pipeline.
async function fetchSubjectFilingsForCik(cik: string, forms: string[]): Promise<RecentFilings> {
  const out: RecentFilings = {
    accessionNumber: [],
    filingDate: [],
    reportDate: [],
    form: [],
    primaryDocument: [],
  };
  // efts paginates 100/page; for 13D/G a typical issuer has <300 historical
  // filings so 5 pages is plenty. Stop on empty.
  const cikInt = parseInt(cik, 10);
  for (let from = 0; from < 1000; from += 100) {
    // EFTS rejects an empty `q=`; we omit it entirely and rely on ciks+forms.
    const url =
      `https://efts.sec.gov/LATEST/search-index?` +
      `ciks=${cikInt}&forms=${encodeURIComponent(forms.join(","))}` +
      `&from=${from}`;
    const res = await fetch(url, {
      headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
    });
    if (!res.ok) {
      // EFTS sometimes 500s on fancy queries; soft-fail rather than abort
      // the whole pull-edgar run.
      console.warn(`  efts ${res.status} for cik=${cik}, skipping subject backstop`);
      break;
    }
    const data = (await res.json()) as {
      hits?: {
        hits?: {
          _id: string;
          _source: {
            adsh?: string;
            form?: string;
            file_date?: string;
            xsl?: string;
            file_type?: string;
            display_names?: string[];
          };
        }[];
      };
    };
    const hits = data.hits?.hits ?? [];
    if (hits.length === 0) break;
    for (const h of hits) {
      const accn = h._source.adsh;
      if (!accn) continue;
      // efts returns the doc id as `accn:doc.htm`; we want the bare accession.
      out.accessionNumber.push(accn);
      out.filingDate.push(h._source.file_date ?? "");
      out.reportDate.push("");
      out.form.push(h._source.form ?? "");
      out.primaryDocument.push("");
    }
    if (hits.length < 100) break;
  }
  return out;
}

// US-GAAP concepts we screen on. Pulled per fiscal year. The order matters for
// the merge step: when a company reports both `Revenues` and the post-ASC-606
// `RevenueFromContractWithCustomerExcludingAssessedTax` for the same year we
// keep the first one in this list that has a value.
const REVENUE_CONCEPTS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
];
const SBC_CONCEPTS = ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"];
const SM_CONCEPTS = ["SellingAndMarketingExpense", "MarketingExpense"];
const RD_CONCEPTS = ["ResearchAndDevelopmentExpense"];
const GA_CONCEPTS = ["GeneralAndAdministrativeExpense"];
const NI_CONCEPTS = ["NetIncomeLoss"];
const OP_CONCEPTS = ["OperatingIncomeLoss"];
const BUYBACK_CONCEPTS = ["PaymentsForRepurchaseOfCommonStock"];
const COR_CONCEPTS = ["CostOfRevenue", "CostOfGoodsAndServicesSold"];
const OPEX_CONCEPTS = ["OperatingExpenses"];
const GROSS_PROFIT_CONCEPTS = ["GrossProfit"];
const CAPEX_CONCEPTS = [
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "PaymentsToAcquireProductiveAssets",
];
const DEPRECIATION_CONCEPTS = [
  "DepreciationDepletionAndAmortization",
  "DepreciationAndAmortization",
  "Depreciation",
];
const OPERATING_CASH_FLOW_CONCEPTS = [
  "NetCashProvidedByUsedInOperatingActivities",
  "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
];
const DIVIDENDS_PAID_CONCEPTS = [
  "PaymentsOfDividendsCommonStock",
  "PaymentsOfDividends",
];
const INTEREST_EXPENSE_CONCEPTS = ["InterestExpense"];
const INCOME_TAX_CONCEPTS = ["IncomeTaxExpenseBenefit"];

// Point-in-time concepts (most recent value wins, not annualized).
// Tagged with namespace so we can fall back from us-gaap to dei (which carries
// the cover-page shares-outstanding amount that some multi-class filers like
// META and OKTA use instead of CommonStockSharesOutstanding).
type NsConcept = readonly [namespace: string, concept: string];
const CASH_CONCEPTS: NsConcept[] = [
  ["us-gaap", "CashAndCashEquivalentsAtCarryingValue"],
  ["us-gaap", "Cash"],
  ["us-gaap", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
];
const DEBT_CONCEPTS: NsConcept[] = [
  ["us-gaap", "LongTermDebt"],
  ["us-gaap", "LongTermDebtNoncurrent"],
];
const SHARES_CONCEPTS: NsConcept[] = [
  ["us-gaap", "CommonStockSharesOutstanding"],
  ["dei", "EntityCommonStockSharesOutstanding"],
  // Last resort: weighted-average diluted shares from the income statement.
  // Within ~5% of period-end shares for most issuers; better than null.
  ["us-gaap", "WeightedAverageNumberOfDilutedSharesOutstanding"],
  ["us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic"],
];
const TOTAL_ASSETS_CONCEPTS: NsConcept[] = [["us-gaap", "Assets"]];
const TOTAL_EQUITY_CONCEPTS: NsConcept[] = [
  ["us-gaap", "StockholdersEquity"],
  ["us-gaap", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
];
const AR_CONCEPTS: NsConcept[] = [
  ["us-gaap", "AccountsReceivableNetCurrent"],
  ["us-gaap", "ReceivablesNetCurrent"],
];
const INVENTORY_CONCEPTS: NsConcept[] = [["us-gaap", "InventoryNet"]];
const TOTAL_DEBT_CONCEPTS: NsConcept[] = [
  ["us-gaap", "DebtLongtermAndShorttermCombinedAmount"],
  ["us-gaap", "LongTermDebtAndCapitalLeaseObligations"],
];
const SHORT_TERM_DEBT_CONCEPTS: NsConcept[] = [
  ["us-gaap", "ShortTermBorrowings"],
  ["us-gaap", "LongTermDebtCurrent"],
];
const GOODWILL_CONCEPTS: NsConcept[] = [["us-gaap", "Goodwill"]];

interface CompanyFactsRow {
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
  facts: {
    "us-gaap"?: Record<string, { units: Record<string, CompanyFactsRow[]> }>;
    dei?: Record<string, { units: Record<string, CompanyFactsRow[]> }>;
  } & Record<string, Record<string, { units: Record<string, CompanyFactsRow[]> }> | undefined>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function pullOne(issuer: IssuerSeed, opts: { fullHistory: boolean; eftsBackstop: boolean; metricsOnly: boolean }): Promise<void> {
  if (opts.metricsOnly) {
    await pullMetricsOnly(issuer);
    return;
  }
  const sub = opts.fullHistory
    ? await fetchAllFilingsForCik(issuer.cik)
    : await fetchRecentOnlyForCik(issuer.cik);

  await pool.query(
    `insert into companies (cik, ticker, name, sic_description, fiscal_year_end, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (cik) do update set
       ticker = excluded.ticker,
       name = excluded.name,
       sic_description = excluded.sic_description,
       fiscal_year_end = excluded.fiscal_year_end,
       updated_at = now()`,
    [issuer.cik, issuer.ticker, sub.name, sub.sicDescription, sub.fiscalYearEnd],
  );

  // Keep just the filings we'll plausibly need: 10-K, 10-Q, DEF 14A, 8-K
  // Item 5.02 (we filter that downstream), Form 4, 13D, 13G. This keeps the
  // table size tractable -- a typical issuer has 500-2000 lifetime filings.
  const RELEVANT_FORMS = new Set([
    "10-K",
    "10-K/A",
    "10-Q",
    "10-Q/A",
    "DEF 14A",
    "DEFA14A",
    "8-K",
    "4",
    "SC 13D",
    "SC 13D/A",
    "SC 13G",
    "SC 13G/A",
  ]);

  const r = sub.filings;
  const filings = r.form
    .map((form, i) => ({ form, i }))
    .filter(({ form }) => RELEVANT_FORMS.has(form))
    .map(({ form, i }) => {
      const filingDate = r.filingDate[i]!;
      const reportDate = r.reportDate[i] || null;
      // Fiscal-year heuristic: 10-K/10-Q -> year of reportDate; DEF 14A ->
      // the year before the filing (proxies cover the prior fiscal year).
      let fiscalYear: number | null = null;
      if ((form === "10-K" || form === "10-K/A" || form === "10-Q" || form === "10-Q/A") && reportDate) {
        fiscalYear = parseInt(reportDate.slice(0, 4), 10);
      } else if (form === "DEF 14A") {
        fiscalYear = parseInt(filingDate.slice(0, 4), 10) - 1;
      }
      return {
        accession_number: r.accessionNumber[i]!,
        cik: issuer.cik,
        form,
        filing_date: filingDate,
        primary_document: r.primaryDocument[i] ?? null,
        primary_doc_url: primaryDocUrl(issuer.cik, r.accessionNumber[i]!, r.primaryDocument[i] ?? null),
        fiscal_period: null as string | null,
        fiscal_year: fiscalYear,
      };
    });

  // Bulk upsert via UNNEST -- a single round-trip for hundreds of filings,
  // versus a per-row insert that turns each big-cap issuer into a 700-row
  // serial workload that dominates total runtime.
  if (filings.length > 0) {
    await pool.query(
      `insert into filings (
         accession_number, cik, form, filing_date, primary_document, primary_doc_url,
         fiscal_period, fiscal_year
       )
       select * from unnest(
         $1::text[], $2::text[], $3::text[], $4::date[],
         $5::text[], $6::text[], $7::text[], $8::int[]
       )
       on conflict (accession_number) do nothing`,
      [
        filings.map((f) => f.accession_number),
        filings.map((f) => f.cik),
        filings.map((f) => f.form),
        filings.map((f) => f.filing_date),
        filings.map((f) => f.primary_document),
        filings.map((f) => f.primary_doc_url),
        filings.map((f) => f.fiscal_period),
        filings.map((f) => f.fiscal_year),
      ],
    );
  }
  console.log(`[${issuer.ticker}]   ${filings.length} filings upserted (submissions feed)`);

  if (!opts.eftsBackstop) {
    console.log(`[${issuer.ticker}] fetching companyfacts…`);
  } else {
    // Backstop: 13D/G filings made by external parties about this issuer
    // don't always appear in the issuer's submissions feed (or appear with
    // delay). Hit EDGAR's full-text search by subject CIK and add anything
    // we missed. Skipped on bulk runs because every issuer pays an HTTP
    // round-trip and 99%+ duplicate the submissions feed; targeted with
    // --efts-backstop when needed.
    console.log(`[${issuer.ticker}] backfilling subject 13D/G via efts…`);
  }
  const subjects = opts.eftsBackstop
    ? await fetchSubjectFilingsForCik(issuer.cik, [
        "SC 13D",
        "SC 13D/A",
        "SC 13G",
        "SC 13G/A",
      ])
    : { accessionNumber: [], filingDate: [], reportDate: [], form: [], primaryDocument: [] };
  let efts_added = 0;
  for (let i = 0; i < subjects.accessionNumber.length; i++) {
    const accn = subjects.accessionNumber[i]!;
    const form = subjects.form[i] ?? "";
    if (!form.startsWith("SC 13")) continue;
    // The accession number's first 10 digits encode the FILER's CIK, which
    // is always the canonical home for the filing folder. The issuer's CIK
    // folder mirrors mirrored filings but not always -- using the filer's
    // CIK for the URL works even when the issuer doesn't mirror.
    const accnNoDash = accn.replace(/-/g, "");
    const filerCikInt = parseInt(accn.slice(0, 10), 10);
    const folderUrl = `https://www.sec.gov/Archives/edgar/data/${filerCikInt}/${accnNoDash}/`;
    // Skip if the row already exists (anti-join via on conflict do nothing
    // would be enough, but we also want to skip the folder-listing fetch
    // when the row was inserted by the submissions feed).
    const existing = await pool.query<{ accession_number: string }>(
      `select accession_number from filings where accession_number = $1 limit 1`,
      [accn],
    );
    if (existing.rows.length > 0) continue;

    const primaryDocUrl = await resolveFilingPrimaryDoc(folderUrl).catch(() => null);
    await pool.query(
      `insert into filings (
         accession_number, cik, form, filing_date, primary_doc_url
       ) values ($1, $2, $3, $4, $5)
       on conflict (accession_number) do nothing`,
      [accn, issuer.cik, form, subjects.filingDate[i] || null, primaryDocUrl],
    );
    efts_added++;
  }
  if (efts_added > 0) {
    console.log(`[${issuer.ticker}]   ${efts_added} additional 13D/G via efts subject search`);
  }

  await pullMetricsOnly(issuer);
}

async function pullMetricsOnly(issuer: IssuerSeed): Promise<void> {
  console.log(`[${issuer.ticker}] fetching companyfacts…`);
  let facts: CompanyFacts;
  try {
    facts = await fetchJson<CompanyFacts>(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${issuer.cik}.json`,
    );
  } catch (e) {
    // Some issuers (recent IPOs, foreign private issuers) have no companyfacts
    // -- 404 is expected, not an error.
    console.log(`[${issuer.ticker}]   no companyfacts available (${e instanceof Error ? e.message : e})`);
    return;
  }

  const annualConcepts: [string, string[]][] = [
    ["revenue", REVENUE_CONCEPTS],
    ["sbc", SBC_CONCEPTS],
    ["selling_marketing", SM_CONCEPTS],
    ["research_development", RD_CONCEPTS],
    ["general_administrative", GA_CONCEPTS],
    ["net_income", NI_CONCEPTS],
    ["operating_income", OP_CONCEPTS],
    ["buybacks", BUYBACK_CONCEPTS],
    ["cost_of_revenue", COR_CONCEPTS],
    ["operating_expenses_total", OPEX_CONCEPTS],
    ["gross_profit", GROSS_PROFIT_CONCEPTS],
    ["capex", CAPEX_CONCEPTS],
    ["depreciation_amortization", DEPRECIATION_CONCEPTS],
    ["operating_cash_flow", OPERATING_CASH_FLOW_CONCEPTS],
    ["dividends_paid", DIVIDENDS_PAID_CONCEPTS],
    ["interest_expense", INTEREST_EXPENSE_CONCEPTS],
    ["income_tax_expense", INCOME_TAX_CONCEPTS],
  ];

  type FmRow = { cik: string; fy: number; concept: string; value: number; unit: string };
  const fmRows: FmRow[] = [];
  for (const [logical, candidates] of annualConcepts) {
    for (const [fy, value] of annualSeriesMerged(facts, candidates)) {
      fmRows.push({ cik: issuer.cik, fy, concept: logical, value, unit: "USD" });
    }
  }
  const pitConcepts: [string, NsConcept[], string][] = [
    ["cash_latest", CASH_CONCEPTS, "USD"],
    ["long_term_debt_latest", DEBT_CONCEPTS, "USD"],
    ["shares_outstanding_latest", SHARES_CONCEPTS, "shares"],
    ["total_assets_latest", TOTAL_ASSETS_CONCEPTS, "USD"],
    ["total_equity_latest", TOTAL_EQUITY_CONCEPTS, "USD"],
    ["accounts_receivable_latest", AR_CONCEPTS, "USD"],
    ["inventory_latest", INVENTORY_CONCEPTS, "USD"],
    ["total_debt_latest", TOTAL_DEBT_CONCEPTS, "USD"],
    ["short_term_debt_latest", SHORT_TERM_DEBT_CONCEPTS, "USD"],
    ["goodwill_latest", GOODWILL_CONCEPTS, "USD"],
  ];
  for (const [logical, candidates, unit] of pitConcepts) {
    const v = latestValue(facts, candidates, unit);
    if (v) fmRows.push({ cik: issuer.cik, fy: -1, concept: logical, value: v.value, unit });
  }

  if (fmRows.length > 0) {
    await pool.query(
      `insert into financial_metrics (cik, fiscal_year, concept, value, unit)
       select * from unnest($1::text[], $2::int[], $3::text[], $4::float8[], $5::text[])
       on conflict (cik, fiscal_year, concept) do update set value = excluded.value`,
      [
        fmRows.map((r) => r.cik),
        fmRows.map((r) => r.fy),
        fmRows.map((r) => r.concept),
        fmRows.map((r) => r.value),
        fmRows.map((r) => r.unit),
      ],
    );
  }
  console.log(`[${issuer.ticker}]   ${fmRows.length} financial_metrics rows upserted`);
}

function primaryDocUrl(cik: string, accn: string, doc: string | null): string | null {
  if (!doc) return null;
  return `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accn.replace(/-/g, "")}/${doc}`;
}

// EDGAR filing folder index is HTML; the primary doc for 13D/G is typically
// a single .htm/.html file at the top level (sometimes named SEC13G_*.htm,
// sometimes a generic name). Pick the first non-XSL .htm/.html that isn't
// the index itself.
async function resolveFilingPrimaryDoc(folderUrl: string): Promise<string | null> {
  const res = await fetch(folderUrl, {
    headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const re = /href="([^"]+\.(?:htm|html))"/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1]!;
    if (href.includes("/xsl") || href.endsWith("-index.htm") || href.endsWith("-index.html")) continue;
    matches.push(href);
  }
  if (matches.length === 0) return null;
  // Prefer 13G-themed names then anything else.
  matches.sort((a, b) => {
    const score = (s: string) =>
      /SEC13[GD]/i.test(s) ? 0 :
      /13[gd]/i.test(s) ? 1 : 2;
    return score(a) - score(b);
  });
  return new URL(matches[0]!, folderUrl).toString();
}

// Annual fact series keyed by *period-end year*, not by EDGAR's `fy` field.
//
// `fy` on each row is the fiscal year of the FILING, not the value -- a 2024
// 10-K reports three years of comparatives, so 2022/2023/2024 values all
// arrive with fy=2024. Using `fy` as the key collapses the comparatives.
//
// Within rows for the same period, we pick:
//   1. The row with `frame` set (the SEC's canonical, axis-less consolidated
//      value for that calendar/fiscal frame), then
//   2. The most recently filed row (latest restatement wins).
// This sidesteps the dimensional-subtotal bug where eBay's `Revenues` returned
// a continuing-ops sub-segment instead of the consolidated total.
function annualSeries(facts: CompanyFacts, concept: string, unit = "USD"): Map<number, number> {
  const rows = facts.facts["us-gaap"]?.[concept]?.units?.[unit];
  if (!rows) return new Map();

  // Group by the period-end year, only considering annual-length periods.
  type Pick = { val: number; frame: boolean; filed: string };
  const candidates = new Map<number, Pick[]>();
  for (const r of rows) {
    if (!r.end || !r.start) continue;
    const start = Date.parse(r.start);
    const end = Date.parse(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const days = (end - start) / 86_400_000;
    // Annual periods are ~364-371 days (calendar) or ~363-378 days (52/53-week
    // retail calendars). Accept 340-380 to cover both.
    if (days < 340 || days > 380) continue;
    const year = parseInt(r.end.slice(0, 4), 10);
    if (!Number.isFinite(year)) continue;
    if (!candidates.has(year)) candidates.set(year, []);
    candidates.get(year)!.push({
      val: r.val,
      frame: !!r.frame,
      filed: r.filed ?? "",
    });
  }

  const out = new Map<number, number>();
  for (const [year, picks] of candidates) {
    // frame=true beats frame=false; among ties, latest filed wins.
    picks.sort((a, b) => {
      if (a.frame !== b.frame) return a.frame ? -1 : 1;
      return b.filed.localeCompare(a.filed);
    });
    out.set(year, picks[0]!.val);
  }
  return out;
}

function annualSeriesMerged(facts: CompanyFacts, concepts: string[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of concepts) {
    for (const [y, v] of annualSeries(facts, c)) {
      if (!out.has(y)) out.set(y, v);
    }
  }
  return out;
}

function latestValue(
  facts: CompanyFacts,
  concepts: NsConcept[],
  unit: string,
): { value: number; end: string } | null {
  for (const [ns, c] of concepts) {
    // The dei namespace tags shares-outstanding under "shares" but some filers
    // also report it as a unitless count. Try the requested unit first; if
    // empty for a dei concept, fall through to whatever unit it has.
    const facetForConcept = facts.facts[ns]?.[c];
    if (!facetForConcept) continue;
    let rows = facetForConcept.units?.[unit];
    if ((!rows || rows.length === 0) && ns === "dei") {
      const firstUnit = Object.keys(facetForConcept.units ?? {})[0];
      if (firstUnit) rows = facetForConcept.units[firstUnit];
    }
    if (!rows || rows.length === 0) continue;
    const sorted = [...rows].sort((a, b) => (a.end > b.end ? 1 : -1));
    const last = sorted[sorted.length - 1]!;
    return { value: last.val, end: last.end };
  }
  return null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const concurrency = parseInt(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "1", 10);
  const skipExisting = argv.includes("--skip-existing");
  const fullHistory = argv.includes("--full-history");
  const eftsBackstop = argv.includes("--efts-backstop");
  const metricsOnly = argv.includes("--metrics-only");
  const tickers = argv.filter((a) => !a.startsWith("--"));
  const all = await resolveTargets(tickers);
  // Single bulk query for skip-existing -- avoids 2.5K+ roundtrips at start.
  let existing = new Set<string>();
  if (skipExisting) {
    const r = await pool.query<{ cik: string }>(
      `select distinct cik from financial_metrics`,
    );
    existing = new Set(r.rows.map((row) => row.cik));
  }
  const targets = all.filter((i) => !existing.has(i.cik));
  console.log(`pull-edgar: ${targets.length} issuer(s) (skip-existing=${skipExisting}, concurrency=${concurrency})`);

  let cursor = 0;
  let done = 0;
  let failures = 0;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const issuer = targets[idx]!;
      try {
        await pullOne(issuer, { fullHistory, eftsBackstop, metricsOnly });
      } catch (e) {
        failures++;
        console.error(`[${issuer.ticker}] FAILED: ${e instanceof Error ? e.message : e}`);
      }
      done++;
      if (done % 25 === 0 || done === targets.length) {
        const secs = (Date.now() - startedAt) / 1000;
        const rate = done / secs;
        const eta = (targets.length - done) / rate;
        console.log(`--- progress: ${done}/${targets.length} (${failures} failed) ${rate.toFixed(1)} issuers/s, ETA ${(eta/60).toFixed(1)} min ---`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  await pool.end();
}

await main();
