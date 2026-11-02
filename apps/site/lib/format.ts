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
