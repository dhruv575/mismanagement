// Number/date formatters used across pages. Tabular by convention — every
// component that renders numerals should use these so columns line up.

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const USD_COMPACT = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
});
const USD_PLAIN = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 0,
});
const PCT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });

export const fmtCompact = (n: number | null | undefined) =>
  n == null ? "—" : COMPACT.format(n);
export const fmtUsdCompact = (n: number | null | undefined) =>
  n == null ? "—" : USD_COMPACT.format(n);
export const fmtUsd = (n: number | null | undefined) =>
  n == null ? "—" : USD_PLAIN.format(n);
export const fmtPct = (n: number | null | undefined) =>
  n == null ? "—" : PCT.format(n);

/** Direct percent (already in 0..100 range). Coerces stringified-numeric
 * to number; Postgres returns `numeric` columns as strings via the pg
 * driver and we'd otherwise crash on `.toFixed`. */
export const fmtPctRaw = (n: number | string | null | undefined, digits = 1) => {
  if (n == null) return "—";
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) ? `${v.toFixed(digits)}%` : "—";
};

export const fmtDate = (s: string | null | undefined) => {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

/** Indexed TSR is the value of $100 invested at start of period.
 *  Convert to a relative-percent return. */
export const tsrAsReturn = (indexed: number | null | undefined) =>
  indexed == null ? null : (indexed - 100) / 100;
