// Point-in-time backtest panel. For each cohort year Y, rebuild the signals
// as they stood on April 1 of Y+1 for every company that reported to the SEC,
// delisted ones included, and label whether a deal filing followed within
// 12 months. Writes backtest_panel and prints how each signal did.
//
// Inputs, all knowable on the as-of date:
//   - XBRL frames (data.sec.gov/api/xbrl/frames) for calendar year Y: one
//     fact per filer for the period, so the cross-section includes companies
//     that no longer exist. Frames return the latest filed value, so a
//     restatement filed after the as-of date can leak in; rare for these
//     concepts.
//   - Public float from the 10-K cover (dei:EntityPublicFloat, mid-year Y),
//     standing in for market cap: the universe is float >= $500M with
//     positive revenue, and buyout-sized is float up to $5B.
//   - Schedule 13Ds from sc13d_index (pull-deal-history), subject resolved
//     from the filing header, in the 18 months before the as-of date.
//   - Deal filings from deal_filings (non-self, issuer acquired or unknown).
//
// Companies with a deal filing in the 12 months before the as-of date are
// left out of that cohort: they were already in a sale process.
//
// Not rebuilt (no point-in-time source kept): TSR below peers, CEO pay,
// shareholder dissent, insider selling, revenue per employee, quiet on AI.
//
// CLI:
//   tsx src/build-backtest.ts                 # cohorts 2018..(last complete)
//   tsx src/build-backtest.ts --report        # print stats from the stored panel

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { headerSubject } from "./header.js";

const SIGNALS = [
  "flag_earnings_cash", "flag_dilutive_sbc", "flag_returns_over_fcf", "flag_goodwill_heavy",
  "signal_debt_capacity", "signal_size_fit", "flag_active_13d",
] as const;
type Signal = (typeof SIGNALS)[number];

const MIN_FLOAT = 500e6;
const MAX_SIZE_FIT = 5e9;

let lastFetch = 0;
async function secJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const wait = 125 - (Date.now() - lastFetch);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetch = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": EDGAR_USER_AGENT }, signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return null;
      if (res.ok) return (await res.json()) as T;
      if (attempt >= 5) throw new Error(`${res.status} ${url}`);
      await new Promise((r) => setTimeout(r, (res.status === 429 ? 15_000 : 2000) * 2 ** attempt));
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

interface Frame { data: { cik: number; entityName: string; val: number }[] }
type Values = Map<string, number>;

// First concept in the list that a company reports wins, as in pull-edgar.
async function frame(concepts: string[], period: string, ns = "us-gaap"): Promise<{ values: Values; names: Map<string, string> }> {
  const values: Values = new Map(), names = new Map<string, string>();
  for (const c of concepts) {
    const f = await secJson<Frame>(`https://data.sec.gov/api/xbrl/frames/${ns}/${c}/USD/${period}.json`);
    for (const d of f?.data ?? []) {
      const cik = String(d.cik).padStart(10, "0");
      if (!values.has(cik)) values.set(cik, d.val);
      names.set(cik, d.entityName);
    }
  }
  return { values, names };
}

const CONCEPTS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "Revenues", "SalesRevenueNet"],
  net_income: ["NetIncomeLoss"],
  ocf: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  sbc: ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
  buybacks: ["PaymentsForRepurchaseOfCommonStock"],
  dividends: ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"],
  operating_income: ["OperatingIncomeLoss"],
  da: ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "Depreciation"],
} as const;
const INSTANT = {
  assets: ["Assets"],
  goodwill: ["Goodwill"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "Cash", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  debt: ["LongTermDebt", "LongTermDebtNoncurrent"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
} as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addMonths = (d: string, m: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return iso(x); };

async function subjectFromHeader(accession: string, anyCik: string): Promise<string | null> {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(anyCik)}/${accession.replace(/-/g, "")}`;
  for (const url of [`${base}/${accession}.hdr.sgml`, `${base}/${accession}-index-headers.html`]) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = 125 - (Date.now() - lastFetch);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastFetch = Date.now();
      const res = await fetch(url, { headers: { "User-Agent": EDGAR_USER_AGENT }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (res?.status === 404) break;
      if (!res?.ok) { await new Promise((r) => setTimeout(r, (res?.status === 429 ? 15_000 : 2000) * 2 ** attempt)); continue; }
      return headerSubject(await res.text());
    }
  }
  return null;
}

// Resolve the subject of every 13D with at least one universe party; cached
// in sc13d_subject so reruns only fetch new filings.
async function resolve13dSubjects(universe: Set<string>): Promise<void> {
  const rows = (await pool.query<{ accession_number: string; ciks: string[] }>(
    `select i.accession_number, array_agg(i.cik) ciks from sc13d_index i
      where not exists (select 1 from sc13d_subject s where s.accession_number = i.accession_number)
      group by 1`,
  )).rows.filter((r) => r.ciks.some((c) => universe.has(c)));
  console.log(`13D subjects to resolve: ${rows.length}`);
  let done = 0;
  for (const r of rows) {
    const subject = r.ciks.length === 1 ? r.ciks[0]! : await subjectFromHeader(r.accession_number, r.ciks[0]!);
    await pool.query(`insert into sc13d_subject values ($1,$2) on conflict do nothing`, [r.accession_number, subject]);
    if (++done % 500 === 0) console.log(`  ${done}/${rows.length}`);
  }
}

interface Row {
  cik: string; cohort_year: number; as_of: string; name: string | null; public_float: number; revenue: number;
  signals: Record<Signal, boolean>; score: number; target: boolean; event_date: string | null; event_accession: string | null;
  measures: Record<Measure, number | null>;
}

// The numbers behind the flags, stored for fit-model.ts.
const MEASURES = ["ocf_to_net_income", "sbc_to_revenue", "payouts_to_ocf", "goodwill_to_assets", "net_debt_to_ebitda",
  "revenue_growth", "float_change", "float_to_book", "operating_margin", "roa", "cash_to_assets", "debt_to_assets",
  "thirteen_d_count"] as const;
type Measure = (typeof MEASURES)[number];

async function cohort(year: number): Promise<Row[]> {
  const asOf = `${year + 1}-04-01`;
  const dur = `CY${year}`, inst = `CY${year}Q4I`;
  const fl = await frame(["EntityPublicFloat"], `CY${year}Q2I`, "dei");
  const f: Record<string, Values> = {};
  const names = new Map(fl.names);
  for (const [k, cs] of Object.entries(CONCEPTS)) { const r = await frame([...cs], dur); f[k] = r.values; r.names.forEach((v, c) => names.set(c, names.get(c) ?? v)); }
  for (const [k, cs] of Object.entries(INSTANT)) f[k] = (await frame([...cs], inst)).values;
  // Prior year, for growth and the float-change momentum proxy.
  const prevRev = (await frame([...CONCEPTS.revenue], `CY${year - 1}`)).values;
  const prevFloat = (await frame(["EntityPublicFloat"], `CY${year - 1}Q2I`, "dei")).values;

  const universe = [...fl.values].filter(([cik, v]) => v >= MIN_FLOAT && (f.revenue!.get(cik) ?? 0) > 0).map(([cik]) => cik);
  const uset = new Set(universe);
  await resolve13dSubjects(uset);

  const thirteenD = new Map((await pool.query<{ subject_cik: string; n: number }>(
    `select s.subject_cik, count(distinct s.accession_number)::int n
       from sc13d_subject s join sc13d_index i using (accession_number)
      where s.subject_cik is not null and i.filing_date > $1::date and i.filing_date <= $2::date
      group by 1`,
    [addMonths(asOf, -18), asOf],
  )).rows.map((r) => [r.subject_cik, r.n]));

  const deals = (await pool.query<{ cik: string; filing_date: string; accession_number: string }>(
    `select cik, filing_date::text, accession_number from deal_filings
      where not is_self_filed and form <> '8-K' and issuer_acquired is not false
        and filing_date > $1::date and filing_date <= $2::date
      order by filing_date`,
    [addMonths(asOf, -12), addMonths(asOf, 12)],
  )).rows;
  const prior = new Set(deals.filter((d) => d.filing_date <= asOf).map((d) => d.cik));
  const next = new Map<string, { filing_date: string; accession_number: string }>();
  for (const d of deals) if (d.filing_date > asOf && !next.has(d.cik)) next.set(d.cik, d);

  const out: Row[] = [];
  for (const cik of universe) {
    if (prior.has(cik)) continue;
    const g = (k: string) => f[k]!.get(cik);
    const rev = g("revenue")!, ni = g("net_income"), ocf = g("ocf"), sbc = g("sbc");
    const ebitda = g("operating_income") != null ? g("operating_income")! + (g("da") ?? 0) : null;
    const debt = g("debt"), assets = g("assets"), gw = g("goodwill");
    const signals: Record<Signal, boolean> = {
      flag_earnings_cash: ni != null && ni > 0 && ocf != null && ocf < 0.8 * ni,
      flag_dilutive_sbc: sbc != null && sbc > 0.1 * rev,
      flag_returns_over_fcf: ocf != null && ocf > 0 && (g("buybacks") ?? 0) + (g("dividends") ?? 0) > ocf,
      flag_goodwill_heavy: gw != null && assets != null && assets > 0 && gw > 0.4 * assets,
      signal_debt_capacity: ebitda != null && ebitda > 0 && debt != null && debt - (g("cash") ?? 0) < 0,
      signal_size_fit: fl.values.get(cik)! <= MAX_SIZE_FIT,
      flag_active_13d: thirteenD.has(cik),
    };
    const payouts = (g("buybacks") ?? 0) + (g("dividends") ?? 0);
    const measures: Record<Measure, number | null> = {
      ocf_to_net_income: ni != null && ni > 0 && ocf != null ? ocf / ni : null,
      sbc_to_revenue: sbc != null ? sbc / rev : null,
      payouts_to_ocf: ocf != null && ocf > 0 ? payouts / ocf : null,
      goodwill_to_assets: assets != null && assets > 0 ? (gw ?? 0) / assets : null,
      net_debt_to_ebitda: ebitda != null && ebitda > 0 && debt != null ? (debt - (g("cash") ?? 0)) / ebitda : null,
      revenue_growth: (prevRev.get(cik) ?? 0) > 0 ? rev / prevRev.get(cik)! - 1 : null,
      float_change: (prevFloat.get(cik) ?? 0) > 0 ? fl.values.get(cik)! / prevFloat.get(cik)! - 1 : null,
      float_to_book: (g("equity") ?? 0) > 0 ? fl.values.get(cik)! / g("equity")! : null,
      operating_margin: g("operating_income") != null ? g("operating_income")! / rev : null,
      roa: ni != null && assets != null && assets > 0 ? ni / assets : null,
      cash_to_assets: assets != null && assets > 0 ? (g("cash") ?? 0) / assets : null,
      debt_to_assets: assets != null && assets > 0 ? (debt ?? 0) / assets : null,
      thirteen_d_count: thirteenD.get(cik) ?? 0,
    };
    const ev = next.get(cik);
    out.push({
      measures,
      cik, cohort_year: year, as_of: asOf, name: names.get(cik) ?? null, public_float: fl.values.get(cik)!, revenue: rev,
      signals, score: SIGNALS.filter((s) => signals[s]).length,
      target: ev != null, event_date: ev?.filing_date ?? null, event_accession: ev?.accession_number ?? null,
    });
  }
  return out;
}

async function write(rows: Row[], year: number): Promise<void> {
  await pool.query(`delete from backtest_panel where cohort_year = $1`, [year]);
  for (let i = 0; i < rows.length; i += 500) {
    const c = rows.slice(i, i + 500);
    const col = <T>(fn: (r: Row) => T) => c.map(fn);
    await pool.query(
      `insert into backtest_panel (cik, cohort_year, as_of, name, public_float, revenue, ${SIGNALS.join(", ")}, score, target, event_date, event_accession, ${MEASURES.join(", ")})
       select * from unnest($1::text[], $2::smallint[], $3::date[], $4::text[], $5::float8[], $6::float8[],
         ${SIGNALS.map((_, j) => `$${7 + j}::boolean[]`).join(", ")}, $14::smallint[], $15::boolean[], $16::date[], $17::text[],
         ${MEASURES.map((m, j) => `$${18 + j}::${m === "thirteen_d_count" ? "int" : "float8"}[]`).join(", ")})`,
      [col((r) => r.cik), col((r) => r.cohort_year), col((r) => r.as_of), col((r) => r.name), col((r) => r.public_float), col((r) => r.revenue),
        ...SIGNALS.map((s) => col((r) => r.signals[s])), col((r) => r.score), col((r) => r.target), col((r) => r.event_date), col((r) => r.event_accession),
        ...MEASURES.map((m) => col((r) => r.measures[m]))],
    );
  }
}

async function report(): Promise<void> {
  const t = await pool.query(`select count(*)::int n, sum(target::int)::int hits, ${SIGNALS.map((s) =>
    `sum((${s} and target)::int)::int ${s}_t, sum((${s} and not target)::int)::int ${s}_o`).join(", ")} from backtest_panel`);
  const r = t.rows[0];
  const base = r.hits / r.n;
  console.log(`panel: ${r.n} company-years, ${r.hits} followed by a deal (${(100 * base).toFixed(1)}%)`);
  console.table(SIGNALS.map((s) => {
    const fired = r[`${s}_t`] + r[`${s}_o`];
    return { signal: s, fired, deal_rate: `${(100 * r[`${s}_t`] / fired).toFixed(1)}%`, lift: (r[`${s}_t`] / fired / base).toFixed(2) };
  }));
  const b = await pool.query(`select score, count(*)::int n, sum(target::int)::int hits from backtest_panel group by 1 order by 1`);
  console.table(b.rows.map((x) => ({ score: x.score, n: x.n, deals: x.hits, rate: `${(100 * x.hits / x.n).toFixed(1)}%` })));
  const y = await pool.query(`select cohort_year, count(*)::int n, sum(target::int)::int hits from backtest_panel group by 1 order by 1`);
  console.table(y.rows);
}

async function main(): Promise<void> {
  if (!process.argv.includes("--report")) {
    // A cohort is complete once its 12-month label window has passed.
    const last = new Date().getUTCFullYear() - 2 + (new Date().getUTCMonth() >= 3 ? 0 : -1);
    for (let year = 2018; year <= last; year++) {
      const rows = await cohort(year);
      await write(rows, year);
      console.log(`cohort ${year}: ${rows.length} companies, ${rows.filter((r) => r.target).length} deals`);
    }
  }
  await report();
  await pool.end();
}

await main();
