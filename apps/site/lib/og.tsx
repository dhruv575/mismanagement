// Shared frame for generated Open Graph images (1200×630). ImageResponse
// supports a flexbox subset of CSS, so every container sets display:flex.
import { PixelMark } from "./mark";


export const OG_SIZE = { width: 1200, height: 630 };

export const C = {
  bg: "#ffffff",
  card: "#f7f7f5",
  line: "rgba(0,0,0,0.1)",
  ink: "#18181b",
  dim: "#52525b",
  mute: "#71717a",
  accent: "#4f46e5",
  hit: "#4f46e5",
  track: "#e8e8e4",
};

// The pixel mark, at a multiple of 16px.
export function Mark({ size = 48 }: { size?: number }) {
  return <PixelMark size={size} />;
}

export function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      background: C.bg, color: C.ink, padding: "56px 64px", fontFamily: "sans-serif",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Mark />
        <div style={{ display: "flex", fontSize: 28, fontWeight: 600 }}>Takeover</div>
        <div style={{ display: "flex", marginLeft: "auto", fontSize: 22, color: C.mute }}>takeover.droov.info</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>{children}</div>
    </div>
  );
}
