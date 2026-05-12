// Hono app under basePath /api so a single Edge function handles every
// /api/* request when wired up via api/[[...path]].ts at the repo root.
// Routes are written as if they live at the root (`/health` matches /api/health).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { pool } from "./db.js";

export const app = new Hono().basePath("/api");
app.use("*", cors());

// Persisted screening data updates only on the next ingest run; minutes-fresh
// is fine. stale-while-revalidate keeps the cache warm without blocking users.
const STABLE_CACHE = "public, s-maxage=300, stale-while-revalidate=3600";

app.get("/health", (c) => c.json({ ok: true, service: "activist-investing-api" }));

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
// Financials, prices, raw proxy
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

app.get("/companies/:ticker/proxy", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const r = await pool().query(
    `select pe.id, pe.cik, pe.fiscal_year_covered, pe.accession_number,
            f.filing_date::text, pe.model, pe.extracted_at::text, pe.raw_json
     from proxy_extractions pe
     join companies c on c.cik = pe.cik
     join filings f on f.accession_number = pe.accession_number
     where c.ticker = $1
     order by pe.fiscal_year_covered desc
     limit 1`,
    [ticker],
  );
  if (r.rows.length === 0) return c.json({ error: "no extraction found" }, 404);
  c.header("Cache-Control", STABLE_CACHE);
  return c.json(r.rows[0]);
});

// ─────────────────────────────────────────────────────────────────────────
// Compensation — Summary Comp Table + Pay-vs-Performance.
//
// PvP is layered: xbrl_pay_vs_performance (deterministic, ECD-tagged) is the
// authoritative source. The LLM-extracted pay_vs_performance from the proxy
// is fallback for issuers that haven't tagged the table yet. We coalesce per
// fiscal year so the API hands back one consistent series.
// ─────────────────────────────────────────────────────────────────────────

app.get("/companies/:ticker/comp", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();

  // ext + xbrl don't depend on each other — run in parallel.
  const [ext, xbrl] = await Promise.all([
    pool().query<{
      id: number; extracted_at: string; model: string; fiscal_year_covered: number;
    }>(
      `select pe.id, pe.extracted_at::text, pe.model, pe.fiscal_year_covered
       from proxy_extractions pe
       join companies cmp on cmp.cik = pe.cik
       where cmp.ticker = $1
       order by pe.fiscal_year_covered desc, pe.extracted_at desc
       limit 1`,
      [ticker],
    ),
    pool().query<{
      fiscal_year: number;
      peo_total_comp: number | null;
      peo_compensation_actually_paid: number | null;
      non_peo_neo_avg_total_comp: number | null;
      non_peo_neo_avg_compensation_actually_paid: number | null;
      company_tsr_indexed: number | null;
      peer_group_tsr_indexed: number | null;
      gaap_net_income: number | null;
    }>(
      `select x.fiscal_year, x.peo_total_comp, x.peo_compensation_actually_paid,
              x.non_peo_neo_avg_total_comp, x.non_peo_neo_avg_compensation_actually_paid,
              x.company_tsr_indexed, x.peer_group_tsr_indexed, x.gaap_net_income
       from xbrl_pay_vs_performance x
       join companies cmp on cmp.cik = x.cik
       where cmp.ticker = $1
       order by x.fiscal_year desc`,
      [ticker],
    ),
  ]);
  const extraction = ext.rows[0] ?? null;

  // The two extraction-scoped queries can also fan out in parallel once
  // we know the extraction id.
  const [comp, pvpFallback] = extraction
    ? await Promise.all([
        pool().query(
          `select name, title, fiscal_year, salary, bonus, stock_awards,
                  option_awards, non_equity_incentive, change_in_pension,
                  all_other_compensation, total
           from summary_compensation
           where extraction_id = $1
           order by fiscal_year desc, total desc nulls last, name`,
          [extraction.id],
        ),
        pool().query<{
          year: number;
          ceo_compensation_actually_paid: number | null;
          average_neo_compensation_actually_paid: number | null;
          company_tsr_indexed: number | null;
          peer_group_tsr_indexed: number | null;
          gaap_net_income: number | null;
        }>(
          `select year, ceo_compensation_actually_paid, average_neo_compensation_actually_paid,
                  company_tsr_indexed, peer_group_tsr_indexed, gaap_net_income
           from pay_vs_performance
           where extraction_id = $1
           order by year desc`,
          [extraction.id],
        ),
      ])
    : [{ rows: [] as never[] }, { rows: [] as never[] }];

  // Merge: prefer xbrl row, fallback to proxy row per fiscal_year.
  type PvP = {
    fiscal_year: number;
    peo_total_comp: number | null;
    peo_compensation_actually_paid: number | null;
    non_peo_neo_avg_total_comp: number | null;
    non_peo_neo_avg_compensation_actually_paid: number | null;
    company_tsr_indexed: number | null;
    peer_group_tsr_indexed: number | null;
    gaap_net_income: number | null;
  };
  const byYear = new Map<number, PvP>();
  for (const r of xbrl.rows) byYear.set(r.fiscal_year, r);
  for (const r of pvpFallback.rows) {
    if (!byYear.has(r.year)) {
      byYear.set(r.year, {
        fiscal_year: r.year,
        peo_total_comp: null,
        peo_compensation_actually_paid: r.ceo_compensation_actually_paid,
        non_peo_neo_avg_total_comp: null,
        non_peo_neo_avg_compensation_actually_paid: r.average_neo_compensation_actually_paid,
        company_tsr_indexed: r.company_tsr_indexed,
        peer_group_tsr_indexed: r.peer_group_tsr_indexed,
        gaap_net_income: r.gaap_net_income,
      });
    }
  }
  const pvp = Array.from(byYear.values()).sort((a, b) => b.fiscal_year - a.fiscal_year);

  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    summary_compensation: comp.rows,
    pay_vs_performance: pvp,
    source: {
      extracted_at: extraction?.extracted_at ?? null,
      model: extraction?.model ?? null,
      fiscal_year_covered: extraction?.fiscal_year_covered ?? null,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Board — directors + their compensation + ownership.
// All scoped to the latest extraction (one DEF 14A per fiscal year, latest
// covered year wins).
// ─────────────────────────────────────────────────────────────────────────

app.get("/companies/:ticker/board", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const ext = await pool().query<{ id: number; extracted_at: string; fiscal_year_covered: number }>(
    `select pe.id, pe.extracted_at::text, pe.fiscal_year_covered
     from proxy_extractions pe
     join companies cmp on cmp.cik = pe.cik
     where cmp.ticker = $1
     order by pe.fiscal_year_covered desc, pe.extracted_at desc
     limit 1`,
    [ticker],
  );
  if (ext.rows.length === 0) {
    return c.json(
      { directors: [], ownership: [], source: { extracted_at: null, fiscal_year_covered: null } },
      200,
    );
  }
  const extraction = ext.rows[0]!;

  // All three extraction-scoped reads run in parallel.
  const [directors, ownership, relatedParty] = await Promise.all([
    pool().query(
      `select d.name, d.age, d.director_since_year, d.independent, d.is_chair,
              d.is_lead_independent_director, d.committees, d.other_public_boards,
              d.attendance_below_75pct,
              dc.total as total_compensation
       from directors d
       left join director_compensation dc on dc.extraction_id = d.extraction_id and dc.name = d.name
       where d.extraction_id = $1
       order by d.is_chair desc nulls last,
                d.is_lead_independent_director desc nulls last,
                d.name`,
      [extraction.id],
    ),
    pool().query(
      `select name, holder_type, shares, percent_class
       from equity_ownership
       where extraction_id = $1
       order by percent_class desc nulls last, shares desc nulls last`,
      [extraction.id],
    ),
    // Related-party transactions: Item 13 disclosures. Editorially material
    // for conflicts-of-interest stories (director consulting fees, family-
    // owned suppliers, controlling-shareholder real-estate, etc.).
    pool().query(
      `select description, parties, amount_or_terms
       from related_party_transactions
       where extraction_id = $1
       order by description`,
      [extraction.id],
    ),
  ]);

  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    directors: directors.rows,
    ownership: ownership.rows,
    related_party: relatedParty.rows,
    source: {
      extracted_at: extraction.extracted_at,
      fiscal_year_covered: extraction.fiscal_year_covered,
    },
  });
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
// /mismanagement — eight deterministic red-flag checks per R3K issuer.
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

const MISMANAGEMENT_FLAGS = [
  "tsr_under",        // 1. TSR < peer TSR in 3+ of last 5 PvP years
  "pay_through_it",   // 2. Median PEO total comp ≥ $15M AND flag 1
  "active_13d",       // 3. ≥1 active-intent 13D in last 18 months
  "insider_selling",  // 4. Net P-S insider $ < -$10M over 12mo
  "earnings_cash",    // 5. OCF / NI < 0.8 in latest FY (NI > 0)
  "dilutive_sbc",     // 6. SBC > 10% of revenue (latest FY)
  "returns_over_fcf", // 7. (Buybacks + dividends) > OCF (latest FY)
  "goodwill_heavy",   // 8. Goodwill > 40% of total assets
] as const;

app.get("/mismanagement", async (c) => {
  const minMcap = Number(c.req.query("min_mcap") ?? 500e6);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 500);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

  // Reads from the materialized mismanagement_scores table — refreshed
  // out-of-band by refresh-mismanagement.ts. Single-pass index scan, no
  // CTE pipeline at request time.
  const sql = `
    select
      c.cik, c.ticker, c.name, c.sic_description,
      c.market_cap_at_universe_pull as market_cap,
      ms.years_under, ms.years_tracked, ms.peo_median,
      ms.latest_company_tsr, ms.latest_peer_tsr, ms.latest_pvp_year,
      ms.revenue, ms.net_income, ms.ocf, ms.capex, ms.sbc,
      ms.buybacks, ms.dividends_paid,
      ms.total_assets, ms.goodwill,
      ms.insider_net_365d, ms.active_13d_count,
      ms.flag_tsr_under, ms.flag_pay_through_it, ms.flag_active_13d,
      ms.flag_insider_selling, ms.flag_earnings_cash, ms.flag_dilutive_sbc,
      ms.flag_returns_over_fcf, ms.flag_goodwill_heavy,
      count(*) over() as total
    from mismanagement_scores ms
    join companies c on c.cik = ms.cik
    where c.is_russell_3000
      and (c.market_cap_at_universe_pull is null or c.market_cap_at_universe_pull >= $1::float8)
    order by ms.flags_fired desc, ms.tiebreak desc, c.ticker asc
    limit $2 offset $3
  `;

  const r = await pool().query<{
    cik: string; ticker: string; name: string; sic_description: string | null;
    market_cap: number | null;
    years_under: number | null; years_tracked: number | null; peo_median: number | null;
    latest_company_tsr: number | null; latest_peer_tsr: number | null; latest_pvp_year: number | null;
    revenue: number | null; net_income: number | null; ocf: number | null; capex: number | null;
    sbc: number | null; buybacks: number | null; dividends_paid: number | null;
    total_assets: number | null; goodwill: number | null;
    insider_net_365d: number; active_13d_count: number;
    flag_tsr_under: boolean; flag_pay_through_it: boolean; flag_active_13d: boolean;
    flag_insider_selling: boolean; flag_earnings_cash: boolean; flag_dilutive_sbc: boolean;
    flag_returns_over_fcf: boolean; flag_goodwill_heavy: boolean;
    total: string;
  }>(sql, [minMcap, limit, offset]);

  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    count: r.rows.length,
    total: r.rows[0] ? Number(r.rows[0].total) : 0,
    flags: MISMANAGEMENT_FLAGS,
    rows: r.rows.map(({ total: _t, ...rest }) => rest),
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
       ms.flag_returns_over_fcf, ms.flag_goodwill_heavy
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
// Overview + feeds (home page)
// ─────────────────────────────────────────────────────────────────────────

app.get("/overview", async (c) => {
  const r = await pool().query<{
    companies: string;
    russell_3000: string;
    proxy_extractions: string;
    insider_transactions_90d: string;
    thirteen_d_90d: string;
    latest_filing_date: string | null;
  }>(`
    select
      (select count(*) from companies)                                                  as companies,
      (select count(*) from companies where is_russell_3000)                            as russell_3000,
      (select count(*) from proxy_extractions)                                          as proxy_extractions,
      (select count(*) from insider_transactions
         where transaction_date >= current_date - interval '90 days')                   as insider_transactions_90d,
      (select count(*) from thirteen_d_filings
         where filing_date >= current_date - interval '90 days')                        as thirteen_d_90d,
      (select max(filing_date)::text from filings)                                      as latest_filing_date
  `);
  const row = r.rows[0]!;
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    companies: Number(row.companies),
    russell_3000: Number(row.russell_3000),
    proxy_extractions: Number(row.proxy_extractions),
    insider_transactions_90d: Number(row.insider_transactions_90d),
    thirteen_d_90d: Number(row.thirteen_d_90d),
    latest_filing_date: row.latest_filing_date,
  });
});

app.get("/feeds/13d-recent", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 8), 1), 50);
  const r = await pool().query(
    `select t.accession_number, t.form, t.filing_date::text, t.filer_name,
            t.is_active_intent, t.purpose_summary,
            t.cooperation_agreement_present, t.standstill_present,
            t.aggregate_percent, t.group_members,
            c.ticker, c.name as company_name
     from thirteen_d_filings t
     join companies c on c.cik = t.cik
     order by t.filing_date desc
     limit $1`,
    [limit],
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
// /companies/:ticker/sheet — aggregated payload for the editorial fact
// sheet. The frontend renders this as 3–5 computed prose sentences.
//
// Single endpoint (rather than the 6 the fact sheet would otherwise need)
// so the editorial summary lands in one round-trip and the prose can be
// written without async holes.
// ─────────────────────────────────────────────────────────────────────────

app.get("/companies/:ticker/sheet", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const companyR = await pool().query<{ cik: string; name: string }>(
    `select cik, name from companies where ticker = $1`,
    [ticker],
  );
  if (companyR.rows.length === 0) return c.json({ error: "not found" }, 404);
  const { cik } = companyR.rows[0]!;

  // ──────────────────────────────────────────────────────────────────────
  // Two parallel batches. The first resolves the latest extraction and
  // the three queries that don't depend on it; the second runs the
  // extraction-scoped queries once we know the id.
  // ──────────────────────────────────────────────────────────────────────

  type ExtRow = { id: number; fiscal_year_covered: number; extracted_at: string; raw_json: unknown };
  type XbrlRow = {
    fiscal_year: number;
    peo_total_comp: number | null;
    peo_compensation_actually_paid: number | null;
    company_tsr_indexed: number | null;
    peer_group_tsr_indexed: number | null;
  };
  type InsiderFlowRow = { buys_value: string; sells_value: string; buys_count: string; sells_count: string };
  type ThirteenDRow = {
    total: string; active_count: string;
    most_recent_filer: string | null;
    most_recent_pct: number | null;
    most_recent_date: string | null;
  };

  const [extR, xbrl, insiderFlow, thirteenD] = await Promise.all([
    pool().query<ExtRow>(
      `select id, fiscal_year_covered, extracted_at::text, raw_json
       from proxy_extractions where cik = $1
       order by fiscal_year_covered desc, extracted_at desc limit 1`,
      [cik],
    ),
    pool().query<XbrlRow>(
      `select fiscal_year, peo_total_comp, peo_compensation_actually_paid,
              company_tsr_indexed, peer_group_tsr_indexed
       from xbrl_pay_vs_performance where cik = $1
       order by fiscal_year desc limit 1`,
      [cik],
    ),
    pool().query<InsiderFlowRow>(
      `select
         coalesce(sum(transaction_value) filter (where transaction_code in ('P','A')), 0)::text as buys_value,
         coalesce(sum(transaction_value) filter (where transaction_code in ('S','D')), 0)::text as sells_value,
         count(*) filter (where transaction_code in ('P','A'))::text as buys_count,
         count(*) filter (where transaction_code in ('S','D'))::text as sells_count
       from insider_transactions
       where cik = $1 and transaction_date >= current_date - interval '90 days'`,
      [cik],
    ),
    pool().query<ThirteenDRow>(
      `select
         count(*)::text as total,
         count(*) filter (where is_active_intent is true)::text as active_count,
         max(filer_name) filter (where filing_date = (select max(filing_date) from thirteen_d_filings where cik = $1)) as most_recent_filer,
         max(aggregate_percent) filter (where filing_date = (select max(filing_date) from thirteen_d_filings where cik = $1)) as most_recent_pct,
         max(filing_date::text) as most_recent_date
       from thirteen_d_filings where cik = $1`,
      [cik],
    ),
  ]);
  const extraction = extR.rows[0] ?? null;

  // Extraction-scoped batch. When there is no extraction, every query
  // here would short-circuit anyway, so we elide the whole round-trip.
  const [highestPaid, boardSummary, topHolders, rpt] = extraction
    ? await Promise.all([
        pool().query<{ name: string; title: string; fiscal_year: number; total: number }>(
          `select name, title, fiscal_year, total
           from summary_compensation
           where extraction_id = $1 and total is not null
           order by fiscal_year desc, total desc limit 1`,
          [extraction.id],
        ),
        pool().query<{
          total: string; indep: string; not_indep: string; flags: string;
          chair: string | null; lid: string | null;
        }>(
          `select
             count(*)::text as total,
             count(*) filter (where independent is true)::text as indep,
             count(*) filter (where independent is false)::text as not_indep,
             count(*) filter (where attendance_below_75pct is true)::text as flags,
             max(case when is_chair then name end) as chair,
             max(case when is_lead_independent_director then name end) as lid
           from directors where extraction_id = $1`,
          [extraction.id],
        ),
        pool().query(
          // Permissive holder-type match — the Zod normalizer in shared
          // canonicalizes a few variants; the rest pass through as the
          // model emitted them ("5pct_holder", "5%_beneficial_owner", …).
          `select name, holder_type, shares, percent_class
           from equity_ownership
           where extraction_id = $1
             and percent_class is not null
             and percent_class >= 5
             and (
               holder_type like '5%'
               or holder_type like '%5pct%'
               or holder_type like '%beneficial_owner%'
               or holder_type like '%principal%'
               or holder_type = 'group'
             )
           order by percent_class desc limit 5`,
          [extraction.id],
        ),
        pool().query<{ n: string }>(
          `select count(*)::text as n from related_party_transactions where extraction_id = $1`,
          [extraction.id],
        ),
      ])
    : [
        { rows: [] as never[] },
        { rows: [{ total: "0", indep: "0", not_indep: "0", flags: "0", chair: null, lid: null }] },
        { rows: [] as never[] },
        { rows: [{ n: "0" }] },
      ];

  // ── CEO pay ratio (from raw_json)
  let payRatio: { ratio_x_to_1: number | null; ceo_total: number | null; median_employee: number | null; fiscal_year: number | null } | null = null;
  if (extraction?.raw_json && typeof extraction.raw_json === "object") {
    const raw = extraction.raw_json as { ceo_pay_ratio?: Record<string, unknown> };
    const cpr = raw.ceo_pay_ratio;
    if (cpr) {
      payRatio = {
        ratio_x_to_1: numOr(cpr.ratio_x_to_1),
        ceo_total: numOr(cpr.ceo_total_compensation),
        median_employee: numOr(cpr.median_employee_compensation),
        fiscal_year: numOr(cpr.fiscal_year),
      };
    }
  }

  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    ticker,
    company_name: companyR.rows[0]!.name,
    highest_paid: highestPaid.rows[0] ?? null,
    latest_pvp: xbrl.rows[0] ?? null,
    board: {
      total: Number(boardSummary.rows[0]!.total),
      independent: Number(boardSummary.rows[0]!.indep),
      not_independent: Number(boardSummary.rows[0]!.not_indep),
      attendance_flags: Number(boardSummary.rows[0]!.flags),
      chair: boardSummary.rows[0]!.chair,
      lead_independent_director: boardSummary.rows[0]!.lid,
    },
    top_holders: topHolders.rows,
    insider_flow_90d: {
      buys_value: Number(insiderFlow.rows[0]!.buys_value),
      sells_value: Number(insiderFlow.rows[0]!.sells_value),
      net_value: Number(insiderFlow.rows[0]!.buys_value) - Number(insiderFlow.rows[0]!.sells_value),
      buys_count: Number(insiderFlow.rows[0]!.buys_count),
      sells_count: Number(insiderFlow.rows[0]!.sells_count),
    },
    thirteen_d: {
      total: Number(thirteenD.rows[0]!.total),
      active_count: Number(thirteenD.rows[0]!.active_count),
      most_recent_filer: thirteenD.rows[0]!.most_recent_filer,
      most_recent_pct: thirteenD.rows[0]!.most_recent_pct,
      most_recent_date: thirteenD.rows[0]!.most_recent_date,
    },
    related_party_count: Number(rpt.rows[0]!.n),
    ceo_pay_ratio: payRatio,
    source: {
      proxy_fiscal_year: extraction?.fiscal_year_covered ?? null,
      proxy_extracted_at: extraction?.extracted_at ?? null,
    },
  });
});

function numOr(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// /companies/:ticker/peers — resolve peer_group + comparable metrics.
//
// peer_group lives in raw_json as a string array. Resolution order:
//   1. "(TICKER)" suffix in the string → exact ticker match
//   2. Normalized exact name match (lowercase, strip punctuation)
//   3. ILIKE prefix on company name
//   4. Unresolved → returned in `unresolved` list so frontend can show them
// ─────────────────────────────────────────────────────────────────────────

app.get("/companies/:ticker/peers", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const r = await pool().query<{ cik: string; raw_json: { peer_group?: unknown } }>(
    `select pe.cik, pe.raw_json
     from proxy_extractions pe
     join companies cmp on cmp.cik = pe.cik
     where cmp.ticker = $1
     order by pe.fiscal_year_covered desc, pe.extracted_at desc
     limit 1`,
    [ticker],
  );
  if (r.rows.length === 0) {
    return c.json({ subject: null, peers: [], unresolved: [] });
  }
  const cik = r.rows[0]!.cik;
  const peerStrs = Array.isArray(r.rows[0]!.raw_json.peer_group)
    ? (r.rows[0]!.raw_json.peer_group as string[]).map((s) => String(s))
    : [];

  // Resolve every peer string in ONE round-trip instead of the N+1 it
  // used to be. We pre-compute the three candidate keys (ticker hint,
  // normalized name, name prefix) for each peer string, then ask the
  // database for any company matching any of those keys. Local code
  // matches each peer back to a row, preferring ticker > normalized >
  // prefix in that order.
  interface PeerHints {
    original: string;
    tickerHint: string | null;
    normalized: string;
    prefix: string;
  }
  const hints: PeerHints[] = peerStrs.map((peer) => {
    const tickMatch = peer.match(/\(([A-Z][A-Z0-9.\-]{0,6})\)/);
    const normalized = peer
      .replace(/\([^)]*\)/g, "")
      .replace(/[^a-z0-9 ]/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const prefix = normalized.split(" ").slice(0, 2).join(" ");
    return { original: peer, tickerHint: tickMatch?.[1] ?? null, normalized, prefix };
  });

  const tickerKeys = Array.from(new Set(hints.map((h) => h.tickerHint).filter((s): s is string => !!s)));
  const normKeys = Array.from(new Set(hints.map((h) => h.normalized).filter((s) => s.length > 0)));
  const prefixKeys = Array.from(new Set(hints.map((h) => h.prefix).filter((s) => s.length > 0))).map((p) => p + "%");

  type Candidate = { cik: string; ticker: string; name: string; norm: string };
  let candidates: { rows: Candidate[] } = { rows: [] };
  if (tickerKeys.length || normKeys.length || prefixKeys.length) {
    candidates = await pool().query<Candidate>(
      `select cik, ticker, name,
              lower(regexp_replace(name, '[^a-zA-Z0-9 ]', '', 'g')) as norm
       from companies
       where ticker = any($1::text[])
          or lower(regexp_replace(name, '[^a-zA-Z0-9 ]', '', 'g')) = any($2::text[])
          or lower(name) ilike any($3::text[])`,
      [tickerKeys, normKeys, prefixKeys],
    );
  }

  // Build lookup maps.
  const byTicker = new Map<string, Candidate>();
  const byNorm = new Map<string, Candidate>();
  const byPrefix: Candidate[] = candidates.rows;
  for (const row of candidates.rows) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, row);
    if (!byNorm.has(row.norm)) byNorm.set(row.norm, row);
  }

  const resolved: Array<{ cik: string; ticker: string; name: string; matched_as: string }> = [];
  const unresolved: string[] = [];
  const seenCik = new Set<string>();
  for (const h of hints) {
    let hit: Candidate | undefined;
    if (h.tickerHint) hit = byTicker.get(h.tickerHint);
    if (!hit && h.normalized) hit = byNorm.get(h.normalized);
    if (!hit && h.prefix) hit = byPrefix.find((c) => c.name.toLowerCase().startsWith(h.prefix));
    if (hit && !seenCik.has(hit.cik)) {
      seenCik.add(hit.cik);
      resolved.push({ cik: hit.cik, ticker: hit.ticker, name: hit.name, matched_as: h.original });
    } else if (!hit) {
      unresolved.push(h.original);
    }
  }

  // For the subject + each resolved peer, gather comparable metrics.
  const allCiks = [cik, ...resolved.map((p) => p.cik)];
  const metrics = await pool().query<{
    cik: string;
    ticker: string;
    name: string;
    company_tsr_indexed: number | null;
    peer_group_tsr_indexed: number | null;
    tsr_fiscal_year: number | null;
    ceo_total_comp: number | null;
    ceo_name: string | null;
    ceo_fiscal_year: number | null;
    director_count: number | null;
    independent_pct: number | null;
  }>(
    `with latest_pvp as (
       select distinct on (cik) cik, fiscal_year as tsr_fiscal_year,
              company_tsr_indexed, peer_group_tsr_indexed
       from xbrl_pay_vs_performance
       where cik = any($1)
       order by cik, fiscal_year desc
     ),
     latest_ext as (
       select distinct on (cik) cik, id from proxy_extractions
       where cik = any($1)
       order by cik, fiscal_year_covered desc, extracted_at desc
     ),
     ceo_comp as (
       select distinct on (sc.extraction_id)
         le.cik, sc.name as ceo_name, sc.total as ceo_total_comp, sc.fiscal_year as ceo_fiscal_year
       from latest_ext le
       join summary_compensation sc on sc.extraction_id = le.id
       where sc.total is not null
       order by sc.extraction_id, sc.fiscal_year desc, sc.total desc
     ),
     board_stats as (
       select le.cik,
              count(d.*)::int as director_count,
              case when count(d.*) > 0
                   then 100.0 * count(d.*) filter (where d.independent is true) / count(d.*)
                   else null end as independent_pct
       from latest_ext le
       left join directors d on d.extraction_id = le.id
       group by le.cik
     )
     select c.cik, c.ticker, c.name,
            p.company_tsr_indexed, p.peer_group_tsr_indexed, p.tsr_fiscal_year,
            cc.ceo_total_comp, cc.ceo_name, cc.ceo_fiscal_year,
            b.director_count, b.independent_pct
     from companies c
     left join latest_pvp p on p.cik = c.cik
     left join ceo_comp cc on cc.cik = c.cik
     left join board_stats b on b.cik = c.cik
     where c.cik = any($1)`,
    [allCiks],
  );

  const byCik = new Map(metrics.rows.map((m) => [m.cik, m]));
  const subjectRow = byCik.get(cik);
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    subject: subjectRow ?? null,
    peers: resolved
      .map((p) => byCik.get(p.cik))
      .filter(Boolean),
    unresolved,
  });
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

app.get("/feeds/comp-highest", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  const r = await pool().query(
    `with latest_ext as (
       select distinct on (cik) cik, id, fiscal_year_covered
       from proxy_extractions
       order by cik, fiscal_year_covered desc, extracted_at desc
     ),
     top_ceo as (
       select distinct on (le.cik)
         le.cik, le.fiscal_year_covered,
         sc.name as executive_name, sc.title, sc.total, sc.fiscal_year
       from latest_ext le
       join summary_compensation sc on sc.extraction_id = le.id
       where sc.total is not null
       order by le.cik, sc.fiscal_year desc, sc.total desc
     )
     select c.ticker, c.name as company_name, t.executive_name, t.title,
            t.total, t.fiscal_year
     from top_ceo t
     join companies c on c.cik = t.cik
     order by t.total desc
     limit $1`,
    [limit],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, rows: r.rows });
});

app.get("/feeds/comp-pay-gap", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
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

app.get("/feeds/comp-pay-ratio", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  // ceo_pay_ratio lives in raw_json; query via jsonb. Some extractions
  // have it, some don't. ratio_x_to_1 is the "CEO comp ÷ median employee
  // comp" multiple disclosed under Dodd-Frank Section 953(b).
  const r = await pool().query<{
    ticker: string; company_name: string; fiscal_year_covered: number;
    ratio_x_to_1: number; ceo_total: number | null; median_employee: number | null;
  }>(
    `with latest_ext as (
       select distinct on (cik) cik, id, fiscal_year_covered, raw_json
       from proxy_extractions
       order by cik, fiscal_year_covered desc, extracted_at desc
     )
     select c.ticker, c.name as company_name, le.fiscal_year_covered,
            (le.raw_json->'ceo_pay_ratio'->>'ratio_x_to_1')::double precision as ratio_x_to_1,
            (le.raw_json->'ceo_pay_ratio'->>'ceo_total_compensation')::double precision as ceo_total,
            (le.raw_json->'ceo_pay_ratio'->>'median_employee_compensation')::double precision as median_employee
     from latest_ext le
     join companies c on c.cik = le.cik
     where le.raw_json->'ceo_pay_ratio'->>'ratio_x_to_1' is not null
     order by ratio_x_to_1 desc nulls last
     limit $1`,
    [limit],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ count: r.rows.length, rows: r.rows });
});
