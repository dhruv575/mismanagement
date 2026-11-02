import { fmtUsd } from "./format";

export const FLAG_LABELS: Record<string, string> = {
  tsr_under: "TSR below peers",
  pay_through_it: "High CEO pay despite TSR",
  active_13d: "Active 13D",
  insider_selling: "Net insider selling",
  earnings_cash: "Earnings not backed by cash",
  dilutive_sbc: "Dilutive SBC",
  returns_over_fcf: "Payouts exceed cash flow",
  goodwill_heavy: "Goodwill-heavy",
  governance_dissent: "Shareholder dissent",
};

// The threshold each flag tests, stated once next to the evidence.
export const FLAG_RULES: Record<string, string> = {
  tsr_under: "3+ of last 5 years",
  pay_through_it: "Median CEO pay ≥ $15M and TSR flag",
  active_13d: "Active-intent 13D in 18 months",
  insider_selling: "Net sales over $10M in 12 months",
  earnings_cash: "Cash flow under 80% of net income",
  dilutive_sbc: "Over 10% of revenue",
  returns_over_fcf: "Buybacks + dividends over cash flow",
  goodwill_heavy: "Over 40% of assets",
  governance_dissent: "Any vote under 80% support",
};

type Scores = Record<string, unknown>;
const n = (s: Scores, k: string): number | null => (s[k] == null ? null : Number(s[k]));
// Ratios past 10x read better as multiples ("187× net income") than as "18690%".
const pct = (v: number | null) =>
  v == null ? null : Math.abs(v) >= 10 ? `${v.toFixed(0)}×` : `${(v * 100).toFixed(0)}%`;

/** Numeric position of a flag's input vs its threshold, for the meter.
 *  `invert` flags fire when the value is BELOW the threshold. */
export function flagMeasure(f: string, s: Scores): { value: number; threshold: number; max: number; invert?: boolean } | null {
  const r = (a: number | null, b: number | null) => (a != null && b ? a / b : null);
  switch (f) {
    case "tsr_under": {
      const u = n(s, "years_under"), t = n(s, "years_tracked");
      return u != null && t ? { value: u, threshold: 3, max: Math.max(t, 5) } : null;
    }
    case "pay_through_it": {
      const v = n(s, "peo_median");
      return v != null ? { value: v / 1e6, threshold: 15, max: 30 } : null;
    }
    case "insider_selling": {
      const v = n(s, "insider_net_365d");
      return v != null ? { value: Math.max(0, -v) / 1e6, threshold: 10, max: 20 } : null;
    }
    case "earnings_cash": {
      const ni = n(s, "net_income");
      const v = ni && ni > 0 ? r(n(s, "ocf"), ni) : null;
      return v != null ? { value: v, threshold: 0.8, max: 2, invert: true } : null;
    }
    case "dilutive_sbc": {
      const v = r(n(s, "sbc"), n(s, "revenue"));
      return v != null ? { value: v, threshold: 0.1, max: 0.2 } : null;
    }
    case "returns_over_fcf": {
      const o = n(s, "ocf");
      const v = o && o > 0 ? ((n(s, "buybacks") ?? 0) + (n(s, "dividends_paid") ?? 0)) / o : null;
      return v != null ? { value: v, threshold: 1, max: 2 } : null;
    }
    case "goodwill_heavy": {
      const v = r(n(s, "goodwill"), n(s, "total_assets"));
      return v != null ? { value: v, threshold: 0.4, max: 0.8 } : null;
    }
    case "governance_dissent": {
      const lo = [n(s, "latest_sop_support_pct"), n(s, "latest_min_director_support_pct")]
        .filter((v): v is number => v != null);
      return lo.length ? { value: Math.min(...lo), threshold: 80, max: 100, invert: true } : null;
    }
  }
  return null;
}

/** The measured value behind a flag, or null when the input is missing. */
export function flagEvidence(f: string, s: Scores): string | null {
  switch (f) {
    case "tsr_under": {
      const u = n(s, "years_under"), t = n(s, "years_tracked");
      return u != null && t ? `${u} of ${t} years` : null;
    }
    case "pay_through_it":
      return n(s, "peo_median") != null ? `${fmtUsd(n(s, "peo_median"))} median` : null;
    case "active_13d":
      return n(s, "active_13d_count") != null ? `${n(s, "active_13d_count")} filing${n(s, "active_13d_count") === 1 ? "" : "s"}` : null;
    case "insider_selling":
      return n(s, "insider_net_365d") != null ? `${fmtUsd(n(s, "insider_net_365d"))} net` : null;
    case "earnings_cash": {
      const o = n(s, "ocf"), ni = n(s, "net_income");
      return o != null && ni && ni > 0 ? `${pct(o / ni)}${Math.abs(o / ni) >= 10 ? "" : " of"} net income` : null;
    }
    case "dilutive_sbc": {
      const sbc = n(s, "sbc"), r = n(s, "revenue");
      return sbc != null && r ? `${pct(sbc / r)} of revenue` : null;
    }
    case "returns_over_fcf": {
      const o = n(s, "ocf");
      const out = (n(s, "buybacks") ?? 0) + (n(s, "dividends_paid") ?? 0);
      return o ? `${pct(out / o)}${Math.abs(out / o) >= 10 ? "" : " of"} cash flow` : null;
    }
    case "goodwill_heavy": {
      const g = n(s, "goodwill"), a = n(s, "total_assets");
      return g != null && a ? `${pct(g / a)} of assets` : null;
    }
    case "governance_dissent": {
      const sop = n(s, "latest_sop_support_pct"), dir = n(s, "latest_min_director_support_pct");
      const lo = [sop, dir].filter((v): v is number => v != null);
      return lo.length ? `${Math.min(...lo).toFixed(0)}% lowest support` : null;
    }
  }
  return null;
}
