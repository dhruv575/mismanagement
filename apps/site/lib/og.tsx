// Shared frame for generated Open Graph images (1200×630). ImageResponse
// supports a flexbox subset of CSS, so every container sets display:flex.

export const OG_SIZE = { width: 1200, height: 630 };

export const C = {
  bg: "#000000",
  card: "#0f0f10",
  line: "rgba(255,255,255,0.12)",
  ink: "#ececf1",
  dim: "#b4b4c0",
  mute: "#8e8ea0",
  accent: "#8fa4ff",
  neg: "#f87171",
};

export function Mark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill={C.card} />
      <rect x="17" y="12" width="5" height="42" rx="2.5" fill={C.ink} />
      <path d="M22 14h24l-6 9 6 9H22z" fill={C.neg} />
    </svg>
  );
}

export function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      background: C.bg, color: C.ink, padding: "56px 64px", fontFamily: "sans-serif",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Mark />
        <div style={{ display: "flex", fontSize: 28, fontWeight: 600 }}>Mismanagement</div>
        <div style={{ display: "flex", marginLeft: "auto", fontSize: 22, color: C.mute }}>mismanagement.droov.info</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>{children}</div>
    </div>
  );
}
