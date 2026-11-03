import { ImageResponse } from "next/og";
import { app } from "@takeover/api";
import { C, Frame, OG_SIZE } from "@/lib/og";
import { SIGNAL_LABELS, type SignalGroup } from "@/lib/signals";
import { fmtUsd } from "@/lib/format";

export const revalidate = 21600;
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "Company takeover score";

interface Profile {
  company: { ticker: string; name: string; market_cap: number | null };
  groups: SignalGroup[];
  scores: Record<string, unknown> | null;
  derived: { ebitda: number | null; net_debt_to_ebitda: number | null };
  headcount: { employees: number } | null;
}

export default async function Image({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const res = await app.request(`/api/companies/${encodeURIComponent(ticker)}/profile`);
  const p = res.ok ? ((await res.json()) as Profile) : null;
  const name = p?.company.name ?? ticker.toUpperCase();
  const all = p ? p.groups.flatMap((g) => g.signals) : [];
  const fired = p?.scores ? all.filter((k) => p.scores![k] === true) : [];
  const stats: [string, string][] = [
    ["Market cap", fmtUsd(p?.company.market_cap)],
    ["EBITDA", fmtUsd(p?.derived.ebitda)],
    ["Employees", p?.headcount ? p.headcount.employees.toLocaleString("en-US") : "—"],
    ["Net debt / EBITDA", p?.derived.net_debt_to_ebitda != null ? `${p.derived.net_debt_to_ebitda.toFixed(1)}×` : "—"],
  ];

  return new ImageResponse(
    (
      <Frame>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, marginTop: 56, fontSize: 58, fontWeight: 600 }}>
          <div style={{ display: "flex", color: C.accent }}>{p?.company.ticker ?? ticker.toUpperCase()}</div>
          <div style={{ display: "flex", color: C.mute, fontWeight: 400 }}>|</div>
          <div style={{ display: "flex", maxWidth: 880, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{name}</div>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 22 }}>
          <div style={{ display: "flex", fontSize: 44, fontWeight: 600, color: C.hit }}>{p?.scores ? String(fired.length) : "—"}</div>
          <div style={{ display: "flex", fontSize: 30, color: C.dim }}>{p?.scores ? `of ${all.length} takeover signals` : "Not scored yet"}</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 18 }}>
          {fired.slice(0, 6).map((k) => (
            <div key={k} style={{
              display: "flex", padding: "8px 18px", borderRadius: 999, fontSize: 24,
              background: "rgba(79,70,229,0.08)", border: "1px solid rgba(79,70,229,0.35)", color: C.ink,
            }}>{SIGNAL_LABELS[k]}</div>
          ))}
        </div>
        <div style={{ display: "flex", marginTop: "auto", gap: 56, paddingTop: 26, borderTop: `1px solid ${C.line}` }}>
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
