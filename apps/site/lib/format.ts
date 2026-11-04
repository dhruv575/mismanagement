export function fmtUsd(v: number | string | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  return new Date(`${v.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/** The AI-rollup model's output relative to the average company: "4.2×". */
export function fmtMultiple(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}×`;
}

/** The same as a phrase: "4.2× more likely than average". */
export function likelihoodPhrase(v: number): string {
  if (v >= 1.15) return `${fmtMultiple(v)} more likely than average`;
  if (v <= 0.87) return `${fmtMultiple(1 / v)} less likely than average`;
  return "About as likely as average";
}
