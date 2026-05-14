// Creates the database schema. Idempotent.
//
// Two layers:
//   1. Source-of-truth tables -- companies, filings, financial_metrics,
//      price_history, proxy_extractions. Everything we pulled from EDGAR /
//      Yahoo / OpenRouter, stored verbatim.
//   2. Normalized facts pulled out of proxy_extractions for query performance:
//      summary_compensation, all_other_compensation, pay_vs_performance,
//      directors, equity_ownership, related_party_transactions,
//      compensation_consultants. Backfilled by extract-proxy.ts after each VLM call.
//
// We deliberately do NOT create a `red_flags` or `governance_signals` table.
// The screening UI computes comparisons (e.g. company_tsr vs peer_tsr) at
// query time and shows the numbers; characterization is left to the reader.

import { pool } from "./db.js";

const statements = [
  // Issuers we screen. CIK is canonical; ticker is for human-readable joins.
  `create table if not exists companies (
    cik text primary key,
    ticker text not null,
    name text not null,
    sic_description text,
    fiscal_year_end text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create unique index if not exists companies_ticker_idx on companies (ticker)`,

  // Every SEC filing we know about. Populated by pull-edgar.ts from the
  // submissions JSON. We only persist filings, not their bodies -- the body
  // for a DEF 14A goes into proxy_extractions when extracted.
  `create table if not exists filings (
    accession_number text primary key,
    cik text not null references companies(cik) on delete cascade,
    form text not null,
    filing_date date not null,
    primary_document text,
    primary_doc_url text,
    fiscal_period text,
    fiscal_year smallint
  )`,
  `create index if not exists filings_cik_form_idx on filings (cik, form, filing_date desc)`,
  `create index if not exists filings_form_date_idx on filings (form, filing_date desc)`,

  // EDGAR submissions JSON exposes per-filing 8-K Item codes (e.g. "5.07" for
  // shareholder vote results). Capturing them on the filings row lets the
  // vote extractor filter to ~1 filing/year/issuer without re-fetching doc
  // bodies. Empty array (not null) when the source feed didn't supply items.
  `alter table filings add column if not exists items text[]`,
  `create index if not exists filings_items_idx on filings using gin (items)`,

  // Long-form financial metrics keyed by US-GAAP concept. One row per
  // (cik, fiscal_year, concept) with the company's reported value. We store
  // every concept we pull (revenue, opex breakdown, SBC, buybacks, etc.) so
  // the screen can be re-run with new ratios without re-fetching EDGAR.
  //
  // The `frame` column captures whether the value came from EDGAR's canonical
  // frame (axis-less consolidated) vs a dimensional sub-total. Critical to
  // avoid the eBay-style bug where Revenues includes only continuing-ops sub-
  // segments after a divestiture.
  `create table if not exists financial_metrics (
    cik text not null references companies(cik) on delete cascade,
    fiscal_year smallint not null,
    concept text not null,
    value double precision not null,
    unit text not null,
    frame text,
    accession_number text,
    primary key (cik, fiscal_year, concept)
  )`,
  `create index if not exists financial_metrics_concept_idx on financial_metrics (concept, fiscal_year)`,

  // Daily adjusted close. Yahoo Finance is the source. Adjusted = total return
  // (dividends + splits folded in) so this column is the right input for TSR.
  `create table if not exists price_history (
    ticker text not null,
    trading_date date not null,
    adj_close double precision not null,
    primary key (ticker, trading_date)
  )`,

  // Raw proxy extraction JSON, one row per (filing, extraction run). Keeping
  // history lets us re-run with a newer model and diff. The `_meta` block
  // from the VLM is folded into the dedicated columns.
  `create table if not exists proxy_extractions (
    id bigserial primary key,
    accession_number text not null references filings(accession_number) on delete cascade,
    cik text not null,
    fiscal_year_covered smallint not null,
    model text not null,
    extracted_at timestamptz not null default now(),
    raw_json jsonb not null,
    prompt_tokens int,
    completion_tokens int
  )`,
  `create index if not exists proxy_extractions_accn_idx on proxy_extractions (accession_number, extracted_at desc)`,
  `create unique index if not exists proxy_extractions_cik_fy_uq on proxy_extractions (cik, fiscal_year_covered)`,

  // Normalized fact tables. One row per fact per extraction. They're
  // truncated and rebuilt for an issuer each time we re-extract its proxy,
  // so the surface table is always consistent with the latest extraction.
  `create table if not exists summary_compensation (
    extraction_id bigint not null references proxy_extractions(id) on delete cascade,
    name text not null,
    title text not null,
    fiscal_year smallint not null,
    salary double precision,
    bonus double precision,
    stock_awards double precision,
    option_awards double precision,
    non_equity_incentive double precision,
    change_in_pension double precision,
    all_other_compensation double precision,
    total double precision,
    primary key (extraction_id, name, fiscal_year)
  )`,

  `create table if not exists all_other_compensation (
    extraction_id bigint not null references proxy_extractions(id) on delete cascade,
    name text not null,
    fiscal_year smallint not null,
    category text not null,
    amount double precision,
    description text
  )`,
  `create index if not exists all_other_comp_extr_idx on all_other_compensation (extraction_id)`,

  `create table if not exists pay_vs_performance (
    extraction_id bigint not null references proxy_extractions(id) on delete cascade,
    year smallint not null,
    ceo_compensation_actually_paid double precision,
    average_neo_compensation_actually_paid double precision,
    company_tsr_indexed double precision,
    peer_group_tsr_indexed double precision,
    gaap_net_income double precision,
    company_selected_measure_name text,
    company_selected_measure_value double precision,
    primary key (extraction_id, year)
  )`,

  `create table if not exists directors (
    extraction_id bigint not null references proxy_extractions(id) on delete cascade,
    name text not null,
    age smallint,
    director_since_year smallint,
    independent boolean,
    is_chair boolean,
    is_lead_independent_director boolean,
    committees text[],
    other_public_boards text[],
    attendance_below_75pct boolean,
    primary key (extraction_id, name)
  )`,

  `create table if not exists director_compensation (
    extraction_id bigint not null references proxy_extractions(id) on delete cascade,
    name text not null,
    fees_earned_or_paid_in_cash double precision,
    stock_awards double precision,
    option_awards double precision,
    non_equity_incentive double precision,
    all_other_compensation double precision,
    total double precision,
    primary key (extraction_id, name)
  )`,

  `create table if not exists equity_ownership (
    extraction_id bigint not null references proxy_extractions(id) on delete cascade,
    name text not null,
    holder_type text not null,
    shares double precision,
    percent_class double precision,
    primary key (extraction_id, name, holder_type)
  )`,

  `create table if not exists related_party_transactions (
    extraction_id bigint not null references proxy_extractions(id) on delete cascade,
    description text not null,
    parties text[],
    amount_or_terms text
  )`,

  `create table if not exists compensation_consultants (
    extraction_id bigint not null references proxy_extractions(id) on delete cascade,
    name text not null,
    scope text,
    fees_paid double precision
  )`,

  // Deterministic Pay-vs-Performance facts pulled from companyfacts JSON
  // (ecd: namespace). One row per (cik, fiscal_year). Authoritative -- the
  // LLM-sourced pay_vs_performance table is a fallback for filers whose
  // proxies haven't tagged the table yet.
  //
  // Concepts mapped:
  //   ecd:PeoTotalCompAmt                       -> peo_total_comp
  //   ecd:PeoActuallyPaidCompAmt                -> peo_compensation_actually_paid
  //   ecd:NonPeoNeoAvgTotalCompAmt              -> non_peo_neo_avg_total_comp
  //   ecd:NonPeoNeoAvgCompActuallyPaidAmt       -> non_peo_neo_avg_compensation_actually_paid
  //   ecd:TotalShareholderRtnAmt                -> company_tsr_indexed
  //   ecd:PeerGroupTotalShareholderRtnAmt       -> peer_group_tsr_indexed
  //   ecd:CoSelectedMeasureAmt                  -> company_selected_measure_value
  //   us-gaap:NetIncomeLoss (matched by period) -> gaap_net_income
  `create table if not exists xbrl_pay_vs_performance (
    cik text not null references companies(cik) on delete cascade,
    fiscal_year smallint not null,
    peo_total_comp double precision,
    peo_compensation_actually_paid double precision,
    non_peo_neo_avg_total_comp double precision,
    non_peo_neo_avg_compensation_actually_paid double precision,
    company_tsr_indexed double precision,
    peer_group_tsr_indexed double precision,
    company_selected_measure_name text,
    company_selected_measure_value double precision,
    gaap_net_income double precision,
    accession_number text,
    pulled_at timestamptz not null default now(),
    primary key (cik, fiscal_year)
  )`,

  // Russell 3000 membership flag, populated by pull-universe.ts.
  `alter table companies add column if not exists is_russell_3000 boolean not null default false`,
  `alter table companies add column if not exists market_cap_at_universe_pull double precision`,
  `alter table companies add column if not exists universe_pulled_at timestamptz`,
  `create index if not exists companies_r3k_idx on companies (is_russell_3000) where is_russell_3000`,

  // Form 4 insider transactions. One row per (accession, transaction_index).
  // We split derivative + non-derivative into one table with a flag because
  // the analytical questions (insider net buying/selling, 10b5-1 plan
  // adoption) treat them together.
  //
  // Transaction codes (SEC):
  //   P = open-market or private purchase
  //   S = open-market or private sale
  //   A = grant, award, or other acquisition
  //   M = exercise / conversion of derivative
  //   F = payment of exercise price or tax with shares
  //   D = sale to issuer
  //   G = bona fide gift
  //   X = exercise of in-the-money or at-the-money derivative
  //   J = other (footnote required)
  `create table if not exists insider_transactions (
    accession_number text not null,
    transaction_index smallint not null,
    cik text not null,
    insider_cik text,
    insider_name text not null,
    is_director boolean,
    is_officer boolean,
    is_ten_percent_owner boolean,
    officer_title text,
    transaction_date date,
    transaction_code text,
    derivative boolean not null default false,
    shares double precision,
    price_per_share double precision,
    transaction_value double precision,
    acquired_or_disposed text,
    shares_owned_after double precision,
    direct_or_indirect text,
    ten_b_5_one_plan boolean,
    filed_at timestamptz,
    primary key (accession_number, transaction_index)
  )`,
  `create index if not exists insider_tx_cik_date_idx on insider_transactions (cik, transaction_date desc)`,
  `create index if not exists insider_tx_insider_idx on insider_transactions (insider_name, transaction_date desc)`,

  // Schedule 13D / 13G filings extracted via DeepSeek. One row per filing.
  // Sole / shared voting + dispositive power are the SEC's standard fields
  // from Item 5; group_members captures Item 2 disclosure.
  `create table if not exists thirteen_d_filings (
    accession_number text primary key,
    cik text not null references companies(cik) on delete cascade,
    form text not null,
    filing_date date not null,
    event_date date,
    filer_name text not null,
    filer_cik text,
    is_active_intent boolean,
    purpose_summary text,
    cooperation_agreement_present boolean,
    standstill_present boolean,
    aggregate_shares double precision,
    aggregate_percent double precision,
    sole_voting_power double precision,
    shared_voting_power double precision,
    sole_dispositive_power double precision,
    shared_dispositive_power double precision,
    group_members text[],
    extracted_at timestamptz not null default now(),
    model text not null,
    raw_json jsonb not null
  )`,
  `create index if not exists thirteen_d_cik_idx on thirteen_d_filings (cik, filing_date desc)`,

  // 8-K Item 5.07 shareholder vote results. One row per filing; the worst
  // outcomes (say-on-pay support and min director support) are denormalized
  // for the leaderboard flag, while raw_proposals keeps the full list of
  // proposals for the company page. Vote support is computed as
  // for / (for + against) for SoP, and for / (for + withhold) for director
  // elections, expressed 0-100.
  `create table if not exists shareholder_votes (
    accession_number text primary key references filings(accession_number) on delete cascade,
    cik text not null references companies(cik) on delete cascade,
    filing_date date not null,
    meeting_date date,
    sop_present boolean not null default false,
    sop_for double precision,
    sop_against double precision,
    sop_abstain double precision,
    sop_support_pct double precision,
    director_vote_present boolean not null default false,
    director_count int,
    min_director_support_pct double precision,
    worst_director_name text,
    sop_frequency_chosen text,
    raw_proposals jsonb not null,
    extracted_at timestamptz not null default now(),
    model text not null
  )`,
  `create index if not exists shareholder_votes_cik_idx on shareholder_votes (cik, filing_date desc)`,

  // Generic facts pulled from inline XBRL of DEF 14A primary docs. One row
  // per (filing, concept, context). The context_ref + dimension_members
  // combine to identify which NEO/year/scenario the value applies to. We
  // store the full dimension map as JSONB so unusual taxonomy extensions
  // (custom company namespaces, footnote axes) survive without schema churn.
  //
  // Why a generic table instead of dedicated columns: filers tag wildly
  // different subsets of the SCT. Some tag PEO total only; some tag every
  // NEO + every column. The generic shape lets pull-ixbrl populate whatever
  // is present, and downstream views materialize specific facts (CEO Pay
  // Ratio, per-NEO SCT) when the tags exist.
  `create table if not exists ixbrl_facts (
    cik text not null,
    accession_number text not null,
    concept text not null,
    context_ref text not null,
    period_start date,
    period_end date,
    dimension_members jsonb,
    numeric_value double precision,
    text_value text,
    unit text,
    primary key (cik, accession_number, concept, context_ref)
  )`,
  `create index if not exists ixbrl_facts_concept_idx on ixbrl_facts (concept, period_end desc)`,
  `create index if not exists ixbrl_facts_filing_idx on ixbrl_facts (accession_number)`,

  // ── Perf indexes for the /mismanagement CTE pipeline. ────────────────
  // The leaderboard query (and the /mismanagement/rank lookup the company
  // page uses) does DISTINCT ON (cik, concept) ORDER BY cik, concept,
  // fiscal_year DESC over financial_metrics. The existing PK is
  // (cik, fiscal_year, concept) which doesn't match — Postgres has to
  // sort. This index lets it stream straight out of the btree.
  `create index if not exists financial_metrics_cik_concept_year_idx
     on financial_metrics (cik, concept, fiscal_year desc)`,

  // Same query filters insider_transactions / thirteen_d_filings by date
  // only (no cik), so the existing (cik, date) composite indexes don't
  // help that scan. A standalone date index does.
  `create index if not exists insider_tx_date_idx on insider_transactions (transaction_date desc)`,
  `create index if not exists thirteen_d_date_idx on thirteen_d_filings (filing_date desc) where is_active_intent`,

  // ── Mismanagement scoreboard, materialized. ──────────────────────────
  // Re-deriving the eight flags (and their evidence values) from raw
  // tables on every request blew past the Vercel Edge timeout — the
  // pipeline scans hundreds of thousands of rows even with the indexes
  // above. This table holds one row per CIK with everything the
  // /mismanagement endpoints need. The refresh-mismanagement script
  // recomputes it (TRUNCATE + INSERT) on demand; the table is otherwise
  // append-only from the API's perspective.
  `create table if not exists mismanagement_scores (
    cik text primary key references companies(cik) on delete cascade,
    years_under int,
    years_tracked int,
    peo_median double precision,
    latest_company_tsr double precision,
    latest_peer_tsr double precision,
    latest_pvp_year smallint,
    revenue double precision,
    net_income double precision,
    ocf double precision,
    capex double precision,
    sbc double precision,
    buybacks double precision,
    dividends_paid double precision,
    total_assets double precision,
    goodwill double precision,
    insider_net_365d double precision not null default 0,
    active_13d_count int not null default 0,
    flag_tsr_under boolean not null default false,
    flag_pay_through_it boolean not null default false,
    flag_active_13d boolean not null default false,
    flag_insider_selling boolean not null default false,
    flag_earnings_cash boolean not null default false,
    flag_dilutive_sbc boolean not null default false,
    flag_returns_over_fcf boolean not null default false,
    flag_goodwill_heavy boolean not null default false,
    flag_governance_dissent boolean not null default false,
    latest_sop_support_pct double precision,
    latest_min_director_support_pct double precision,
    latest_vote_meeting_date date,
    flags_fired int not null default 0,
    tiebreak double precision not null default 0,
    refreshed_at timestamptz not null default now()
  )`,
  // The endpoint ordering is (flags_fired desc, tiebreak desc, ticker asc).
  // Index covers the first two columns; ticker is read from the join.
  `create index if not exists mismanagement_scores_rank_idx
     on mismanagement_scores (flags_fired desc, tiebreak desc)`,
  // Existing deployments need the new columns even if mismanagement_scores
  // was created before the 9th flag landed.
  `alter table mismanagement_scores add column if not exists flag_governance_dissent boolean not null default false`,
  `alter table mismanagement_scores add column if not exists latest_sop_support_pct double precision`,
  `alter table mismanagement_scores add column if not exists latest_min_director_support_pct double precision`,
  `alter table mismanagement_scores add column if not exists latest_vote_meeting_date date`,
];

for (const stmt of statements) {
  // Strip standalone -- comment lines that show up between statements when
  // the JS string preserves them (we use them inside a single statement
  // already). The Postgres parser handles inline -- comments; this is
  // belt-and-suspenders for readability.
  await pool.query(stmt);
  const first = stmt.split("\n")[0]!.replace(/\s+/g, " ").trim();
  console.log("ok:", first.slice(0, 90));
}
await pool.end();
console.log("migrated.");
