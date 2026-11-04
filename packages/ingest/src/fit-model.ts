// Logistic regression on the point-in-time backtest panel: the probability
// that a company gets a deal filing in the next 12 months, from the measures
// behind the signals rather than their yes/no thresholds.
//
// Two fits:
//   panel  -- every company-year in backtest_panel, financial and 13D
//             measures plus size.
//   text   -- the backtest_text sample, adding AI mentions and revenue per
//             employee, weighted so controls stand for the whole cohort.
//
// Each is trained on the earlier cohorts and tested on the last two
// (out-of-time), against the count-of-signals score as a baseline, then
// refit on all cohorts. Coefficients and metrics go to takeover_model.
//
// Measures are clipped to the ranges below, standardized, and missing
// values are imputed at the training mean with a "missing" indicator.
//
// CLI:
//   tsx src/fit-model.ts

import { pool } from "./db.js";

interface Feature { name: string; lo: number; hi: number; log?: boolean; missingFlag?: boolean }

const PANEL_FEATURES: Feature[] = [
  { name: "log_float", lo: 18, hi: 28 },
  { name: "goodwill_to_assets", lo: 0, hi: 1, missingFlag: true },
  { name: "sbc_to_revenue", lo: 0, hi: 0.5, missingFlag: true },
  { name: "ocf_to_net_income", lo: -2, hi: 4, missingFlag: true },
  { name: "payouts_to_ocf", lo: 0, hi: 3, missingFlag: true },
  { name: "net_debt_to_ebitda", lo: -5, hi: 10, missingFlag: true },
  { name: "has_13d", lo: 0, hi: 1 },
  { name: "thirteen_d_count", lo: 0, hi: 10, log: true },
];
// Takeover-specific additions: valuation (float vs book), a momentum proxy
// (change in public float, which is mostly price), growth and profitability.
const FUNDAMENTALS: Feature[] = [
  { name: "float_to_book", lo: 0, hi: 30, log: true, missingFlag: true },
  { name: "float_change", lo: -0.8, hi: 2, missingFlag: true },
  { name: "revenue_growth", lo: -0.5, hi: 1, missingFlag: true },
  { name: "operating_margin", lo: -0.5, hi: 0.5, missingFlag: true },
  { name: "roa", lo: -0.3, hi: 0.3, missingFlag: true },
  { name: "cash_to_assets", lo: 0, hi: 1, missingFlag: true },
  { name: "debt_to_assets", lo: 0, hi: 1, missingFlag: true },
];
// Deal rate in the company's 2-digit SIC over the prior three cohorts,
// shrunk toward the overall rate.
const HEAT: Feature[] = [{ name: "industry_heat", lo: 0, hi: 0.25, missingFlag: true }];
const MIN_SIC2_ROWS = 150;
const TEXT_FEATURES: Feature[] = [
  ...PANEL_FEATURES,
  { name: "ai_per_10k_words", lo: 0, hi: 50, log: true, missingFlag: true },
  { name: "log_revenue_per_employee", lo: 9, hi: 16, missingFlag: true },
];
const TEST_COHORTS = 2;
const L2 = 1.0;

interface Obs { y: number; w: number; cohort: number; score: number; x: Record<string, number | null> }

// ---- design matrix ----

interface Prep { cols: string[]; mean: number[]; sd: number[]; impute: Record<string, number> }

function prepare(rows: Obs[], feats: Feature[]): Prep {
  const impute: Record<string, number> = {};
  for (const f of feats) {
    const vals = rows.map((r) => r.x[f.name]).filter((v): v is number => v != null && Number.isFinite(v)).map((v) => transform(f, v));
    impute[f.name] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  const cols = feats.flatMap((f) => (f.missingFlag ? [f.name, `${f.name}_missing`] : [f.name]));
  const raw = rows.map((r) => rowVector(r, feats, impute));
  const mean = cols.map((_, j) => raw.reduce((a, v) => a + v[j]!, 0) / raw.length);
  const sd = cols.map((_, j) => Math.sqrt(raw.reduce((a, v) => a + (v[j]! - mean[j]!) ** 2, 0) / raw.length) || 1);
  return { cols, mean, sd, impute };
}

function transform(f: Feature, v: number): number {
  const c = Math.min(Math.max(v, f.lo), f.hi);
  return f.log ? Math.log1p(c) : c;
}

function rowVector(r: Obs, feats: Feature[], impute: Record<string, number>): number[] {
  return feats.flatMap((f) => {
    const v = r.x[f.name];
    const ok = v != null && Number.isFinite(v);
    const t = ok ? transform(f, v) : impute[f.name]!;
    return f.missingFlag ? [t, ok ? 0 : 1] : [t];
  });
}

const design = (rows: Obs[], feats: Feature[], p: Prep) =>
  rows.map((r) => [1, ...rowVector(r, feats, p.impute).map((v, j) => (v - p.mean[j]!) / p.sd[j]!)]);

// ---- weighted L2 logistic regression (Newton / IRLS) ----

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

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function fit(X: number[][], y: number[], w: number[]): { beta: number[]; se: number[] } {
  const k = X[0]!.length;
  let beta = new Array(k).fill(0);
  let H: number[][] = [];
  for (let iter = 0; iter < 50; iter++) {
    const g = new Array(k).fill(0);
    H = Array.from({ length: k }, () => new Array(k).fill(0));
    X.forEach((x, i) => {
      const p = sigmoid(x.reduce((a, v, j) => a + v * beta[j], 0));
      const r = w[i]! * (y[i]! - p), s = w[i]! * p * (1 - p);
      for (let a = 0; a < k; a++) {
        g[a] += r * x[a]!;
        for (let b = 0; b <= a; b++) H[a]![b]! += s * x[a]! * x[b]!;
      }
    });
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < a; b++) H[b]![a] = H[a]![b]!;
      if (a > 0) { g[a] -= L2 * beta[a]; H[a]![a]! += L2; } // intercept unpenalized
    }
    const step = solve(H, g);
    beta = beta.map((v, j) => v + step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  // Robust (sandwich) standard errors, H^-1 B H^-1 with B the outer product
  // of the per-row scores: correct for sampling weights, unlike H^-1 alone.
  const Hinv = beta.map((_, j) => solve(H, beta.map((_, i) => (i === j ? 1 : 0))));
  const B = Array.from({ length: k }, () => new Array(k).fill(0));
  X.forEach((x, i) => {
    const r = w[i]! * (y[i]! - sigmoid(x.reduce((a, v, j) => a + v * beta[j], 0)));
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) B[a]![b] += r * r * x[a]! * x[b]!;
  });
  const se = beta.map((_, j) => {
    let v = 0;
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) v += Hinv[j]![a]! * B[a]![b]! * Hinv[j]![b]!;
    return Math.sqrt(Math.max(0, v));
  });
  return { beta, se };
}

// Weighted AUC: probability a random deal outranks a random non-deal.
function auc(scores: number[], y: number[], w: number[]): number {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let negBelow = 0, num = 0, pos = 0, neg = 0;
  for (let i = 0; i < idx.length;) {
    let j = i, tp = 0, tn = 0;
    while (j < idx.length && scores[idx[j]!] === scores[idx[i]!]) { const t = idx[j++]!; if (y[t]) tp += w[t]!; else tn += w[t]!; }
    num += tp * (negBelow + tn / 2);
    negBelow += tn; pos += tp; neg += tn;
    i = j;
  }
  return pos && neg ? num / (pos * neg) : NaN;
}

// Deal rate in the top decile by predicted probability, as a multiple of the base rate.
function topDecileLift(scores: number[], y: number[], w: number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]!);
  const total = w.reduce((a, b) => a + b, 0), cut = total / 10;
  let acc = 0, hits = 0, wt = 0;
  for (const i of idx) { if (acc >= cut) break; acc += w[i]!; wt += w[i]!; hits += w[i]! * y[i]!; }
  const base = y.reduce((a, v, i) => a + v * w[i]!, 0) / total;
  return hits / wt / base;
}

async function run(id: string, rows: Obs[], feats: Feature[], store = true) {
  const cohorts = [...new Set(rows.map((r) => r.cohort))].sort();
  const testFrom = cohorts[cohorts.length - TEST_COHORTS]!;
  const train = rows.filter((r) => r.cohort < testFrom), test = rows.filter((r) => r.cohort >= testFrom);

  const pTrain = prepare(train, feats);
  const m = fit(design(train, feats, pTrain), train.map((r) => r.y), train.map((r) => r.w));
  const Xt = design(test, feats, pTrain);
  const pred = Xt.map((x) => x.reduce((a, v, j) => a + v * m.beta[j]!, 0));
  const yt = test.map((r) => r.y), wt = test.map((r) => r.w);
  // The count score has many ties: AUC counts ties as half; the top decile
  // breaks them at random so it isn't flattered by row order.
  const metrics = {
    train_cohorts: `${cohorts[0]}-${testFrom - 1}`, test_cohorts: `${testFrom}-${cohorts[cohorts.length - 1]}`,
    train_n: train.length, test_n: test.length, test_deals: yt.reduce((a, b) => a + b, 0),
    auc_model: auc(pred, yt, wt), auc_score: auc(test.map((r) => r.score), yt, wt),
    top_decile_lift_model: topDecileLift(pred, yt, wt), top_decile_lift_score: topDecileLift(test.map((r) => r.score + 1e-6 * Math.random()), yt, wt),
  };

  if (!store) return metrics;
  const pAll = prepare(rows, feats);
  const all = fit(design(rows, feats, pAll), rows.map((r) => r.y), rows.map((r) => r.w));
  const coefficients = ["intercept", ...pAll.cols].map((name, j) => ({
    name, coef: all.beta[j]!, se: all.se[j]!, z: all.beta[j]! / all.se[j]!,
    mean: j ? pAll.mean[j - 1]! : null, sd: j ? pAll.sd[j - 1]! : null,
  }));
  await pool.query(
    `insert into takeover_model (id, fitted_at, features, metrics, coefficients, impute) values ($1, now(), $2, $3, $4, $5)
     on conflict (id) do update set fitted_at = now(), features = excluded.features, metrics = excluded.metrics,
       coefficients = excluded.coefficients, impute = excluded.impute`,
    [id, JSON.stringify(feats), JSON.stringify(metrics), JSON.stringify(coefficients), JSON.stringify(pAll.impute)],
  );

  console.log(`\n== ${id}: ${rows.length} rows ==`);
  console.log(`out-of-time test ${metrics.test_cohorts} (${metrics.test_n} rows, ${metrics.test_deals} deals): ` +
    `AUC model ${metrics.auc_model.toFixed(3)} vs score ${metrics.auc_score.toFixed(3)}; ` +
    `top-decile lift model ${metrics.top_decile_lift_model.toFixed(2)}x vs score ${metrics.top_decile_lift_score.toFixed(2)}x`);
  console.table(coefficients.map((c) => ({ feature: c.name, coef: c.coef.toFixed(3), z: c.z.toFixed(1), odds_per_sd: Math.exp(c.coef).toFixed(2) })));
  return metrics;
}

async function main(): Promise<void> {
  await pool.query(`create table if not exists takeover_model (
    id text primary key, fitted_at timestamptz not null, features jsonb not null,
    metrics jsonb not null, coefficients jsonb not null, impute jsonb not null)`);

  const panel = (await pool.query(
    `select p.*, t.weight, t.word_count, t.ai_term_count, t.employees, t.cik is not null as sampled
       from backtest_panel p left join backtest_text t using (cik, cohort_year)`,
  )).rows;
  const base = (r: Record<string, any>) => ({
    log_float: Math.log(r.public_float),
    goodwill_to_assets: r.goodwill_to_assets, sbc_to_revenue: r.sbc_to_revenue, ocf_to_net_income: r.ocf_to_net_income,
    payouts_to_ocf: r.payouts_to_ocf, net_debt_to_ebitda: r.net_debt_to_ebitda,
    has_13d: r.thirteen_d_count > 0 ? 1 : 0, thirteen_d_count: r.thirteen_d_count,
    ...Object.fromEntries(FUNDAMENTALS.map((f) => [f.name, r[f.name]])),
    industry_heat: heat(r),
    ...Object.fromEntries(sic2s.map((s) => [`sic_${s}`, r.sic2 === s ? 1 : 0])),
  });

  // Industry heat, from cohorts whose labels had resolved by this as-of date
  // (cohort Y-1's 12-month window ends on cohort Y's as-of date).
  for (const r of panel) r.sic2 = r.sic ? String(r.sic).padStart(4, "0").slice(0, 2) : null;
  const overall = panel.reduce((a, r) => a + (r.target ? 1 : 0), 0) / panel.length;
  const bySicYear = new Map<string, { n: number; d: number }>();
  for (const r of panel) {
    if (!r.sic2) continue;
    const key = `${r.sic2}:${r.cohort_year}`, v = bySicYear.get(key) ?? { n: 0, d: 0 };
    v.n++; if (r.target) v.d++; bySicYear.set(key, v);
  }
  const heat = (r: Record<string, any>): number | null => {
    if (!r.sic2) return null;
    let n = 0, d = 0;
    for (let y = r.cohort_year - 3; y < r.cohort_year; y++) { const v = bySicYear.get(`${r.sic2}:${y}`); if (v) { n += v.n; d += v.d; } }
    return n ? (d + 20 * overall) / (n + 20) : null;
  };
  const counts = new Map<string, number>();
  for (const r of panel) if (r.sic2) counts.set(r.sic2, (counts.get(r.sic2) ?? 0) + 1);
  const sic2s = [...counts].filter(([, n]) => n >= MIN_SIC2_ROWS).map(([s]) => s).sort();
  const SIC_FEATURES: Feature[] = sic2s.map((s) => ({ name: `sic_${s}`, lo: 0, hi: 1 }));
  const s = await pool.query(`select count(*) filter (where coalesce(sic,'') <> '')::int have, count(*)::int n from backtest_panel`);
  console.log(`sic on ${s.rows[0].have}/${s.rows[0].n} rows; ${sic2s.length} industries with ${MIN_SIC2_ROWS}+ rows get their own effect`);

  const obs = panel.map((r) => ({ y: r.target ? 1 : 0, w: 1, cohort: r.cohort_year, score: r.score, x: base(r) }));
  const variants: [string, Feature[]][] = [
    ["flags (current)", PANEL_FEATURES],
    ["+ fundamentals", [...PANEL_FEATURES, ...FUNDAMENTALS]],
    ["+ industry", [...PANEL_FEATURES, ...HEAT, ...SIC_FEATURES]],
    ["+ both", [...PANEL_FEATURES, ...FUNDAMENTALS, ...HEAT, ...SIC_FEATURES]],
  ];
  const cmp = [];
  for (const [name, feats] of variants) {
    const m = await run(name, obs, feats, false);
    cmp.push({ model: name, auc: m.auc_model.toFixed(3), top_decile: `${m.top_decile_lift_model.toFixed(2)}x`, score_auc: m.auc_score.toFixed(3) });
  }
  console.log("\nout-of-time comparison (same test cohorts):"); console.table(cmp);
  const FULL = [...PANEL_FEATURES, ...FUNDAMENTALS, ...HEAT, ...SIC_FEATURES];
  await run("panel", obs, FULL);
  await run("text", panel.filter((r) => r.sampled && r.word_count > 0).map((r) => ({
    y: r.target ? 1 : 0, w: r.weight, cohort: r.cohort_year, score: r.score,
    x: {
      ...base(r),
      ai_per_10k_words: (r.ai_term_count / r.word_count) * 1e4,
      log_revenue_per_employee: r.employees > 0 ? Math.log(r.revenue / r.employees) : null,
    },
  })), [...TEXT_FEATURES, ...FUNDAMENTALS, ...HEAT, ...SIC_FEATURES]);
  await pool.end();
}

await main();
