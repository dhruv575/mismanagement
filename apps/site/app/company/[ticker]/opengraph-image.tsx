import { ImageResponse } from "next/og";
import { app } from "@mismanagement/api";
import { C, Frame, OG_SIZE } from "@/lib/og";
import { FLAG_LABELS } from "@/lib/flags";
import { fmtUsd } from "@/lib/format";

export const revalidate = 21600;
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "Company red-flag scorecard";

interface Profile {
  company: { ticker: string; name: string };
  flags: string[];
  scores: Record<string, unknown> | null;
  financials: { years: number[]; series: Record<string, Record<number, number>> };
  derived: { ebitda: number | null; net_debt_to_ebitda: number | null };
  headcount: { employees: number } | null;
}

export default async function Image({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const res = await app.request(`/api/companies/${encodeURIComponent(ticker)}/profile`);
  const p = res.ok ? ((await res.json()) as Profile) : null;
  const name = p?.company.name ?? ticker.toUpperCase();
  const fired = p?.scores ? p.flags.filter((f) => p.scores![`flag_${f}`] === true) : [];
  const fy = p?.financials.years.at(-1);
  const revenue = fy != null ? p?.financials.series.revenue?.[fy] : undefined;
  const stats: [string, string][] = [
    ["Revenue", fmtUsd(revenue)],
    ["EBITDA", fmtUsd(p?.derived.ebitda)],
    ["Employees", p?.headcount ? p.headcount.employees.toLocaleString("en-US") : "—"],
    ["Net debt / EBITDA", p?.derived.net_debt_to_ebitda != null ? `${p.derived.net_debt_to_ebitda.toFixed(1)}×` : "—"],
  ];

  return new ImageResponse(
    (
      <Frame>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginTop: 64, fontSize: 60, fontWeight: 600 }}>
          <div style={{ display: "flex", color: C.accent }}>{p?.company.ticker ?? ticker.toUpperCase()}</div>
          <div style={{ display: "flex", color: C.mute, fontWeight: 400 }}>|</div>
          <div style={{ display: "flex", maxWidth: 880, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{name}</div>
        </div>
        <div style={{ display: "flex", marginTop: 28, fontSize: 34, color: fired.length ? C.neg : C.dim }}>
          {p?.scores ? `${fired.length} of ${p.flags.length} red flags` : "Not scored yet"}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 20 }}>
          {fired.slice(0, 6).map((f) => (
            <div key={f} style={{
              display: "flex", padding: "8px 18px", borderRadius: 999, fontSize: 24,
              background: "rgba(248,113,113,0.14)", border: "1px solid rgba(248,113,113,0.4)", color: C.ink,
            }}>{FLAG_LABELS[f]}</div>
          ))}
        </div>
        <div style={{ display: "flex", marginTop: "auto", gap: 56, paddingTop: 28, borderTop: `1px solid ${C.line}` }}>
          {stats.map(([label, value]) => (
            <div key={label} style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: 20, color: C.mute }}>{label}</div>
              <div style={{ display: "flex", fontSize: 36, marginTop: 4 }}>{value}</div>
            </div>
          ))}
        </div>
      </Frame>
    ),
    size,
  );
}
