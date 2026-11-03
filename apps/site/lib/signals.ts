import { fmtUsd } from "./format";

// The thirteen yes/no checks behind the takeover score, keyed by their
// column on takeover_scores. The API sends the grouping; this file owns
// the wording, the threshold text and how to show the number behind each.

export const SIGNAL_LABELS: Record<string, string> = {
  flag_tsr_under: "TSR below peers",
  flag_pay_through_it: "High CEO pay despite TSR",
  flag_earnings_cash: "Earnings not backed by cash",
  flag_dilutive_sbc: "Dilutive SBC",
  flag_returns_over_fcf: "Payouts exceed cash flow",
  flag_goodwill_heavy: "Goodwill-heavy",
  flag_governance_dissent: "Shareholder dissent",
  signal_low_productivity: "Low revenue per employee",
  signal_ai_quiet: "Quiet on AI",
  signal_debt_capacity: "Net cash",
  signal_size_fit: "Buyout-sized",
  flag_active_13d: "Active 13D",
  flag_insider_selling: "Net insider selling",
};

// The threshold each check tests, stated once next to the evidence.
export const SIGNAL_RULES: Record<string, string> = {
  flag_tsr_under: "3+ of last 5 years",
  flag_pay_through_it: "Median CEO pay ≥ $15M while TSR trails",
  flag_earnings_cash: "Cash flow under 80% of net income",
  flag_dilutive_sbc: "Over 10% of revenue",
  flag_returns_over_fcf: "Buybacks + dividends over cash flow",
  flag_goodwill_heavy: "Over 40% of assets",
  flag_governance_dissent: "Any vote under 80% support",
  signal_low_productivity: "Bottom quartile of its SIC industry",
  signal_ai_quiet: "Bottom quartile of AI mentions in 10-Ks",
  signal_debt_capacity: "More cash than debt, positive EBITDA",
  signal_size_fit: "Market cap $500M–$5B",
  flag_active_13d: "Active-intent 13D in 18 months",
  flag_insider_selling: "Net sales over $10M in 12 months",
};

export interface SignalGroup { key: string; label: string; signals: readonly string[] }

type Scores = Record<string, unknown>;
type Measure = { value: number; threshold: number; max: number; invert?: boolean } | null;

const n = (s: Scores, k: string): number | null => (s[k] == null ? null : Number(s[k]));
// Ratios past 10x read better as multiples ("187× net income") than as "18690%".
const pct = (v: number | null) =>
  v == null ? null : Math.abs(v) >= 10 ? `${v.toFixed(0)}×` : `${(v * 100).toFixed(0)}%`;
const ordinal = (p: number) => {
  const v = Math.round(p * 100);
  const suffix = v % 100 >= 11 && v % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[v % 10] ?? "th";
  return `${v}${suffix}`;
};

/** Numeric position of a check's input vs its threshold, for the meter.
 *  `invert` checks fire when the value is BELOW the threshold. */
export function signalMeasure(k: string, s: Scores): Measure {
  const r = (a: number | null, b: number | null) => (a != null && b ? a / b : null);
  switch (k) {
    case "flag_tsr_under": {
      const u = n(s, "years_under"), t = n(s, "years_tracked");
      return u != null && t ? { value: u, threshold: 3, max: Math.max(t, 5) } : null;
    }
    case "flag_pay_through_it": {
      const v = n(s, "peo_median");
      return v != null ? { value: v / 1e6, threshold: 15, max: 30 } : null;
    }
    case "flag_insider_selling": {
      const v = n(s, "insider_net_365d");
      return v != null ? { value: Math.max(0, -v) / 1e6, threshold: 10, max: 20 } : null;
    }
    case "flag_earnings_cash": {
      const ni = n(s, "net_income");
      const v = ni && ni > 0 ? r(n(s, "ocf"), ni) : null;
      return v != null ? { value: v, threshold: 0.8, max: 2, invert: true } : null;
    }
    case "flag_dilutive_sbc": {
      const v = r(n(s, "sbc"), n(s, "revenue"));
      return v != null ? { value: v, threshold: 0.1, max: 0.2 } : null;
    }
    case "flag_returns_over_fcf": {
      const o = n(s, "ocf");
      const v = o && o > 0 ? ((n(s, "buybacks") ?? 0) + (n(s, "dividends_paid") ?? 0)) / o : null;
      return v != null ? { value: v, threshold: 1, max: 2 } : null;
    }
    case "flag_goodwill_heavy": {
      const v = r(n(s, "goodwill"), n(s, "total_assets"));
      return v != null ? { value: v, threshold: 0.4, max: 0.8 } : null;
    }
    case "flag_governance_dissent": {
      const lo = [n(s, "latest_sop_support_pct"), n(s, "latest_min_director_support_pct")]
        .filter((v): v is number => v != null);
      return lo.length ? { value: Math.min(...lo), threshold: 80, max: 100, invert: true } : null;
    }
    case "signal_low_productivity": {
      const p = n(s, "rpe_industry_pctile");
      return p != null ? { value: p, threshold: 0.25, max: 1, invert: true } : null;
    }
    case "signal_ai_quiet": {
      const p = n(s, "ai_rate_pctile");
      return p != null ? { value: p, threshold: 0.25, max: 1, invert: true } : null;
    }
    case "signal_debt_capacity": {
      // Net debt / EBITDA shifted so net cash (below 0) sits left of the tick.
      const v = n(s, "net_debt_to_ebitda");
      return v != null ? { value: Math.min(Math.max(v + 2, 0), 6), threshold: 2, max: 6, invert: true } : null;
    }
  }
  return null;
}

/** The measured value behind a check, or null when the input is missing. */
export function signalEvidence(k: string, s: Scores, marketCap?: number | null): string | null {
  switch (k) {
    case "flag_tsr_under": {
      const u = n(s, "years_under"), t = n(s, "years_tracked");
      return u != null && t ? `${u} of ${t} years` : null;
    }
    case "flag_pay_through_it":
      return n(s, "peo_median") != null ? `${fmtUsd(n(s, "peo_median"))} median` : null;
    case "flag_active_13d":
      return n(s, "active_13d_count") != null ? `${n(s, "active_13d_count")} filing${n(s, "active_13d_count") === 1 ? "" : "s"}` : null;
    case "flag_insider_selling":
      return n(s, "insider_net_365d") != null ? `${fmtUsd(n(s, "insider_net_365d"))} net` : null;
    case "flag_earnings_cash": {
      const o = n(s, "ocf"), ni = n(s, "net_income");
      return o != null && ni && ni > 0 ? `${pct(o / ni)}${Math.abs(o / ni) >= 10 ? "" : " of"} net income` : null;
    }
    case "flag_dilutive_sbc": {
      const sbc = n(s, "sbc"), r = n(s, "revenue");
      return sbc != null && r ? `${pct(sbc / r)} of revenue` : null;
    }
    case "flag_returns_over_fcf": {
      const o = n(s, "ocf");
      const out = (n(s, "buybacks") ?? 0) + (n(s, "dividends_paid") ?? 0);
      return o ? `${pct(out / o)}${Math.abs(out / o) >= 10 ? "" : " of"} cash flow` : null;
    }
    case "flag_goodwill_heavy": {
      const g = n(s, "goodwill"), a = n(s, "total_assets");
      return g != null && a ? `${pct(g / a)} of assets` : null;
    }
    case "flag_governance_dissent": {
      const lo = [n(s, "latest_sop_support_pct"), n(s, "latest_min_director_support_pct")]
        .filter((v): v is number => v != null);
      return lo.length ? `${Math.min(...lo).toFixed(0)}% lowest support` : null;
    }
    case "signal_low_productivity": {
      const v = n(s, "revenue_per_employee"), p = n(s, "rpe_industry_pctile");
      if (v == null) return null;
      return p != null ? `${fmtUsd(v)} · ${ordinal(p)} pct` : `${fmtUsd(v)} per employee`;
    }
    case "signal_ai_quiet": {
      const v = n(s, "ai_mentions_rate"), p = n(s, "ai_rate_pctile");
      return v != null && p != null ? `${v.toFixed(1)} per 10K words · ${ordinal(p)} pct` : null;
    }
    case "signal_debt_capacity": {
      const v = n(s, "net_debt_to_ebitda");
      return v == null ? null : v < 0 ? `Net cash · ${Math.abs(v).toFixed(1)}× EBITDA` : `${v.toFixed(1)}× EBITDA net debt`;
    }
    case "signal_size_fit":
      return marketCap != null ? `${fmtUsd(marketCap)} market cap` : null;
  }
  return null;
}
