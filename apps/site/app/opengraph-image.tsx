import { ImageResponse } from "next/og";
import { api } from "@/lib/api";
import { C, Frame, OG_SIZE } from "@/lib/og";

export const revalidate = 21600;
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "Takeover: takeover attractiveness for every Russell 3000 company, computed from SEC filings";

const HEAVY = 5;

export default async function Image() {
  const board = await api<{ total: number; max_score: number; distribution: { score: number; count: number }[] }>(
    "/leaderboard?limit=1",
  );
  const max = board.max_score;
  const counts = Array.from({ length: max + 1 }, (_, k) => board.distribution.find((d) => d.score === k)?.count ?? 0);
  const top = Math.max(...counts, 1);
  const heavy = counts.slice(HEAVY).reduce((a, b) => a + b, 0);

  return new ImageResponse(
    (
      <Frame>
        <div style={{ display: "flex", flex: 1, alignItems: "flex-end", gap: 56 }}>
          <div style={{ display: "flex", flexDirection: "column", width: 560 }}>
            <div style={{ display: "flex", fontSize: 62, fontWeight: 600, lineHeight: 1.05, letterSpacing: -1.5 }}>
              Takeover attractiveness for every Russell 3000 company
            </div>
            <div style={{ display: "flex", marginTop: 24, fontSize: 28, color: C.dim }}>
              {`${heavy.toLocaleString("en-US")} of ${board.total.toLocaleString("en-US")} score ${HEAVY}+ of ${max} signals, from SEC filings.`}
            </div>
          </div>
          <div style={{ display: "flex", flex: 1, height: 300, alignItems: "flex-end", gap: 5 }}>
            {counts.map((c, k) => (
              <div key={k} style={{ display: "flex", flexDirection: "column", flex: 1, alignItems: "stretch", justifyContent: "flex-end", height: "100%" }}>
                <div style={{
                  display: "flex", height: `${Math.max((c / top) * 250, c ? 4 : 0)}px`,
                  background: k >= HEAVY ? C.hit : C.track, borderRadius: "6px 6px 0 0",
                }} />
                <div style={{ display: "flex", justifyContent: "center", marginTop: 10, fontSize: 18, color: C.mute }}>{String(k)}</div>
              </div>
            ))}
          </div>
        </div>
      </Frame>
    ),
    size,
  );
}
