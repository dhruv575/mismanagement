/*
 * MTS brand mark — three overlapping striped circles (yellow / red / blue).
 * Shared across MTS editorial sites (evidence, ufo, …) so branding is
 * pixel-identical.
 */

export function MTSLogo({ size = 28 }: { size?: number }) {
  const overlap = size * 0.35;
  const totalW = size * 3 - overlap * 2;

  const Stripes = ({ color, x, id }: { color: string; x: number; id: string }) => {
    const stripeRows = Math.ceil(size / 4);
    return (
      <g>
        <defs>
          <clipPath id={id}>
            <circle cx={x + size / 2} cy={size / 2} r={size / 2} />
          </clipPath>
        </defs>
        <circle cx={x + size / 2} cy={size / 2} r={size / 2} fill={color} />
        <g clipPath={`url(#${id})`}>
          {Array.from({ length: stripeRows }).map((_, i) => (
            <rect key={i} x={x} y={i * 4 + 2.5} width={size} height={1.5} fill="rgba(0,0,0,0.55)" />
          ))}
        </g>
      </g>
    );
  };

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: size * 0.4 }}>
      <svg width={totalW} height={size} viewBox={`0 0 ${totalW} ${size}`} style={{ display: "block" }} aria-hidden>
        <Stripes color="#FFD60A" x={0} id={`mts-clip-y-${size}`} />
        <Stripes color="#E63946" x={size - overlap} id={`mts-clip-r-${size}`} />
        <Stripes color="#1D4ED8" x={(size - overlap) * 2} id={`mts-clip-b-${size}`} />
      </svg>
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontWeight: 800,
          fontSize: size * 0.95,
          letterSpacing: "-0.04em",
          color: "var(--ink)",
          lineHeight: 1,
        }}
      >
        MTS
      </span>
    </div>
  );
}
