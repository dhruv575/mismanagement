// Pixel sprites for the angel / devil toggle. 12x10 grids, rendered with
// crisp edges; one rect per horizontal run of a color.
const COLORS: Record<string, string> = {
  H: "#fbbf24", // halo
  O: "#1e1b4b", // outline
  W: "#ffffff", // angel face
  K: "#1e1b4b", // angel eyes and smile
  L: "#c7d2fe", // wings
  R: "#dc2626", // devil face
  D: "#7f1d1d", // horn tips
  Y: "#fde047", // devil eyes
};

const ANGEL = [
  "...HHHHHH...",
  "..H......H..",
  "...HHHHHH...",
  "...OOOOOO...",
  "..OWWWWWWO..",
  "LLOWKWWKWOLL",
  "LLOWWWWWWOLL",
  ".LOWKWWKWOL.",
  "..OWWKKWWO..",
  "...OOOOOO...",
];

const DEVIL = [
  "..D......D..",
  "..RD....DR..",
  "...RD..DR...",
  "...OOOOOO...",
  "..ORRRRRRO..",
  "..ORYRRYRO..",
  "..ORRRRRRO..",
  "..ORDRRDRO..",
  "..ORRDDRRO.R",
  "...OOOOOO.RR",
];

function runs(grid: string[]) {
  return grid.flatMap((row, y) => {
    const out: { x: number; y: number; w: number; fill: string }[] = [];
    for (let x = 0; x < row.length;) {
      let w = 1;
      while (x + w < row.length && row[x + w] === row[x]) w++;
      if (row[x] !== ".") out.push({ x, y, w, fill: COLORS[row[x]!]! });
      x += w;
    }
    return out;
  });
}
const RUNS = { angel: runs(ANGEL), devil: runs(DEVIL) };

export function Sprite({ kind, size = 24 }: { kind: "angel" | "devil"; size?: number }) {
  return (
    <svg width={size} height={(size * 10) / 12} viewBox="0 0 12 10" shapeRendering="crispEdges" aria-hidden="true">
      {RUNS[kind].map((r) => <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />)}
    </svg>
  );
}
