// Tiny SVG sparkline. No charting lib — keeps the bundle lean.
// Pass an array of { trading_date, adj_close }; renders a 1200×120 viewBox
// area chart that scales to its container width.

interface Props {
  data: Array<{ trading_date: string; adj_close: number }>;
  height?: number;
}

export function PriceSparkline({ data, height = 120 }: Props) {
  if (!data || data.length < 2) return null;
  const W = 1200;
  const H = height;
  const PAD = 4;
  const ys = data.map((d) => d.adj_close);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const yRange = maxY - minY || 1;

  const x = (i: number) => PAD + (i / (data.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - minY) / yRange) * (H - PAD * 2);

  let line = `M ${x(0)} ${y(data[0]!.adj_close)}`;
  for (let i = 1; i < data.length; i++) line += ` L ${x(i)} ${y(data[i]!.adj_close)}`;
  const area = `${line} L ${x(data.length - 1)} ${H} L ${x(0)} ${H} Z`;

  const first = data[0]!.adj_close;
  const last = data[data.length - 1]!.adj_close;
  const pct = ((last - first) / first) * 100;
  const tag = pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;

  return (
    <div>
      <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <path className="area" d={area} />
        <path className="line" d={line} />
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--ink-mute)",
        }}
      >
        <span>${first.toFixed(2)} · {data[0]!.trading_date}</span>
        <span style={{ color: pct >= 0 ? "var(--pos)" : "var(--neg)" }}>{tag}</span>
        <span>${last.toFixed(2)} · {data[data.length - 1]!.trading_date}</span>
      </div>
    </div>
  );
}
