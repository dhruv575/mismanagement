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

app.get("/health", (c) => c.json({ ok: true, service: "takeover-api" }));

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
    // Ticker prefix first, then name, then industry; scored companies only.
    `select cik, ticker, name, sic_description
     from companies
     where is_russell_3000 and ticker is not null
       and (ticker ilike $1 || '%' or name ilike '%' || $1 || '%' or sic_description ilike '%' || $1 || '%')
     order by case when upper(ticker) = upper($1) then 0
                   when ticker ilike $1 || '%' then 1
                   when name ilike $1 || '%' then 2
                   when name ilike '%' || $1 || '%' then 3
                   else 4 end,
              market_cap_at_universe_pull desc nulls last
     limit 8`,
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
     where c.ticker = $1 and not t.is_self_filed
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
      where tt.cik = c.cik and not tt.is_self_filed and tt.filing_date >= current_date - interval '180 days'
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
        where t.cik = c.cik and not t.is_self_filed
          and t.filing_date >= current_date - interval '180 days'
      ) as has_recent_13d,
      exists (
        select 1 from thirteen_d_filings t
        where t.cik = c.cik
          and t.is_active_intent = true and not t.is_self_filed
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
// Takeover score — thirteen deterministic yes/no checks per R3K issuer.
// ─────────────────────────────────────────────────────────────────────────
// The score is the count of checks that fire. NULL inputs never fire a
// check, so missing data doesn't count against an issuer. Each row
// carries the supporting values so readers can see the number behind
// every check; there is no opaque weighting.
//
// Thresholds sit where a signal is hard to explain away in a single year
// (e.g. > $10M net insider selling, not > $1M). They are not statistical
// cutoffs.

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
    pool().query(`select ts.*, ${SCORE_SQL} as takeover_score,
        coalesce(ss.signal_recurring_revenue, false) as signal_recurring_revenue, coalesce(ss.signal_rollup_shape, false) as signal_rollup_shape,
        ss.probability as sponsor_prob, ss.multiple as sponsor_multiple,
      exists (select 1 from deal_filings d join deal_class dc using (accession_number)
               where d.cik = ts.cik and dc.issuer_acquired and not d.is_self_filed
                 and d.filing_date > now() - interval '12 months') as deal_pending, ss.percentile as sponsor_percentile,
        cb.services_share, cb.labor_intensity, cb.ai_automatable, cb.fragmented_market, cb.recurring_revenue, cb.rollup_fit,
        cb.summary as business_summary, cb.filing_date::text as business_filing_date, cb.accession_number as business_accession
      from takeover_scores ts left join sponsor_scores ss using (cik) left join current_business cb using (cik) where ts.cik = $1`, [cik]),
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
      `select d.accession_number, d.form, d.filing_date::text as filing_date,
              coalesce(rb.name, case when dc.issuer_acquired then dc.buyer end, d.acquirer) as acquirer, null::text as matched_buyer,
              d.price_per_share, d.premium_pct, d.document_url
         from deal_filings d
         left join deal_class dc on dc.accession_number = d.accession_number
         left join rollup_buyers rb on rb.slug = d.rollup_buyer
        where d.cik = $1 and not d.is_self_filed and dc.issuer_acquired is not false and (d.form <> '8-K' or dc.issuer_acquired)
        order by d.filing_date desc limit 20`,
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
         from thirteen_d_filings where cik = $1 and not is_self_filed order by filing_date desc limit 10`,
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
    groups: SIGNAL_GROUPS,
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
  // ?year=YYYY narrows to one filing year; the history runs back to 2017.
  const year = Number(c.req.query("year")) || null;
  const r = await pool().query(
    `select d.accession_number, c.ticker, c.name, d.form, d.filing_date::text as filing_date,
            coalesce(rb.name, case when dc.issuer_acquired then dc.buyer end, d.acquirer) as acquirer,
            null::text as matched_buyer, d.price_per_share, d.premium_pct, d.document_url,
            pre.pre_score, coalesce(c.is_russell_3000, false) as in_universe,
            dc.buyer_type, dc.target_business, dc.rollup_fit as deal_rollup_fit, rb.name as rollup_buyer
       from deal_filings d join companies c on c.cik = d.cik
       left join deal_class dc on dc.accession_number = d.accession_number
       left join rollup_buyers rb on rb.slug = d.rollup_buyer
       left join lateral (
         select p.score as pre_score from backtest_panel p
          where p.cik = d.cik and p.as_of < d.filing_date and p.as_of >= d.filing_date - interval '15 months'
          order by p.as_of desc limit 1) pre on true
      where not d.is_self_filed and dc.issuer_acquired is not false
        and (d.form <> '8-K' or dc.issuer_acquired)
        and ($1::int is null or extract(year from d.filing_date) = $1::int)
      order by d.filing_date desc
      limit 2000`,
    [year],
  );
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    rows: (r.rows as { acquirer: string | null; matched_buyer: string | null }[]).map((d) => {
      const buyer = d.acquirer ?? d.matched_buyer;
      return { ...d, acquirer_slug: buyer ? acquirerSlug(buyer) || null : null };
    }),
  });
});

// /acquirers — deal filings grouped by buyer. Names are free text from
// filing headers and proxies, so "MACKENZIE CAPITAL MANAGEMENT, LP" and
// "MacKenzie Capital Management LP" group on a slug with legal suffixes
// stripped. 8-Ks found by full-text search count under matched_buyer.
const LEGAL_SUFFIX = new Set([
  "inc", "incorporated", "llc", "lp", "llp", "ltd", "limited", "corp", "corporation", "co", "company",
  "plc", "sa", "sas", "ag", "nv", "bv", "gmbh", "kg", "the", "si",
]);
export function acquirerSlug(name: string): string {
  const words = name.toLowerCase().replace(/&/g, " and ").replace(/\b(\w)\.(?=\w\.)/g, "$1")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  while (words.length > 1 && LEGAL_SUFFIX.has(words[words.length - 1]!)) words.pop();
  if (words[0] === "the" && words.length > 1) words.shift();
  return words.join("-");
}

interface AcqDeal {
  accession_number: string; ticker: string; name: string; form: string; filing_date: string;
  buyer: string; ai_rollup: boolean; mention: boolean; price_per_share: number | null; premium_pct: number | null;
  document_url: string; takeover_score: number | null; pre_score: number | null;
}

async function acquirerDeals(): Promise<Map<string, { name: string; deals: AcqDeal[] }>> {
  const r = await pool().query<AcqDeal>(
    `select d.accession_number, c.ticker, c.name, d.form, d.filing_date::text as filing_date,
            coalesce(rb.name, case when dc.issuer_acquired then dc.buyer end, d.acquirer) as buyer,
            (d.rollup_buyer is not null) as ai_rollup,
            false as mention,
            d.price_per_share, d.premium_pct, d.document_url, s.takeover_score, pre.pre_score
       from deal_filings d
       join companies c on c.cik = d.cik
       left join takeover_scores s on s.cik = d.cik
       left join deal_class dc on dc.accession_number = d.accession_number
       left join rollup_buyers rb on rb.slug = d.rollup_buyer
       left join lateral (
         select p.score as pre_score from backtest_panel p
          where p.cik = d.cik and p.as_of < d.filing_date and p.as_of >= d.filing_date - interval '15 months'
          order by p.as_of desc limit 1) pre on true
      where not d.is_self_filed and dc.issuer_acquired is not false
        and coalesce(rb.name, case when dc.issuer_acquired then dc.buyer end, d.acquirer) is not null
        and (d.form <> '8-K' or dc.issuer_acquired)
      order by d.filing_date desc`,
  );
  const groups = new Map<string, { names: Map<string, number>; deals: AcqDeal[] }>();
  type G = { names: Map<string, number>; deals: AcqDeal[] };
  for (const d of r.rows) {
    const slug = acquirerSlug(d.buyer);
    if (!slug) continue;
    const g: G = groups.get(slug) ?? { names: new Map(), deals: [] };
    g.names.set(d.buyer, (g.names.get(d.buyer) ?? 0) + 1);
    g.deals.push(d);
    groups.set(slug, g);
  }
  // Display the most frequent spelling, preferring mixed case over ALL CAPS.
  const out = new Map<string, { name: string; deals: AcqDeal[] }>();
  for (const [slug, g] of groups) {
    const name = [...g.names].sort((a, b) =>
      Number(a[0] === a[0].toUpperCase()) - Number(b[0] === b[0].toUpperCase()) || b[1] - a[1])[0]![0];
    out.set(slug, { name, deals: g.deals });
  }
  return out;
}

// /rollups — AI-rollup and holdco acquisitions: private deals extracted from
// news headlines (track-news.ts, rollup_deals) and public take-privates from
// SEC filings (track-deals.ts, deal_filings.rollup_buyer), plus the buyer
// registry with counts.
app.get("/rollups", async (c) => {
  const [buyers, news, dups, sec] = await Promise.all([
    pool().query<Record<string, any>>(`select slug, name, kind, note from rollup_buyers order by name`),
    pool().query<Record<string, any>>(`select id, buyer, buyer_slug, target, target_sector, announced::text as announced, sources
                    from rollup_deals where confidence >= 0.6 and duplicate_of is null order by announced desc, created_at desc limit 500`),
    pool().query<Record<string, any>>(`select duplicate_of, sources from rollup_deals where duplicate_of is not null`),
    pool().query<Record<string, any>>(`select distinct on (d.cik) d.cik, c.ticker, c.name as target, rb.slug as buyer_slug, rb.name as buyer,
                         dc.target_business as target_sector, d.filing_date::text as announced, d.document_url, d.form
                    from deal_filings d join companies c using (cik) join rollup_buyers rb on rb.slug = d.rollup_buyer
                    left join deal_class dc on dc.accession_number = d.accession_number
                   order by d.cik, d.filing_date`),
  ]).catch(() => [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }] as { rows: Record<string, any>[] }[]);
  // Folded duplicates contribute their news links to the row they point at.
  const extra = new Map<string, Record<string, any>[]>();
  for (const d of dups.rows) extra.set(d.duplicate_of, [...(extra.get(d.duplicate_of) ?? []), ...d.sources]);
  // One feed, newest first. A public deal also reported in the news keeps
  // its SEC row (which links the filing) and drops the news duplicate.
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(inc|corp|holdings|group|ltd|llc)$/g, "");
  const secKeys = new Set(sec.rows.map((r) => `${r.buyer_slug}:${norm(r.target).slice(0, 8)}`));
  const deals: Record<string, any>[] = [
    ...sec.rows.map((r) => ({ ...r, kind: "public" as const,
      sources: [{ title: `${r.form} filing`, outlet: "SEC EDGAR", url: r.document_url }, ...(extra.get(`public:${r.cik}`) ?? [])] })),
    ...news.rows.filter((r) => !secKeys.has(`${r.buyer_slug}:${norm(r.target).slice(0, 8)}`))
      .map((r) => ({ ...r, kind: "private" as const, sources: [...r.sources, ...(extra.get(r.id) ?? [])] })),
  ].sort((a: Record<string, any>, b: Record<string, any>) => String(b.announced).localeCompare(String(a.announced)));
  const counts = new Map<string, { deals: number; latest: string | null }>();
  for (const d of deals) {
    const k = counts.get(d.buyer_slug) ?? { deals: 0, latest: null };
    k.deals++; if (!k.latest || d.announced > k.latest) k.latest = d.announced;
    counts.set(d.buyer_slug, k);
  }
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    buyers: buyers.rows.map((b) => ({ ...b, ...(counts.get(b.slug) ?? { deals: 0, latest: null }) }))
      .sort((a, b) => b.deals - a.deals || String(b.latest).localeCompare(String(a.latest))),
    deals,
  });
});

// /scorecard — the AI-rollup model's record on deals announced since 2025
// (rollup_scorecard, written by track-deals.ts when a deal first appears).
app.get("/scorecard", async (c) => {
  const r = await pool().query(
    `select c.ticker, c.name, k.announced::text as announced, k.buyer, k.buyer_type, rb.name as rollup_buyer,
            k.services_business, k.probability, k.multiple, k.percentile, k.inputs_before, k.in_training
       from rollup_scorecard k join companies c using (cik) left join rollup_buyers rb on rb.slug = k.rollup_buyer
      where k.percentile is not null
      order by k.announced desc`,
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ rows: r.rows });
});

app.get("/acquirers", async (c) => {
  const groups = await acquirerDeals();
  const rows = [...groups].map(([slug, g]) => {
    const targets = new Map(g.deals.map((d) => [d.ticker, d.name]));
    const prem = g.deals.map((d) => d.premium_pct).filter((v): v is number => v != null);
    return {
      slug, name: g.name,
      filings: g.deals.length,
      targets: [...targets].map(([ticker, name]) => ({ ticker, name })),
      latest: g.deals[0]!.filing_date,
      ai_rollup: g.deals.some((d) => d.ai_rollup),
      median_premium: prem.length ? Math.round(prem.sort((a, b) => a - b)[Math.floor(prem.length / 2)]!) : null,
    };
  });
  rows.sort((a, b) => b.targets.length - a.targets.length || b.latest.localeCompare(a.latest));
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({ rows });
});

app.get("/acquirers/:slug", async (c) => {
  const slug = c.req.param("slug").toLowerCase();
  const g = (await acquirerDeals()).get(slug);
  if (!g) return c.json({ error: "not found" }, 404);
  // Deals are newest first, so the last one seen per target is its first
  // filing and carries the score from before the deal.
  const targets = new Map<string, { ticker: string; name: string; takeover_score: number | null; pre_score: number | null; filings: number; first: string; last: string }>();
  for (const d of g.deals) {
    const t = targets.get(d.ticker);
    if (t) { t.filings++; t.first = d.filing_date; t.pre_score = d.pre_score ?? t.pre_score; }
    else targets.set(d.ticker, { ticker: d.ticker, name: d.name, takeover_score: d.takeover_score, pre_score: d.pre_score, filings: 1, first: d.filing_date, last: d.filing_date });
  }
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    slug, name: g.name,
    ai_rollup: g.deals.some((d) => d.ai_rollup),
    aliases: [...new Set(g.deals.map((d) => d.buyer))],
    targets: [...targets.values()],
    deals: g.deals,
  });
});

// /backtest — how the signals did before past deals, from backtest_panel
// (build-backtest.ts): each company as of April 1, labeled by whether a
// deal filing followed within 12 months. Lift = deal rate when the signal
// fired / deal rate overall.
const BACKTEST_SIGNALS = [
  "flag_earnings_cash", "flag_dilutive_sbc", "flag_returns_over_fcf", "flag_goodwill_heavy",
  "signal_debt_capacity", "signal_size_fit", "flag_active_13d",
] as const;
const BACKTEST_UNTESTED = [
  { key: "flag_tsr_under", why: "Pay-versus-performance tables start with fiscal 2022" },
  { key: "flag_pay_through_it", why: "Pay-versus-performance tables start with fiscal 2022" },
  { key: "flag_governance_dissent", why: "Vote results are kept for two years" },
  { key: "flag_insider_selling", why: "Form 4s are kept for two years" },
  { key: "signal_low_productivity", why: "Headcount is read from current 10-Ks only" },
  { key: "signal_ai_quiet", why: "10-K text is read for current companies only" },
];

app.get("/backtest", async (c) => {
  const totals = await pool().query<Record<string, number>>(
    `select count(*)::int n, coalesce(sum(target::int), 0)::int deals,
            min(cohort_year)::int first_cohort, max(cohort_year)::int last_cohort,
            ${BACKTEST_SIGNALS.map((s) => `sum(${s}::int)::int ${s}_n, sum((${s} and target)::int)::int ${s}_d`).join(", ")}
       from backtest_panel`,
  );
  const t = totals.rows[0]!;
  const base = t.n && t.deals ? t.deals / t.n : 0;
  const signals = BACKTEST_SIGNALS.map((key) => {
    const fired = t[`${key}_n`] ?? 0, deals = t[`${key}_d`] ?? 0;
    return { key, fired, deals, deal_rate: fired ? deals / fired : null, lift: fired && base ? deals / fired / base : null };
  });
  const buckets = await pool().query(
    `select score::int, count(*)::int n, sum(target::int)::int deals from backtest_panel group by 1 order by 1`,
  );
  const cohorts = await pool().query(
    `select cohort_year::int, as_of::text, count(*)::int n, sum(target::int)::int deals from backtest_panel group by 1, 2 order by 1`,
  );
  // Text signals come from a weighted sample (pull-backtest-text.ts): every
  // target plus random controls, each control standing for `weight` rows.
  const text = await pool().query<Record<string, number>>(
    `select count(*) filter (where word_count > 0)::int read,
            ${["signal_ai_quiet", "signal_low_productivity"].map((s) =>
              `sum(weight * ${s}::int)::float ${s}_n, sum((${s} and target)::int)::int ${s}_d, count(*) filter (where ${s})::int ${s}_k`).join(", ")}
       from backtest_text where word_count > 0`,
  );
  const x = text.rows[0];
  const sampled = x?.read ? (["signal_ai_quiet", "signal_low_productivity"] as const).map((key) => {
    const fired = x[`${key}_n`] ?? 0, deals = x[`${key}_d`] ?? 0;
    return { key, fired: Math.round(fired), deals, sampled: true, sample_fired: x[`${key}_k`] ?? 0,
      deal_rate: fired ? deals / fired : null, lift: fired && base ? deals / fired / base : null };
  }) : [];
  c.header("Cache-Control", STABLE_CACHE);
  return c.json({
    company_years: t.n, deals: t.deals, base_rate: base, text_sample: x?.read ?? 0,
    first_cohort: t.first_cohort, last_cohort: t.last_cohort, max_score: BACKTEST_SIGNALS.length,
    signals: [...signals, ...sampled].sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0)),
    untested: BACKTEST_UNTESTED.filter((u) => !sampled.some((v) => v.key === u.key)),
    sponsor: await sponsorMeta(),
    scores: buckets.rows, cohorts: cohorts.rows,
  });
});

// Every check is a yes/no column on takeover_scores and counts one toward
// takeover_score. Grouped by why it makes a company a target.
const SIGNAL_GROUPS = [
  {
    key: "underperformance",
    label: "Fixable underperformance",
    signals: [
      "flag_tsr_under",         // TSR < peer TSR in 3+ of last 5 PvP years
      "flag_pay_through_it",    // Median PEO total comp ≥ $15M while TSR trails
      "flag_earnings_cash",     // OCF / NI < 0.8 in latest FY (NI > 0)
      "flag_dilutive_sbc",      // SBC > 10% of revenue (latest FY)
      "flag_returns_over_fcf",  // Buybacks + dividends > OCF (latest FY)
      "flag_goodwill_heavy",    // Goodwill > 40% of total assets
      "flag_governance_dissent", // Latest say-on-pay or any director < 80% support
    ],
  },
  {
    key: "economics",
    label: "Buyer economics",
    signals: [
      "signal_low_productivity", // Revenue/employee in bottom quartile of 2-digit SIC (8+ peers)
      "signal_ai_quiet",         // AI mentions per 10K words in bottom quartile
      "signal_debt_capacity",    // EBITDA > 0 and net cash
      "signal_size_fit",         // Market cap $500M–$5B
      "signal_recurring_revenue", // 10-K business: recurring revenue scored 7+ of 10 (sponsor_scores)
      "signal_rollup_shape",      // 10-K business: AI-rollup fit scored 5+ of 10 (sponsor_scores)
    ],
  },
  {
    key: "catalysts",
    label: "Catalysts",
    signals: [
      "flag_active_13d",       // Active-intent 13D in last 18 months
      "flag_insider_selling",  // Net insider sales over $10M in 12 months
    ],
  },
] as const;
const SIGNAL_COUNT = SIGNAL_GROUPS.reduce((n, g) => n + g.signals.length, 0);
// Signals computed by sponsor-model.ts (sponsor_scores) rather than refresh-scores.
const SPONSOR_SIGNALS = new Set<string>(["signal_recurring_revenue", "signal_rollup_shape"]);
const signalSql = (s: string) => (SPONSOR_SIGNALS.has(s) ? `coalesce(ss.${s}, false) as ${s}` : `ts.${s}`);
const SCORE_SQL = `(ts.takeover_score + coalesce(ss.signal_recurring_revenue::int, 0) + coalesce(ss.signal_rollup_shape::int, 0))`;

// The fitted sponsor model's headline numbers, for page copy.
async function sponsorMeta(): Promise<{ base_rate: number; positives: number; rows: number } | null> {
  const r = await pool().query<{ metrics: { base_rate: number; positives: number; rows: number } }>(
    `select metrics from takeover_model where id = 'sponsor'`).catch(() => ({ rows: [] as { metrics: { base_rate: number; positives: number; rows: number } }[] }));
  return r.rows[0]?.metrics ?? null;
}

// Russell 3000 companies by AI-rollup likelihood band, for the home chart.
const BANDS: [string, number, number][] = [
  ["<0.5×", 0, 0.5], ["0.5–1×", 0.5, 1], ["1–2×", 1, 2], ["2–3×", 2, 3], ["3–5×", 3, 5], ["5–10×", 5, 10], ["10×+", 10, Infinity],
];
async function likelihoodBands(minMcap: number): Promise<{ label: string; min: number; count: number }[]> {
  const r = await pool().query<{ multiple: number }>(
    `select ss.multiple from sponsor_scores ss join companies c using (cik)
      where c.is_russell_3000 and (c.market_cap_at_universe_pull is null or c.market_cap_at_universe_pull >= $1::float8)`, [minMcap],
  ).catch(() => ({ rows: [] as { multiple: number }[] }));
  return BANDS.map(([label, lo, hi]) => ({ label, min: lo, count: r.rows.filter((x) => x.multiple >= lo && x.multiple < hi).length }));
}

app.get("/leaderboard", async (c) => {
  const minMcap = Number(c.req.query("min_mcap") ?? 500e6);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 3000);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  // Default order is the sponsor-buyout model; ?sort=score orders by signal count.
  const sort = c.req.query("sort") === "score" ? "score" : "sponsor";

  // Reads the materialized takeover_scores table (refresh-scores.ts). The
  // select list is what the leaderboard row shows: identity, size, score
  // and each signal for the dot strip.
  const sql = `
    select
      c.cik, c.ticker, c.name, c.sic_description,
      c.market_cap_at_universe_pull as market_cap,
      ${SCORE_SQL} as takeover_score,
      ss.probability as sponsor_prob, ss.multiple as sponsor_multiple,
      exists (select 1 from deal_filings d join deal_class dc using (accession_number)
               where d.cik = ts.cik and dc.issuer_acquired and not d.is_self_filed
                 and d.filing_date > now() - interval '12 months') as deal_pending,
      ${SIGNAL_GROUPS.flatMap((g) => g.signals.map(signalSql)).join(", ")},
      count(*) over() as total
    from takeover_scores ts
    join companies c on c.cik = ts.cik
    left join sponsor_scores ss on ss.cik = ts.cik
    where c.is_russell_3000
      and (c.market_cap_at_universe_pull is null or c.market_cap_at_universe_pull >= $1::float8)
    order by ${sort === "score" ? `${SCORE_SQL} desc, ss.probability desc nulls last` : `ss.probability desc nulls last, ${SCORE_SQL} desc`}, ts.tiebreak desc, c.ticker asc
    limit $2 offset $3
  `;

  const [r, dist] = await Promise.all([
    pool().query<Record<string, unknown> & { total: string }>(sql, [minMcap, limit, offset]),
    // Score histogram + freshness for the leaderboard summary.
    pool().query<{ score: number; n: string; refreshed_at: string; sponsor_3x: string }>(
      `select ${SCORE_SQL} as score, count(*)::text as n, max(ts.refreshed_at)::text as refreshed_at,
              count(*) filter (where ss.multiple >= 3)::text as sponsor_3x
         from takeover_scores ts join companies c on c.cik = ts.cik left join sponsor_scores ss on ss.cik = ts.cik
        where c.is_russell_3000
          and (c.market_cap_at_universe_pull is null or c.market_cap_at_universe_pull >= $1::float8)
        group by 1 order by 1`,
      [minMcap],
    ),
  ]);

  // Drop null and false fields per row: on 2.5K rows the repeated
  // ",field:null" is hundreds of KB before gzip. The client treats missing
  // as null/false.
  const slim: Record<string, unknown>[] = [];
  for (const row of r.rows) {
    const out: Record<string, unknown> = {};
    for (const k in row) {
      if (k === "total") continue;
      const v = row[k];
      if (v != null && v !== false) out[k] = v;
    }
    slim.push(out);
  }

  // Refreshed out of band; serve aggressively and let the CDN keep it warm.
  c.header("Cache-Control", "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800");
  return c.json({
    count: r.rows.length,
    total: r.rows[0] ? Number(r.rows[0].total) : 0,
    groups: SIGNAL_GROUPS,
    max_score: SIGNAL_COUNT,
    distribution: dist.rows.map((d) => ({ score: Number(d.score), count: Number(d.n) })),
    sponsor_3x: dist.rows.reduce((a, d) => a + Number(d.sponsor_3x), 0),
    likelihood: await likelihoodBands(minMcap),
    sponsor: await sponsorMeta(),
    refreshed_at: dist.rows.reduce<string | null>((m, d) => (m && m > d.refreshed_at ? m : d.refreshed_at), null),
    rows: slim,
  });
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
     where not t.is_self_filed and t.filing_date >= current_date - ($2::int || ' days')::interval
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
       where t.filer_name is not null and not t.is_self_filed
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
