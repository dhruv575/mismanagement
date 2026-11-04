// The pixel mark: one face, angel on the left (halo, white) and devil on
// the right (horn, red), on a 16x16 grid. Same grid as app/icon.svg
// (generated from it). Render at multiples of 16px so pixels stay square.
const GRID = [
  ".HHHHH.......D..",
  "H.....H.....DRD.",
  ".HHHHH.....DRRD.",
  "...OOOOOOOOORD..",
  "..OWWWWWRRRRRO..",
  ".OWWWWWWRRRRRRO.",
  ".OWWKKWWRRYYRRO.",
  ".OWWKKWWRRYYRRO.",
  ".OWWWWWWRRRRRRO.",
  ".OWWWWWWRRRRRRO.",
  ".OWKWWWWRRRRDRO.",
  ".OWWKKKKDDDDRRO.",
  "..OWWWWWRRRRRO..",
  "...OOOOOOOOOOR..",
  ".............R..",
  "............RRR.",
];
const COLORS: Record<string, string> = { H: "#fbbf24", O: "#1e1b4b", W: "#ffffff", K: "#1e1b4b", R: "#dc2626", D: "#7f1d1d", Y: "#fde047" };

// One rect per horizontal run of a color.
const RUNS = GRID.flatMap((row, y) => {
  const out: { x: number; y: number; w: number; fill: string }[] = [];
  for (let x = 0; x < 16;) {
    let w = 1;
    while (x + w < 16 && row[x + w] === row[x]) w++;
    if (row[x] !== ".") out.push({ x, y, w, fill: COLORS[row[x]!]! });
    x += w;
  }
  return out;
});

export function PixelMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
      {RUNS.map((r) => <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />)}
    </svg>
  );
}
