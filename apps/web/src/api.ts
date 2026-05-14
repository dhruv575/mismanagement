// Tiny API client. Same-origin in prod (Vercel rewrites /api/* to the
// Edge function); in dev, Vite proxies /api → http://localhost:5051.

const RAW_BASE = import.meta.env.VITE_API_URL || "/api";
const BASE = RAW_BASE.replace(/\/$/, "");

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()) as T;
}

// ── Companies ────────────────────────────────────────────

export interface SearchHit {
  cik: string;
  ticker: string;
  name: string;
  sic_description: string | null;
}
export const fetchSearch = (q: string) =>
  getJSON<{ rows: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`);

export interface Company {
  cik: string;
  ticker: string;
  name: string;
  sic_description: string | null;
  fiscal_year_end?: string | null;
}

export interface CompanyDetail extends Company {
  market_cap_at_universe_pull?: number | null;
  is_russell_3000?: boolean;
}

export const fetchCompany = (ticker: string) =>
  getJSON<CompanyDetail>(`/companies/${encodeURIComponent(ticker)}`);

export interface FinancialMetric {
  fiscal_year: number;
  concept: string;
  value: number;
  unit: string;
}
export const fetchFinancials = (ticker: string) =>
  getJSON<{ count: number; metrics: FinancialMetric[] }>(
    `/companies/${encodeURIComponent(ticker)}/financials`,
  );

export interface PricePoint { trading_date: string; adj_close: number }
export const fetchPrices = (ticker: string, limit = 1500) =>
  getJSON<{ count: number; prices: PricePoint[] }>(
    `/companies/${encodeURIComponent(ticker)}/prices?limit=${limit}`,
  );

// ── Compensation + board ─────────────────────────────────

export interface CompRow {
  name: string;
  title: string;
  fiscal_year: number;
  salary: number | null;
  bonus: number | null;
  stock_awards: number | null;
  option_awards: number | null;
  non_equity_incentive: number | null;
  change_in_pension: number | null;
  all_other_compensation: number | null;
  total: number | null;
}

export interface PvPRow {
  fiscal_year: number;
  peo_total_comp: number | null;
  peo_compensation_actually_paid: number | null;
  non_peo_neo_avg_total_comp: number | null;
  non_peo_neo_avg_compensation_actually_paid: number | null;
  company_tsr_indexed: number | null;
  peer_group_tsr_indexed: number | null;
  gaap_net_income: number | null;
}

export interface CompensationResponse {
  summary_compensation: CompRow[];
  pay_vs_performance: PvPRow[];
  source: { extracted_at: string | null; model: string | null; fiscal_year_covered: number | null };
}
export const fetchCompensation = (ticker: string) =>
  getJSON<CompensationResponse>(`/companies/${encodeURIComponent(ticker)}/comp`);

export interface DirectorRow {
  name: string;
  age: number | null;
  director_since_year: number | null;
  independent: boolean | null;
  is_chair: boolean | null;
  is_lead_independent_director: boolean | null;
  committees: string[];
  other_public_boards: string[];
  attendance_below_75pct: boolean | null;
  total_compensation: number | null;
}
export interface OwnershipRow {
  name: string;
  holder_type: string;
  shares: number | null;
  percent_class: number | null;
}
export interface RelatedPartyRow {
  description: string;
  parties: string[];
  amount_or_terms: string;
}
export interface BoardResponse {
  directors: DirectorRow[];
  ownership: OwnershipRow[];
  related_party: RelatedPartyRow[];
  source: { extracted_at: string | null; fiscal_year_covered: number | null };
}
export const fetchBoard = (ticker: string) =>
  getJSON<BoardResponse>(`/companies/${encodeURIComponent(ticker)}/board`);

// ── Activity ─────────────────────────────────────────────

export interface InsiderTx {
  transaction_date: string;
  insider_name: string;
  officer_title: string | null;
  is_director: boolean | null;
  is_officer: boolean | null;
  transaction_code: string;
  derivative: boolean;
  shares: number | null;
  price_per_share: number | null;
  transaction_value: number | null;
  acquired_or_disposed: string | null;
  ten_b_5_one_plan: boolean | null;
}
export const fetchInsider = (ticker: string, days = 365) =>
  getJSON<{ count: number; transactions: InsiderTx[] }>(
    `/companies/${encodeURIComponent(ticker)}/insider-activity?days=${days}`,
  );

export interface ThirteenDFiling {
  accession_number: string;
  form: string;
  filing_date: string;
  filer_name: string;
  is_active_intent: boolean | null;
  purpose_summary: string | null;
  cooperation_agreement_present: boolean | null;
  standstill_present: boolean | null;
  aggregate_percent: number | null;
  group_members: string[] | null;
}
export const fetch13D = (ticker: string) =>
  getJSON<{ count: number; filings: ThirteenDFiling[] }>(
    `/companies/${encodeURIComponent(ticker)}/13d`,
  );

// ── Screen ───────────────────────────────────────────────

export interface ScreenRow {
  cik: string;
  ticker: string;
  name: string;
  sic_description: string | null;
  market_cap: number | null;
  is_russell_3000: boolean;
  insider_tx_90d: number;
  insider_net_dollars_365d: number;
  has_recent_13d: boolean;
  has_active_13d: boolean;
  latest_revenue: number | null;
  latest_revenue_year: number | null;
  company_tsr_indexed: number | null;
  peer_group_tsr_indexed: number | null;
}
export type ScreenSort =
  | "activist_signal"
  | "ticker" | "name" | "market_cap"
  | "insider_tx_90d" | "insider_net_dollars_365d" | "latest_revenue" | "tsr_gap";
export interface ScreenResponse {
  count: number;
  total: number;
  rows: ScreenRow[];
}
export const fetchScreen = (opts: {
  sort?: ScreenSort;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
} = {}) => {
  const sp = new URLSearchParams();
  if (opts.sort) sp.set("sort", opts.sort);
  if (opts.dir) sp.set("dir", opts.dir);
  if (opts.limit != null) sp.set("limit", String(opts.limit));
  if (opts.offset != null) sp.set("offset", String(opts.offset));
  return getJSON<ScreenResponse>(`/screen?${sp.toString()}`);
};

// ── Stats + feeds (home page) ────────────────────────────

export interface OverviewStats {
  companies: number;
  russell_3000: number;
  proxy_extractions: number;
  insider_transactions_90d: number;
  thirteen_d_90d: number;
  latest_filing_date: string | null;
}
export const fetchOverview = () => getJSON<OverviewStats>(`/overview`);

export interface ThirteenDFeedRow extends ThirteenDFiling {
  ticker: string;
  company_name: string;
}
export const fetch13DFeed = (limit = 8) =>
  getJSON<{ count: number; filings: ThirteenDFeedRow[] }>(
    `/feeds/13d-recent?limit=${limit}`,
  );

export interface InsiderBuyRow {
  ticker: string;
  company_name: string;
  insider_name: string;
  officer_title: string | null;
  transaction_date: string;
  transaction_value: number | null;
  shares: number | null;
}
export const fetchInsiderBuys = (limit = 8) =>
  getJSON<{ count: number; transactions: InsiderBuyRow[] }>(
    `/feeds/insider-buys?limit=${limit}`,
  );

export interface TsrUnderRow {
  ticker: string;
  name: string;
  fiscal_year: number;
  company_tsr_indexed: number;
  peer_group_tsr_indexed: number;
  gap: number;
}
export const fetchTsrUnderperformers = (limit = 8) =>
  getJSON<{ count: number; rows: TsrUnderRow[] }>(
    `/feeds/tsr-underperformers?limit=${limit}`,
  );

// ── Fact sheet ──────────────────────────────────────────

export interface SheetResponse {
  ticker: string;
  company_name: string;
  highest_paid: { name: string; title: string; fiscal_year: number; total: number } | null;
  latest_pvp: {
    fiscal_year: number;
    peo_total_comp: number | null;
    peo_compensation_actually_paid: number | null;
    company_tsr_indexed: number | null;
    peer_group_tsr_indexed: number | null;
  } | null;
  board: {
    total: number;
    independent: number;
    not_independent: number;
    attendance_flags: number;
    chair: string | null;
    lead_independent_director: string | null;
  };
  top_holders: Array<{
    name: string; holder_type: string;
    shares: number | null; percent_class: number | null;
  }>;
  insider_flow_90d: {
    buys_value: number; sells_value: number; net_value: number;
    buys_count: number; sells_count: number;
  };
  thirteen_d: {
    total: number;
    active_count: number;
    most_recent_filer: string | null;
    most_recent_pct: number | null;
    most_recent_date: string | null;
  };
  related_party_count: number;
  ceo_pay_ratio: {
    ratio_x_to_1: number | null;
    ceo_total: number | null;
    median_employee: number | null;
    fiscal_year: number | null;
  } | null;
  source: { proxy_fiscal_year: number | null; proxy_extracted_at: string | null };
}
export const fetchSheet = (ticker: string) =>
  getJSON<SheetResponse>(`/companies/${encodeURIComponent(ticker)}/sheet`);

// ── Peers ────────────────────────────────────────────────

export interface PeerRow {
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
}
export interface PeersResponse {
  subject: PeerRow | null;
  peers: PeerRow[];
  unresolved: string[];
}
export const fetchPeers = (ticker: string) =>
  getJSON<PeersResponse>(`/companies/${encodeURIComponent(ticker)}/peers`);

// ── /activity — 13D by filer ─────────────────────────────

export interface FilerRollup {
  filer_name: string;
  target_count: number;
  filing_count: number;
  latest_filing_date: string;
  has_active_intent: boolean | null;
  filings: Array<{
    ticker: string;
    company_name: string;
    filing_date: string;
    form: string;
    aggregate_percent: number | null;
    is_active_intent: boolean | null;
  }>;
}
export const fetch13DByFiler = (limit = 20) =>
  getJSON<{ count: number; filers: FilerRollup[] }>(
    `/feeds/13d-by-filer?limit=${limit}`,
  );

// ── /comp — leaderboards ─────────────────────────────────

export interface CompHighestRow {
  ticker: string; company_name: string;
  executive_name: string; title: string;
  total: number; fiscal_year: number;
}
export const fetchCompHighest = (limit = 20) =>
  getJSON<{ count: number; rows: CompHighestRow[] }>(`/feeds/comp-highest?limit=${limit}`);

export interface CompPayGapRow {
  ticker: string; company_name: string; fiscal_year: number;
  peo_total_comp: number; peo_compensation_actually_paid: number; gap: number;
}
export const fetchCompPayGap = (limit = 20) =>
  getJSON<{ count: number; rows: CompPayGapRow[] }>(`/feeds/comp-pay-gap?limit=${limit}`);

export interface CompPayRatioRow {
  ticker: string; company_name: string; fiscal_year_covered: number;
  ratio_x_to_1: number; ceo_total: number | null; median_employee: number | null;
}
export const fetchCompPayRatio = (limit = 20) =>
  getJSON<{ count: number; rows: CompPayRatioRow[] }>(`/feeds/comp-pay-ratio?limit=${limit}`);

// Alias kept for backward-compatibility with files written before
// activist_signal was added to ScreenSort itself.
export type ScreenSortExtended = ScreenSort;

// ── Mismanagement ────────────────────────────────────────

export type MismanagementFlagId =
  | "tsr_under"
  | "pay_through_it"
  | "active_13d"
  | "insider_selling"
  | "earnings_cash"
  | "dilutive_sbc"
  | "returns_over_fcf"
  | "goodwill_heavy"
  | "governance_dissent";

export interface MismanagementRow {
  cik: string;
  ticker: string;
  name: string;
  sic_description: string | null;
  market_cap: number | null;
  years_under: number | null;
  years_tracked: number | null;
  peo_median: number | null;
  latest_company_tsr: number | null;
  latest_peer_tsr: number | null;
  latest_pvp_year: number | null;
  revenue: number | null;
  net_income: number | null;
  ocf: number | null;
  capex: number | null;
  sbc: number | null;
  buybacks: number | null;
  dividends_paid: number | null;
  total_assets: number | null;
  goodwill: number | null;
  insider_net_365d: number;
  active_13d_count: number;
  flag_tsr_under: boolean;
  flag_pay_through_it: boolean;
  flag_active_13d: boolean;
  flag_insider_selling: boolean;
  flag_earnings_cash: boolean;
  flag_dilutive_sbc: boolean;
  flag_returns_over_fcf: boolean;
  flag_goodwill_heavy: boolean;
  flag_governance_dissent: boolean;
  latest_sop_support_pct: number | null;
  latest_min_director_support_pct: number | null;
  latest_vote_meeting_date: string | null;
}

export interface MismanagementResponse {
  count: number;
  total: number;
  flags: MismanagementFlagId[];
  rows: MismanagementRow[];
}

export const fetchMismanagement = (opts: { minMcap?: number; limit?: number; offset?: number } = {}) => {
  const sp = new URLSearchParams();
  if (opts.minMcap != null) sp.set("min_mcap", String(opts.minMcap));
  if (opts.limit != null) sp.set("limit", String(opts.limit));
  if (opts.offset != null) sp.set("offset", String(opts.offset));
  return getJSON<MismanagementResponse>(`/mismanagement?${sp.toString()}`);
};

export interface MismanagementScorecard {
  flags: MismanagementFlagId[];
  row: Omit<MismanagementRow, "cik" | "ticker" | "name" | "sic_description" | "market_cap"> | null;
}
export const fetchMismanagementScorecard = (ticker: string) =>
  getJSON<MismanagementScorecard>(`/companies/${encodeURIComponent(ticker)}/mismanagement`);

// Tiny endpoint just for the rank eyebrow on /company/:ticker. Avoids
// dragging down /mismanagement?limit=5000 (which would otherwise be the
// only way to find this ticker's position in the leaderboard).
export const fetchMismanagementRank = (ticker: string) =>
  getJSON<{ rank: number | null; total: number }>(
    `/mismanagement/rank/${encodeURIComponent(ticker)}`,
  );
