import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div style={{ padding: "80px 28px", maxWidth: 720, margin: "0 auto" }}>
      <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--accent)" }}>
        404
      </p>
      <h1 style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 64, lineHeight: 1.04, margin: "8px 0 18px", color: "var(--ink-strong)" }}>
        Not found.
      </h1>
      <p style={{ color: "var(--ink-dim)", lineHeight: 1.55 }}>
        That page doesn't exist. Try{" "}
        <Link to="/" style={{ color: "var(--accent)" }}>the overview</Link>
        {" "}or{" "}
        <Link to="/screen" style={{ color: "var(--accent)" }}>the screen</Link>.
      </p>
    </div>
  );
}
