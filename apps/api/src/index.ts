// Read API over the screening database. Hono app under basePath /api: the
// Next.js site mounts it at app/api/[...path]/route.ts and also calls it
// in-process from server components. Routes are written as if they live at
// the root (`/health` matches /api/health).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { pool } from "./db.js";

export const app = new Hono().basePath("/api");
app.use("*", cors());

// Persisted screening data updates only on the next ingest run; minutes-fresh
// is fine. stale-while-revalidate keeps the cache warm without blocking users.
const STABLE_CACHE = "public, s-maxage=300, stale-while-revalidate=3600";

app.get("/health", (c) => c.json({ ok: true, service: "mismanagement-api" }));

// ─────────────────────────────────────────────────────────────────────────
// Companies — list + detail
// ─────────────────────────────────────────────────────────────────────────

app.get("/companies", async (c) => {
  const r = await pool().query<{
    cik: string;
    ticker: string;
    name: string;
    sic_description: string | null;
  }>(
    `select cik, ticker, name, sic_description from companies order by ticker`,
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, companies: r.rows });
});

// Lightweight autocomplete for the home-page search bar. Ranks ticker
// prefix matches above name substring matches; caps at 10.
app.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 1) return c.json({ rows: [] });
  const r = await pool().query<{
    cik: string;
    ticker: string;
    name: string;
    sic_description: string | null;
  }>(
    `select cik, ticker, name, sic_description
     from companies
     where ticker ilike $1 || '%' or name ilike '%' || $1 || '%'
     order by case when ticker ilike $1 || '%' then 0 else 1 end, ticker
     limit 10`,
    [q],
  );
  return c.json({ rows: r.rows });
});

app.get("/companies/:ticker", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const r = await pool().query(
    `select cik, ticker, name, sic_description, fiscal_year_end,
            is_russell_3000, market_cap_at_universe_pull
     from companies where ticker = $1`,
    [ticker],
  );
  if (r.rows.length === 0) return c.json({ error: "not found" }, 404);
  c.header("Cache-Control", STABLE_CACHE);
  return c.json(r.rows[0]);
});

// ─────────────────────────────────────────────────────────────────────────
// Financials and prices
// ─────────────────────────────────────────────────────────────────────────

app.get("/companies/:ticker/financials", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const r = await pool().query<{
    fiscal_year: number;
    concept: string;
    value: number;
    unit: string;
  }>(
    `select fm.fiscal_year, fm.concept, fm.value, fm.unit
     from financial_metrics fm join companies c on c.cik = fm.cik
     where c.ticker = $1
     order by fm.concept, fm.fiscal_year`,
    [ticker],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, metrics: r.rows });
});

app.get("/companies/:ticker/prices", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 1500), 1), 5000);
  const r = await pool().query<{ trading_date: string; adj_close: number }>(
    `select trading_date::text, adj_close from price_history
     where ticker = $1 order by trading_date desc limit $2`,
    [ticker, limit],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, prices: r.rows.reverse() });
});

// ─────────────────────────────────────────────────────────────────────────
// Insider activity (Form 4) and 13D filings against the issuer
// ─────────────────────────────────────────────────────────────────────────

app.get("/companies/:ticker/insider-activity", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 365), 1), 3650);
  const r = await pool().query(
    `select i.transaction_date::text, i.insider_name, i.officer_title,
            i.is_director, i.is_officer, i.transaction_code, i.derivative,
            i.shares, i.price_per_share, i.transaction_value,
            i.acquired_or_disposed, i.ten_b_5_one_plan
     from insider_transactions i
     join companies c on c.cik = i.cik
     where c.ticker = $1
       and i.transaction_date >= current_date - ($2 || ' days')::interval
     order by i.transaction_date desc, i.transaction_value desc nulls last
     limit 500`,
    [ticker, String(days)],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, transactions: r.rows });
});

app.get("/companies/:ticker/13d", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const r = await pool().query(
    `select t.accession_number, t.form, t.filing_date::text, t.filer_name,
            t.is_active_intent, t.purpose_summary,
            t.cooperation_agreement_present, t.standstill_present,
            t.aggregate_percent, t.group_members
     from thirteen_d_filings t
     join companies c on c.cik = t.cik
     where c.ticker = $1
     order by t.filing_date desc`,
    [ticker],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, filings: r.rows });
});

// ─────────────────────────────────────────────────────────────────────────
// /screen — sortable list with key metrics. R3K issuers only by default.
// ─────────────────────────────────────────────────────────────────────────

// `activist_signal` is the headline composite — combines (a) TSR
// underperformance vs peers, (b) presence of a recent 13D filing, and
// (c) recent insider-transaction volume. Deliberately not displayed in
// the response — the screen exposes it only as a sort order, preserving
// the editorial premise "show facts, don't characterize."
//
// Weights:
//   tsr_gap: 0–500ish, dominant when peers blew the company away
//   recent_13d: +75 if any 13D in last 180 days
//   insider_tx_90d: tx_count/5, capped at 50
const ACTIVIST_SIGNAL_EXPR = `
  coalesce(greatest(x.peer_group_tsr_indexed - x.company_tsr_indexed, 0), 0)
  + (case when exists (
      select 1 from thirteen_d_filings tt
      where tt.cik = c.cik and tt.filing_date >= current_date - interval '180 days'
    ) then 75 else 0 end)
  + least(coalesce((
      select count(*) from insider_transactions ii
      where ii.cik = c.cik and ii.transaction_date >= current_date - interval '90 days'
    ), 0) / 5.0, 50)
`;

const SCREEN_SORTS: Record<string, string> = {
  activist_signal: ACTIVIST_SIGNAL_EXPR,
  ticker: "c.ticker",
  name: "c.name",
  market_cap: "c.market_cap_at_universe_pull",
  insider_tx_90d: "insider_tx_90d",
  // Sort by net insider dollar flow (signed). asc surfaces biggest net
  // sellers, desc the biggest net buyers (rare but high-signal).
  insider_net_dollars_365d: "insider_net_dollars_365d",
  latest_revenue: "latest_revenue",
  tsr_gap: "(coalesce(x.peer_group_tsr_indexed, 0) - coalesce(x.company_tsr_indexed, 0))",
};

app.get("/screen", async (c) => {
  const sortKey = (c.req.query("sort") ?? "activist_signal").toLowerCase();
  const sortCol = SCREEN_SORTS[sortKey] ?? SCREEN_SORTS.activist_signal;
  const dir = c.req.query("dir") === "asc" ? "asc" : "desc";
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 500);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

  const sql = `
    with latest_pvp as (
      select distinct on (cik) cik, fiscal_year, company_tsr_indexed, peer_group_tsr_indexed
      from xbrl_pay_vs_performance
      order by cik, fiscal_year desc
    ),
    latest_revenue as (
      -- financial_metrics.concept stores LOGICAL names (set in pull-edgar
      -- via annualConcepts). The earlier filter used raw XBRL names like
      -- 'us-gaap:Revenues' and matched zero rows.
      select distinct on (cik) cik, fiscal_year, value as revenue
      from financial_metrics
      where concept = 'revenue' and fiscal_year > 0
      order by cik, fiscal_year desc
    )
    select
      c.cik, c.ticker, c.name, c.sic_description,
      c.market_cap_at_universe_pull as market_cap,
      c.is_russell_3000,
      coalesce((
        select count(*) from insider_transactions i
        where i.cik = c.cik
          and i.transaction_date >= current_date - interval '90 days'
      ), 0)::int as insider_tx_90d,
      -- Net insider dollar flow (P - S). Negative = net selling. Most R3K
      -- issuers will be negative since equity awards converted to sales
      -- dominate normal-quarter activity; what's interesting is the magnitude.
      coalesce((
        select sum(case
          when transaction_code = 'P' then transaction_value
          when transaction_code = 'S' then -transaction_value
          else 0 end)
        from insider_transactions i
        where i.cik = c.cik
          and i.transaction_date >= current_date - interval '365 days'
      ), 0)::float as insider_net_dollars_365d,
      exists (
        select 1 from thirteen_d_filings t
        where t.cik = c.cik
          and t.filing_date >= current_date - interval '180 days'
      ) as has_recent_13d,
      exists (
        select 1 from thirteen_d_filings t
        where t.cik = c.cik
          and t.is_active_intent = true
          and t.filing_date >= current_date - interval '18 months'
      ) as has_active_13d,
      lr.revenue as latest_revenue,
      lr.fiscal_year as latest_revenue_year,
      x.company_tsr_indexed,
      x.peer_group_tsr_indexed,
      count(*) over() as total
    from companies c
    left join latest_pvp x on x.cik = c.cik
    left join latest_revenue lr on lr.cik = c.cik
    order by ${sortCol} ${dir} nulls last, c.ticker asc
    limit $1 offset $2
  `;

  const r = await pool().query<{
    cik: string; ticker: string; name: string; sic_description: string | null;
    market_cap: number | null; is_russell_3000: boolean;
    insider_tx_90d: number;
    insider_net_dollars_365d: number;
    has_recent_13d: boolean;
    has_active_13d: boolean;
    latest_revenue: number | null; latest_revenue_year: number | null;
    company_tsr_indexed: number | null; peer_group_tsr_indexed: number | null;
    total: string;
  }>(sql, [limit, offset]);

  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    count: r.rows.length,
    total: r.rows[0] ? Number(r.rows[0].total) : 0,
    rows: r.rows.map(({ total: _t, ...rest }) => rest),
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /mismanagement — nine deterministic red-flag checks per R3K issuer.
// ─────────────────────────────────────────────────────────────────────────
// Ranking is `# of flags fired`. NULL inputs are treated as "indeterminate"
// (the flag does NOT fire) so we don't punish issuers for missing data.
// Each flag has a stable id so the frontend can render a fixed strip in
// the same order across rows, and each row carries the supporting value
// inline for reader inspection — no opaque scoring.
//
// Flag thresholds were chosen to be at the magnitude where the signal is
// hard to handwave away in a single year (e.g. > $10M net insider selling,
// not > $1M). They're not statistical limits — they're "this is large
// enough that a journalist could write it down."

// /companies/:ticker/profile — everything the company page renders, from
// deterministic tables only. One round trip
// per section, all in parallel; sections are empty arrays / null when the
// ingest hasn't reached this issuer yet.
const PROFILE_CONCEPTS = [
  "revenue", "operating_income", "net_income", "operating_cash_flow", "capex",
  "sbc", "buybacks", "dividends_paid", "depreciation_amortization",
  "interest_expense", "cost_of_revenue", "operating_expenses_total",
];
const PROFILE_POINT_CONCEPTS = [
  "cash_latest", "total_debt_latest", "long_term_debt_latest", "total_assets_latest",
  "goodwill_latest", "total_equity_latest", "shares_outstanding_latest",
];

app.get("/companies/:ticker/profile", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const co = await pool().query<{
    cik: string; ticker: string; name: string; sic: string | null; sic_description: string | null;
    fiscal_year_end: string | null; is_russell_3000: boolean; market_cap: number | null;
  }>(
    `select cik, ticker, name, sic, sic_description, fiscal_year_end, is_russell_3000,
            market_cap_at_universe_pull as market_cap
       from companies where ticker = $1`,
    [ticker],
  );
  if (co.rows.length === 0) return c.json({ error: "not found" }, 404);
  const { cik } = co.rows[0]!;

  const [annual, point, scores, headcount, text, deals, pvp, insiders, thirteenD, prices] = await Promise.all([
    pool().query<{ fiscal_year: number; concept: string; value: number }>(
      `select fiscal_year, concept, value from financial_metrics
        where cik = $1 and fiscal_year > 0 and concept = any($2)
          and fiscal_year >= (select max(fiscal_year) - 4 from financial_metrics where cik = $1 and fiscal_year > 0)
        order by fiscal_year`,
      [cik, PROFILE_CONCEPTS],
    ),
    pool().query<{ concept: string; value: number }>(
      `select concept, value from financial_metrics where cik = $1 and fiscal_year = -1 and concept = any($2)`,
      [cik, PROFILE_POINT_CONCEPTS],
    ),
    pool().query(`select * from mismanagement_scores where cik = $1`, [cik]),
    pool().query<{ fiscal_year: number; employees: number; matched_text: string; accession_number: string }>(
      `select fiscal_year, employees, matched_text, accession_number from headcount
        where cik = $1 order by fiscal_year desc limit 1`,
      [cik],
    ),
    pool().query<{ filing_date: string; word_count: number; ai_term_count: number }>(
      `select filing_date::text, word_count, ai_term_count from filing_text_signals
        where cik = $1 order by filing_date desc limit 1`,
      [cik],
    ),
    pool().query(
      `select accession_number, form, filing_date::text as filing_date, acquirer, matched_buyer,
              price_per_share, premium_pct, document_url
         from deal_filings where cik = $1 and (form <> '8-K' or matched_buyer is not null)
        order by filing_date desc limit 20`,
      [cik],
    ),
    pool().query(
      `select fiscal_year, peo_total_comp, peo_compensation_actually_paid,
              company_tsr_indexed, peer_group_tsr_indexed
         from xbrl_pay_vs_performance where cik = $1 order by fiscal_year desc limit 5`,
      [cik],
    ),
    pool().query<{ buys: string; sells: string; n_buys: string; n_sells: string }>(
      `select coalesce(sum(transaction_value) filter (where transaction_code = 'P'), 0)::text as buys,
              coalesce(sum(transaction_value) filter (where transaction_code = 'S'), 0)::text as sells,
              count(*) filter (where transaction_code = 'P')::text as n_buys,
              count(*) filter (where transaction_code = 'S')::text as n_sells
         from insider_transactions
        where cik = $1 and not derivative and transaction_date >= current_date - interval '365 days'`,
      [cik],
    ),
    pool().query(
      `select accession_number, form, filing_date::text as filing_date, filer_name,
              aggregate_percent, is_active_intent, purpose_summary
         from thirteen_d_filings where cik = $1 order by filing_date desc limit 10`,
      [cik],
    ),
    pool().query<{ trading_date: string; adj_close: number }>(
      `select trading_date::text, adj_close from price_history
        where ticker = $1 and trading_date >= current_date - interval '400 days'
        order by trading_date`,
      [ticker],
    ),
  ]);

  // Pivot annual metrics to { [concept]: { [fy]: value } }.
  const years = [...new Set(annual.rows.map((r) => r.fiscal_year))].sort();
  const series: Record<string, Record<number, number>> = {};
  for (const r of annual.rows) (series[r.concept] ??= {})[r.fiscal_year] = Number(r.value);
  const latest: Record<string, number> = {};
  for (const r of point.rows) latest[r.concept] = Number(r.value);

  const fy = years.at(-1);
  const at = (k: string) => (fy != null ? series[k]?.[fy] : undefined);
  const ebitda = at("operating_income") != null ? at("operating_income")! + (at("depreciation_amortization") ?? 0) : null;
  const debt = latest.total_debt_latest ?? latest.long_term_debt_latest;
  const netDebt = debt != null ? debt - (latest.cash_latest ?? 0) : null;
  const hc = headcount.rows[0] ?? null;
  const ai = text.rows[0] ?? null;
  const ins = insiders.rows[0]!;

  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    company: co.rows[0],
    flags: MISMANAGEMENT_FLAGS,
    scores: scores.rows[0] ?? null,
    financials: { years, series, latest },
    derived: {
      fiscal_year: fy ?? null,
      ebitda,
      net_debt: netDebt,
      net_debt_to_ebitda: netDebt != null && ebitda && ebitda > 0 ? netDebt / ebitda : null,
      revenue_per_employee: hc && at("revenue") ? at("revenue")! / hc.employees : null,
      ai_mentions_per_10k_words: ai && ai.word_count ? (ai.ai_term_count / ai.word_count) * 1e4 : null,
    },
    headcount: hc,
    text_signals: ai,
    deals: deals.rows,
    pay_vs_performance: pvp.rows,
    insiders_365d: {
      buys: Number(ins.buys), sells: Number(ins.sells),
      buy_count: Number(ins.n_buys), sell_count: Number(ins.n_sells),
    },
    thirteen_d: thirteenD.rows,
    prices: prices.rows,
  });
});

// /deals — confirmed deal-process filings (merger proxies, going-private
// schedules, tender offers) plus Item 1.01 8-Ks matched to an AI-rollup
// buyer by full-text search. matched_buyer is a mention, not attribution.
app.get("/deals", async (c) => {
  const r = await pool().query(
    `select d.accession_number, c.ticker, c.name, d.form, d.filing_date::text as filing_date,
            d.acquirer, d.matched_buyer, d.price_per_share, d.premium_pct, d.document_url
       from deal_filings d join companies c on c.cik = d.cik
      where d.form <> '8-K' or d.matched_buyer is not null
      order by d.filing_date desc
      limit 500`,
    [],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ rows: r.rows });
});

const MISMANAGEMENT_FLAGS = [
  "tsr_under",        // 1. TSR < peer TSR in 3+ of last 5 PvP years
  "pay_through_it",   // 2. Median PEO total comp ≥ $15M AND flag 1
  "active_13d",       // 3. ≥1 active-intent 13D in last 18 months
  "insider_selling",  // 4. Net P-S insider $ < -$10M over 12mo
  "earnings_cash",    // 5. OCF / NI < 0.8 in latest FY (NI > 0)
  "dilutive_sbc",     // 6. SBC > 10% of revenue (latest FY)
  "returns_over_fcf", // 7. (Buybacks + dividends) > OCF (latest FY)
  "goodwill_heavy",   // 8. Goodwill > 40% of total assets
  "governance_dissent", // 9. Latest SoP support <80% OR any director support <80%
] as const;

app.get("/mismanagement", async (c) => {
  const minMcap = Number(c.req.query("min_mcap") ?? 500e6);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 3000);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

  // Reads from the materialized mismanagement_scores table — refreshed
  // out-of-band by refresh-mismanagement.ts. Single-pass index scan, no
  // CTE pipeline at request time.
  //
  // The select list is deliberately narrow: every column here is shown
  // somewhere on the leaderboard (table row + evidence chips + sector +
  // mcap + flag dots). Dropped capex, latest_pvp_year, latest_vote_meeting_date
  // because the leaderboard doesn't reference them; per-company endpoints
  // serve those when a reader drills in.
  const sql = `
    select
      c.cik, c.ticker, c.name, c.sic_description,
      c.market_cap_at_universe_pull as market_cap,
      ms.years_under, ms.years_tracked, ms.peo_median,
      ms.latest_company_tsr, ms.latest_peer_tsr,
      ms.revenue, ms.net_income, ms.ocf, ms.sbc,
      ms.buybacks, ms.dividends_paid,
      ms.total_assets, ms.goodwill,
      ms.insider_net_365d, ms.active_13d_count,
      ms.flag_tsr_under, ms.flag_pay_through_it, ms.flag_active_13d,
      ms.flag_insider_selling, ms.flag_earnings_cash, ms.flag_dilutive_sbc,
      ms.flag_returns_over_fcf, ms.flag_goodwill_heavy,
      ms.flag_governance_dissent,
      ms.latest_sop_support_pct, ms.latest_min_director_support_pct,
      count(*) over() as total
    from mismanagement_scores ms
    join companies c on c.cik = ms.cik
    where c.is_russell_3000
      and (c.market_cap_at_universe_pull is null or c.market_cap_at_universe_pull >= $1::float8)
    order by ms.flags_fired desc, ms.tiebreak desc, c.ticker asc
    limit $2 offset $3
  `;

  const [r, dist] = await Promise.all([
    pool().query<Record<string, unknown> & { total: string }>(sql, [minMcap, limit, offset]),
    // Flag-count histogram + freshness for the leaderboard summary.
    pool().query<{ flags_fired: number; n: string; refreshed_at: string }>(
      `select ms.flags_fired, count(*)::text as n, max(ms.refreshed_at)::text as refreshed_at
         from mismanagement_scores ms join companies c on c.cik = ms.cik
        where c.is_russell_3000
          and (c.market_cap_at_universe_pull is null or c.market_cap_at_universe_pull >= $1::float8)
        group by 1 order by 1`,
      [minMcap],
    ),
  ]);

  // Strip null fields per-row — Postgres returns every column as a key
  // including the ~40% that are null per typical row, and JSON.stringify
  // serializes them as ",field:null". On 2.5K rows that's hundreds of KB
  // of pure overhead before gzip. The client treats missing == null.
  const slim: Record<string, unknown>[] = [];
  for (const row of r.rows) {
    const out: Record<string, unknown> = {};
    for (const k in row) {
      if (k === "total") continue;
      const v = row[k];
      if (v != null && v !== false) out[k] = v; // also drop false flag bools
    }
    slim.push(out);
  }

  // The materialized scoreboard refreshes via daily cron; serve aggressively
  // and let Vercel Edge keep the JSON warm at the CDN.
  c.header(
    "Cache-Control",
    "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800",
  );
  return c.json({
    count: r.rows.length,
    total: r.rows[0] ? Number(r.rows[0].total) : 0,
    flags: MISMANAGEMENT_FLAGS,
    distribution: dist.rows.map((d) => ({ flags_fired: Number(d.flags_fired), count: Number(d.n) })),
    refreshed_at: dist.rows.reduce<string | null>((m, d) => (m && m > d.refreshed_at ? m : d.refreshed_at), null),
    rows: slim,
  });
});

// Per-company mismanagement scorecard. Single-row read from the
// materialized mismanagement_scores table.
app.get("/companies/:ticker/mismanagement", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const out = await pool().query(
    `select
       ms.years_under, ms.years_tracked, ms.peo_median,
       ms.latest_company_tsr, ms.latest_peer_tsr, ms.latest_pvp_year,
       ms.revenue, ms.net_income, ms.ocf, ms.capex, ms.sbc,
       ms.buybacks, ms.dividends_paid,
       ms.total_assets, ms.goodwill,
       ms.insider_net_365d, ms.active_13d_count,
       ms.flag_tsr_under, ms.flag_pay_through_it, ms.flag_active_13d,
       ms.flag_insider_selling, ms.flag_earnings_cash, ms.flag_dilutive_sbc,
       ms.flag_returns_over_fcf, ms.flag_goodwill_heavy,
       ms.flag_governance_dissent,
       ms.latest_sop_support_pct, ms.latest_min_director_support_pct,
       ms.latest_vote_meeting_date::text as latest_vote_meeting_date
     from companies c
     join mismanagement_scores ms on ms.cik = c.cik
     where c.ticker = $1
     limit 1`,
    [ticker],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ flags: MISMANAGEMENT_FLAGS, row: out.rows[0] ?? null });
});

// /mismanagement/rank/:ticker — read from the materialized scoreboard.
// row_number() over the index-ordered set; one filter to find the ticker.
app.get("/mismanagement/rank/:ticker", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const sql = `
    with ranked as (
      select c.ticker,
             row_number() over (order by ms.flags_fired desc, ms.tiebreak desc, c.ticker asc) as rank,
             count(*) over () as total
      from mismanagement_scores ms
      join companies c on c.cik = ms.cik
      where c.is_russell_3000
    )
    select rank::int as rank, total::int as total
    from ranked where ticker = $1
  `;
  const out = await pool().query<{ rank: number; total: number }>(sql, [ticker]);
  c.header("Cache-Control", STABLE_CACHE);
  return c.json(out.rows[0] ?? { rank: null, total: 0 });
});

// ─────────────────────────────────────────────────────────────────────────
// Feeds
// ─────────────────────────────────────────────────────────────────────────

app.get("/feeds/13d-recent", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 8), 1), 200);
  const activeOnly = c.req.query("active_only") === "1";
  const sinceDays = Math.min(Math.max(Number(c.req.query("since_days") ?? 365), 1), 1825);
  const r = await pool().query(
    `select t.accession_number, t.form, t.filing_date::text, t.filer_name,
            t.is_active_intent, t.purpose_summary,
            t.cooperation_agreement_present, t.standstill_present,
            t.aggregate_percent, t.group_members,
            c.ticker, c.name as company_name, c.sic_description,
            c.market_cap_at_universe_pull as market_cap
     from thirteen_d_filings t
     join companies c on c.cik = t.cik
     where t.filing_date >= current_date - ($2::int || ' days')::interval
       ${activeOnly ? "and t.is_active_intent = true" : ""}
     order by t.filing_date desc
     limit $1`,
    [limit, sinceDays],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, filings: r.rows });
});

app.get("/feeds/insider-buys", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 8), 1), 50);
  // P = open-market or private purchase (Form 4). Filter to material trades
  // (≥ $100k value) so the feed surfaces meaningful signal.
  const r = await pool().query(
    `select i.transaction_date::text, i.insider_name, i.officer_title,
            i.shares, i.price_per_share, i.transaction_value,
            c.ticker, c.name as company_name
     from insider_transactions i
     join companies c on c.cik = i.cik
     where i.transaction_code = 'P'
       and i.derivative = false
       and coalesce(i.transaction_value, 0) >= 100000
       and i.transaction_date >= current_date - interval '180 days'
     order by i.transaction_value desc nulls last, i.transaction_date desc
     limit $1`,
    [limit],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, transactions: r.rows });
});

app.get("/feeds/tsr-underperformers", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 8), 1), 50);
  // For each company, take the latest fiscal year of XBRL PvP data, then
  // rank by peer_tsr - company_tsr (positive = company underperformed peers).
  const r = await pool().query(
    `with latest as (
       select distinct on (cik) cik, fiscal_year,
              company_tsr_indexed, peer_group_tsr_indexed,
              (peer_group_tsr_indexed - company_tsr_indexed) as gap
       from xbrl_pay_vs_performance
       where company_tsr_indexed is not null
         and peer_group_tsr_indexed is not null
       order by cik, fiscal_year desc
     )
     select c.ticker, c.name, l.fiscal_year, l.company_tsr_indexed,
            l.peer_group_tsr_indexed, l.gap
     from latest l
     join companies c on c.cik = l.cik
     where l.gap > 0
     order by l.gap desc
     limit $1`,
    [limit],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, rows: r.rows });
});


// ─────────────────────────────────────────────────────────────────────────
// /feeds/13d-by-filer — recent 13D activity grouped by filer
// ─────────────────────────────────────────────────────────────────────────

app.get("/feeds/13d-by-filer", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  const r = await pool().query(
    `with recent as (
       select t.filer_name, t.cik, t.filing_date, t.is_active_intent,
              t.aggregate_percent, t.form, t.accession_number,
              c.ticker, c.name as company_name
       from thirteen_d_filings t
       join companies c on c.cik = t.cik
       where t.filer_name is not null
       order by t.filing_date desc
     ),
     by_filer as (
       select filer_name,
              count(distinct cik)::int as target_count,
              count(*)::int as filing_count,
              max(filing_date)::text as latest_filing_date,
              bool_or(is_active_intent) as has_active_intent,
              json_agg(
                json_build_object(
                  'ticker', ticker,
                  'company_name', company_name,
                  'filing_date', filing_date::text,
                  'form', form,
                  'aggregate_percent', aggregate_percent,
                  'is_active_intent', is_active_intent
                )
                order by filing_date desc
              ) as filings
       from recent
       group by filer_name
     )
     select * from by_filer
     order by has_active_intent desc nulls last,
              latest_filing_date desc
     limit $1`,
    [limit],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, filers: r.rows });
});

// ─────────────────────────────────────────────────────────────────────────
// /feeds/comp-* — compensation outlier leaderboards
// ─────────────────────────────────────────────────────────────────────────

app.get("/feeds/comp-pay-gap", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 3000);
  // (PEO comp actually paid) - (PEO total comp). Positive = paid more in
  // value than reported in summary; negative = paid less (PvP markdowns
  // dominated). Both directions are editorially interesting; we surface by
  // absolute magnitude.
  //
  // We filter out values > $1B per the data-quality scrub: ~0.5% of rows
  // are filer mis-tagging artifacts (scale/decimals mismatch in iXBRL)
  // that we can't reliably disambiguate at parse time. Musk-tier outliers
  // also exceed $1B but they're a rounding edge case best surfaced via
  // dedicated editorial coverage, not the leaderboard.
  const r = await pool().query(
    `with latest as (
       select distinct on (cik) cik, fiscal_year,
              peo_total_comp, peo_compensation_actually_paid,
              (peo_compensation_actually_paid - peo_total_comp) as gap
       from xbrl_pay_vs_performance
       where peo_total_comp is not null
         and peo_compensation_actually_paid is not null
         and abs(peo_total_comp) <= 1e9
         and abs(peo_compensation_actually_paid) <= 1e9
       order by cik, fiscal_year desc
     )
     select c.ticker, c.name as company_name, l.fiscal_year,
            l.peo_total_comp, l.peo_compensation_actually_paid, l.gap
     from latest l
     join companies c on c.cik = l.cik
     order by abs(l.gap) desc
     limit $1`,
    [limit],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, rows: r.rows });
});
