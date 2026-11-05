// Gradient-boosted trees (logistic loss, shallow trees, shrinkage) as an
// alternative model family for the take-private label, on the same
// expanding window as experiment2.ts. Small and dependency-free: features are
// pre-binned into quantiles so each split search is a histogram pass.
//
// CLI:
//   tsx src/experiment-gbm.ts

import { pool } from "./db.js";
import { BASE, FUND, JEV_F, loadPanel } from "./experiment2.js";
import { auc, expanding, F, ok, sigmoid, summary, topDecile, type Feature, type Row, type Pred } from "./logit.js";

const BINS = 16;
interface Node { f: number; t: number; l: Node | number; r: Node | number }

function binner(train: Row[], feats: Feature[]) {
  const cuts = feats.map((f) => {
    const v = train.map((r) => r[f.name]).filter(ok).sort((a, b) => a - b);
    return Array.from({ length: BINS - 1 }, (_, i) => v[Math.floor(((i + 1) / BINS) * v.length)] ?? 0);
  });
  // Bin 0 is "missing"; 1..BINS by quantile.
  return (r: Row) => feats.map((f, j) => { const v = r[f.name]; if (!ok(v)) return 0; let b = 1; for (const c of cuts[j]!) if (v > c) b++; return b; });
}

function grow(X: number[][], g: number[], h: number[], idx: number[], depth: number, lambda: number, minH: number): Node | number {
  const G = idx.reduce((a, i) => a + g[i]!, 0), H = idx.reduce((a, i) => a + h[i]!, 0);
  const leaf = -G / (H + lambda);
  if (depth === 0 || idx.length < 40) return leaf;
  let best = { gain: 0, f: -1, t: -1 };
  const k = X[0]!.length;
  for (let f = 0; f < k; f++) {
    const gs = new Array(BINS + 1).fill(0), hs = new Array(BINS + 1).fill(0);
    for (const i of idx) { const b = X[i]![f]!; gs[b] += g[i]!; hs[b] += h[i]!; }
    let gl = 0, hl = 0;
    for (let t = 0; t < BINS; t++) {
      gl += gs[t]; hl += hs[t];
      const gr = G - gl, hr = H - hl;
      if (hl < minH || hr < minH) continue;
      const gain = gl * gl / (hl + lambda) + gr * gr / (hr + lambda) - G * G / (H + lambda);
      if (gain > best.gain) best = { gain, f, t };
    }
  }
  if (best.f < 0) return leaf;
  const L = idx.filter((i) => X[i]![best.f]! <= best.t), R = idx.filter((i) => X[i]![best.f]! > best.t);
  return { f: best.f, t: best.t, l: grow(X, g, h, L, depth - 1, lambda, minH), r: grow(X, g, h, R, depth - 1, lambda, minH) };
}
const walk = (n: Node | number, x: number[]): number => (typeof n === "number" ? n : walk(x[n.f]! <= n.t ? n.l : n.r, x));

function gbm(train: Row[], test: Row[], label: string, feats: Feature[], o: { trees: number; depth: number; lr: number; lambda: number; minH: number }) {
  const bin = binner(train, feats);
  const X = train.map(bin), T = test.map(bin), y: number[] = train.map((r) => (r[label] ? 1 : 0));
  const base = y.reduce((a, b) => a + b, 0) / y.length;
  const f0 = Math.log(base / (1 - base));
  const F = new Array(X.length).fill(f0), FT = new Array(T.length).fill(f0);
  const all = X.map((_, i) => i);
  for (let m = 0; m < o.trees; m++) {
    const p = F.map(sigmoid), g = p.map((pi, i) => pi - y[i]!), h = p.map((pi) => Math.max(pi * (1 - pi), 1e-6));
    const tree = grow(X, g, h, all, o.depth, o.lambda, o.minH);
    for (let i = 0; i < X.length; i++) F[i] += o.lr * walk(tree, X[i]!);
    for (let i = 0; i < T.length; i++) FT[i] += o.lr * walk(tree, T[i]!);
  }
  return FT;
}

async function main(): Promise<void> {
  const rows = await loadPanel();
  const feats = [...BASE, ...FUND, ...JEV_F, F("jev_missing", 0, 1, { missingFlag: false })];
  const OUTER = [2020, 2021, 2022, 2023, 2024];
  const logit = expanding(rows, "pe", [...BASE, ...["services_share", "labor_intensity", "ai_automatable", "fragmented_market", "recurring_revenue", "rollup_fit", "contracted", "regulated"].map((n) => F(`j_${n}`, 0, 10, { missingFlag: false })), F("jev_missing", 0, 1, { missingFlag: false })], 5, OUTER);
  const lm = summary(logit);
  console.log(`logistic (production set): auc ${lm.auc.toFixed(3)} top ${lm.top.toFixed(2)}x`);
  const grid = [
    { trees: 150, depth: 2, lr: 0.05, lambda: 5, minH: 2 },
    { trees: 300, depth: 2, lr: 0.03, lambda: 10, minH: 3 },
    { trees: 200, depth: 3, lr: 0.03, lambda: 10, minH: 3 },
    { trees: 400, depth: 1, lr: 0.05, lambda: 5, minH: 2 },
  ];
  for (const o of grid) {
    const pred: Pred[] = [];
    for (const c of OUTER) {
      const train = rows.filter((r) => r.cohort_year < c), test = rows.filter((r) => r.cohort_year === c);
      const s = gbm(train, test, "pe", feats, o);
      test.forEach((r, i) => pred.push({ cohort: c, s: s[i]!, y: r.pe ? 1 : 0, cik: r.cik }));
    }
    // Blend: average of the two models' within-cohort ranks.
    const rank = (ps: Pred[]) => { const m = new Map<string, number>(); for (const c of OUTER) { const g = ps.filter((p) => p.cohort === c).sort((a, b) => a.s - b.s); g.forEach((p, i) => m.set(`${p.cik}:${c}`, i / g.length)); } return m; };
    const rl = rank(logit), rg = rank(pred);
    const blend = pred.map((p) => ({ ...p, s: (rl.get(`${p.cik}:${p.cohort}`) ?? 0) + rg.get(`${p.cik}:${p.cohort}`)! }));
    console.log(`gbm ${JSON.stringify(o)}: auc ${auc(pred.map((p) => p.s), pred.map((p) => p.y)).toFixed(3)} top ${topDecile(pred).toFixed(2)}x | blend with logistic: auc ${summary(blend).auc.toFixed(3)} top ${summary(blend).top.toFixed(2)}x`);
  }
  await pool.end();
}

await main();
