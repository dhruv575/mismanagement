// Shared logistic regression + evaluation for the takeover models:
// weighted-L2 Newton fit, feature design with imputation and missing flags,
// AUC and top-decile lift, expanding-window evaluation by cohort.

export interface Feature { name: string; lo: number; hi: number; log?: boolean; missingFlag?: boolean }
export const F = (name: string, lo: number, hi: number, o: Partial<Feature> = {}): Feature => ({ name, lo, hi, missingFlag: true, ...o });
export type Row = Record<string, any>;

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const transform = (f: Feature, v: number) => { const c = Math.min(Math.max(v, f.lo), f.hi); return f.log ? Math.log1p(c) : c; };

function solve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r]![c]! / M[c]![c]!;
      for (let j = c; j <= n; j++) M[r]![j]! -= k * M[c]![j]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

export function fit(X: number[][], y: number[], l2: number): number[] {
  const k = X[0]!.length;
  let beta = new Array(k).fill(0);
  for (let iter = 0; iter < 40; iter++) {
    const g = new Array(k).fill(0), H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = X[i]!;
      let z = 0; for (let j = 0; j < k; j++) z += x[j]! * beta[j];
      const p = sigmoid(z), s = p * (1 - p), r = y[i]! - p;
      for (let a = 0; a < k; a++) { const xa = x[a]!; g[a] += r * xa; const Ha = H[a]!; const sx = s * xa; for (let b = 0; b <= a; b++) Ha[b] += sx * x[b]!; }
    }
    for (let a = 0; a < k; a++) { for (let b = 0; b < a; b++) H[b]![a] = H[a]![b]; if (a) { g[a] -= l2 * beta[a]; H[a]![a] += l2; } }
    const step = solve(H, g);
    beta = beta.map((v, j) => v + step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return beta;
}

export interface Design { impute: number[]; mean: number[]; sd: number[]; cols: string[]; x: (r: Row) => number[] }
export function designer(train: Row[], feats: Feature[]): Design {
  const impute = feats.map((f) => { const v = train.map((r) => r[f.name]).filter(ok).map((v) => transform(f, v)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; });
  const raw = (r: Row) => feats.flatMap((f, i) => { const v = r[f.name]; const t = ok(v) ? transform(f, v) : impute[i]!; return f.missingFlag ? [t, ok(v) ? 0 : 1] : [t]; });
  const R = train.map(raw), k = R[0]!.length;
  const mean = Array.from({ length: k }, (_, j) => R.reduce((a, v) => a + v[j]!, 0) / R.length);
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(R.reduce((a, v) => a + (v[j]! - mean[j]!) ** 2, 0) / R.length) || 1);
  const cols = feats.flatMap((f) => (f.missingFlag ? [f.name, `${f.name}_missing`] : [f.name]));
  return { impute, mean, sd, cols, x: (r: Row) => [1, ...raw(r).map((v, j) => (v - mean[j]!) / sd[j]!)] };
}

export function auc(s: number[], y: number[]): number {
  const idx = s.map((_, i) => i).sort((a, b) => s[a]! - s[b]!);
  let neg = 0, num = 0, P = 0, N = 0;
  for (let i = 0; i < idx.length;) {
    let j = i, tp = 0, tn = 0;
    while (j < idx.length && s[idx[j]!] === s[idx[i]!]) { if (y[idx[j++]!]) tp++; else tn++; }
    num += tp * (neg + tn / 2); neg += tn; P += tp; N += tn; i = j;
  }
  return P && N ? num / (P * N) : NaN;
}

export interface Pred { cohort: number; s: number; y: number; cik?: string }
// Top decile within each test cohort (scores aren't comparable across fits).
export function topDecile(pred: Pred[]): number {
  let hits = 0, n = 0;
  for (const c of new Set(pred.map((p) => p.cohort))) {
    const g = pred.filter((p) => p.cohort === c).sort((a, b) => b.s - a.s);
    const top = g.slice(0, Math.ceil(g.length / 10));
    hits += top.reduce((a, p) => a + p.y, 0); n += top.length;
  }
  const base = pred.reduce((a, p) => a + p.y, 0) / pred.length;
  return hits / n / base;
}
// Mean log-loss, for calibration (lower is better).
export const logLoss = (pred: { p: number; y: number }[]) =>
  -pred.reduce((a, { p, y }) => a + (y ? Math.log(Math.max(p, 1e-9)) : Math.log(Math.max(1 - p, 1e-9))), 0) / pred.length;

// Expanding window: each test cohort is predicted by a fit on every earlier one.
export function expanding(rows: Row[], label: string, feats: Feature[], l2: number, cohorts: number[]): Pred[] {
  const pred: Pred[] = [];
  for (const c of cohorts) {
    const train = rows.filter((r) => r.cohort_year < c), test = rows.filter((r) => r.cohort_year === c);
    if (!test.length || !train.some((r) => r[label])) continue;
    const d = designer(train, feats);
    const beta = fit(train.map(d.x), train.map((r) => (r[label] ? 1 : 0)), l2);
    for (const r of test) pred.push({ cohort: c, s: d.x(r).reduce((a, v, j) => a + v * beta[j]!, 0), y: r[label] ? 1 : 0, cik: r.cik });
  }
  return pred;
}
export const summary = (pred: Pred[]) => ({ auc: auc(pred.map((p) => p.s), pred.map((p) => p.y)), top: topDecile(pred), pos: pred.reduce((a, p) => a + p.y, 0) });
