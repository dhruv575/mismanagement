// Small server-rendered SVG marks. Single series each: no legend (the
// adjacent label names it); text stays in text tokens, the line carries trend.

export function Sparkline({
  values, labels, width = 96, height = 28, format,
}: {
  values: (number | null | undefined)[];
  labels: string[];
  width?: number;
  height?: number;
  format: (v: number) => string;
}) {
  const pts = values.map((v, i) => (v == null ? null : { i, v }));
  const real = pts.filter((p): p is { i: number; v: number } => p != null);
  if (real.length < 2) return <span className="spark-empty" style={{ width, height }} aria-hidden="true" />;
  const min = Math.min(...real.map((p) => p.v));
  const max = Math.max(...real.map((p) => p.v));
  const pad = 4;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => (max === min ? height / 2 : pad + (1 - (v - min) / (max - min)) * (height - pad * 2));
  const d = real.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const last = real.at(-1)!;
  const summary = real.map((p) => `${labels[p.i]} ${format(p.v)}`).join(", ");

  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
      <path d={d} fill="none" className="spark-line" />
      {/* Hit targets wider than the mark; native tooltip per point. */}
      {real.map((p) => (
        <g key={p.i} className="spark-pt">
          <rect x={x(p.i) - 8} y={0} width={16} height={height} fill="transparent" />
          <circle cx={x(p.i)} cy={y(p.v)} r={p === last ? 3 : 2.5} className={p === last ? "spark-last" : "spark-dot"} />
          <title>{`${labels[p.i]}: ${format(p.v)}`}</title>
        </g>
      ))}
    </svg>
  );
}

/** Signed change vs the prior period. `goodWhenUp` decides the color. */
export function Delta({ now, prev, goodWhenUp = true, suffix = "YoY" }: {
  now: number | null | undefined; prev: number | null | undefined; goodWhenUp?: boolean; suffix?: string;
}) {
  if (now == null || prev == null || prev === 0) return null;
  const ch = (now - prev) / Math.abs(prev);
  if (!Number.isFinite(ch)) return null;
  const up = ch > 0;
  const tone = Math.abs(ch) < 0.005 ? "flat" : up === goodWhenUp ? "good" : "bad";
  return (
    <span className="delta" data-tone={tone}>
      <span aria-hidden="true">{tone === "flat" ? "–" : up ? "▲" : "▼"}</span>
      {` ${Math.abs(ch * 100).toFixed(Math.abs(ch) < 0.1 ? 1 : 0)}% ${suffix}`}
    </span>
  );
}

/** Value against a threshold. Track spans 0..max; tick marks the limit. */
export function Meter({ value, threshold, max, fired, label }: {
  value: number; threshold: number; max: number; fired: boolean; label: string;
}) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v / max));
  return (
    <div className="meter" data-fired={fired} role="meter" aria-label={label}
      aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)}>
      <div className="meter-fill" style={{ width: `${clamp(value) * 100}%` }} />
      <div className="meter-tick" style={{ left: `${clamp(threshold) * 100}%` }} />
    </div>
  );
}
