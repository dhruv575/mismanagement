// Takeover-model experiments on backtest_panel: which label, which features.
//
// Labels (all: a deal filing within 12 months of the as-of date):
//   any      -- any deal where the issuer is the one acquired (deal_class)
//   sponsor  -- the buyer is a financial sponsor, sponsor platform, holdco
//               or insider group
//   rollup   -- sponsor-type buyer and an AI-rollup-shaped target
//               (deal_class.rollup_fit >= ROLLUP_FIT)
//
// Evaluation is an expanding window: for each test cohort from 2020 on,
// fit on every earlier cohort and predict that one; AUC and top-decile lift
// are computed on the pooled out-of-sample predictions, which is steadier
// than a single holdout when positives are scarce.
//
// CLI:
//   tsx src/experiment.ts

import { pool } from "./db.js";

const ROLLUP_FIT = 4;
const SPONSOR_TYPES = new Set(["financial_sponsor", "sponsor_platform", "holdco_or_ai_rollup", "management_or_insider"]);
const FIRST_TEST = 2020;
const SHAPE = { services: 6, labor: 5 };

interface Feature { name: string; lo: number; hi: number; log?: boolean; missingFlag?: boolean }
const F = (name: string, lo: number, hi: number, o: Partial<Feature> = {}): Feature => ({ name, lo, hi, missingFlag: true, ...o });

const SIZE = [F("log_float", 18, 28, { missingFlag: false })];
const FLAGS = [
  F("goodwill_to_assets", 0, 1), F("sbc_to_revenue", 0, 0.5), F("ocf_to_net_income", -2, 4),
  F("payouts_to_ocf", 0, 3), F("net_debt_to_ebitda", -5, 10),
  F("has_13d", 0, 1, { missingFlag: false }), F("thirteen_d_count", 0, 10, { log: true, missingFlag: false }),
];
const FUND = [
  F("float_to_book", 0, 30, { log: true }), F("float_change", -0.8, 2), F("revenue_growth", -0.5, 1),
  F("operating_margin", -0.5, 0.5), F("roa", -0.3, 0.3), F("cash_to_assets", 0, 1), F("debt_to_assets", 0, 1),
];
const TEXT = [F("log_employees", 2, 13), F("log_revenue_per_employee", 9, 16), F("ai_per_10k_words", 0, 50, { log: true })];
const BIZ = ["services_share", "labor_intensity", "ai_automatable", "fragmented_market", "recurring_revenue", "rollup_fit"].map((n) => F(`biz_${n}`, 0, 10));

// ---- logistic regression (weighted L2, Newton) ----

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
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
function fit(X: number[][], y: number[], l2: number): number[] {
  const k = X[0]!.length;
  let beta = new Array(k).fill(0);
  for (let iter = 0; iter < 40; iter++) {
    const g = new Array(k).fill(0), H = Array.from({ length: k }, () => new Array(k).fill(0));
    X.forEach((x, i) => {
      const p = sigmoid(x.reduce((a, v, j) => a + v * beta[j], 0)), s = p * (1 - p);
      for (let a = 0; a < k; a++) { g[a] += (y[i]! - p) * x[a]!; for (let b = 0; b <= a; b++) H[a]![b] += s * x[a]! * x[b]!; }
    });
    for (let a = 0; a < k; a++) { for (let b = 0; b < a; b++) H[b]![a] = H[a]![b]; if (a) { g[a] -= l2 * beta[a]; H[a]![a] += l2; } }
    const step = solve(H, g);
    beta = beta.map((v, j) => v + step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return beta;
}

// ---- features ----

type Row = Record<string, any>;
const transform = (f: Feature, v: number) => { const c = Math.min(Math.max(v, f.lo), f.hi); return f.log ? Math.log1p(c) : c; };
const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function designer(train: Row[], feats: Feature[], extra: string[]) {
  const imp = feats.map((f) => { const v = train.map((r) => r[f.name]).filter(ok).map((v) => transform(f, v)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; });
  const raw = (r: Row) => [
    ...feats.flatMap((f, i) => { const v = r[f.name]; const t = ok(v) ? transform(f, v) : imp[i]!; return f.missingFlag ? [t, ok(v) ? 0 : 1] : [t]; }),
    ...extra.map((e) => (r.sic2 === e ? 1 : 0)),
  ];
  const R = train.map(raw), k = R[0]!.length;
  const mean = Array.from({ length: k }, (_, j) => R.reduce((a, v) => a + v[j]!, 0) / R.length);
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(R.reduce((a, v) => a + (v[j]! - mean[j]!) ** 2, 0) / R.length) || 1);
  return (r: Row) => [1, ...raw(r).map((v, j) => (v - mean[j]!) / sd[j]!)];
}

function auc(s: number[], y: number[]): number {
  const idx = s.map((_, i) => i).sort((a, b) => s[a]! - s[b]!);
  let neg = 0, num = 0, P = 0, N = 0;
  for (let i = 0; i < idx.length;) {
    let j = i, tp = 0, tn = 0;
    while (j < idx.length && s[idx[j]!] === s[idx[i]!]) { if (y[idx[j++]!]) tp++; else tn++; }
    num += tp * (neg + tn / 2); neg += tn; P += tp; N += tn; i = j;
  }
  return num / (P * N);
}
// Top decile within each test cohort (scores aren't comparable across fits).
function topDecile(pred: { cohort: number; s: number; y: number }[]): number {
  let hits = 0, n = 0;
  for (const c of new Set(pred.map((p) => p.cohort))) {
    const g = pred.filter((p) => p.cohort === c).sort((a, b) => b.s - a.s);
    const top = g.slice(0, Math.ceil(g.length / 10));
    hits += top.reduce((a, p) => a + p.y, 0); n += top.length;
  }
  const base = pred.reduce((a, p) => a + p.y, 0) / pred.length;
  return hits / n / base;
}

function evaluate(rows: Row[], label: string, feats: Feature[], useSic: boolean, l2: number) {
  const cohorts = [...new Set(rows.map((r) => r.cohort_year as number))].sort();
  const pred: { cohort: number; s: number; y: number }[] = [];
  for (const c of cohorts.filter((c) => c >= FIRST_TEST)) {
    const train = rows.filter((r) => r.cohort_year < c), test = rows.filter((r) => r.cohort_year === c);
    const counts = new Map<string, number>();
    for (const r of train) if (r[label]) counts.set(r.sic2, (counts.get(r.sic2) ?? 0) + 1);
    // Industry dummies only where the training set has positives to learn from.
    const sics = useSic ? [...counts].filter(([s, n]) => s && n >= 3).map(([s]) => s) : [];
    const d = designer(train, feats, sics);
    const beta = fit(train.map(d), train.map((r) => (r[label] ? 1 : 0)), l2);
    for (const r of test) pred.push({ cohort: c, s: d(r).reduce((a, v, j) => a + v * beta[j]!, 0), y: r[label] ? 1 : 0 });
  }
  return { auc: auc(pred.map((p) => p.s), pred.map((p) => p.y)), top: topDecile(pred), pos: pred.reduce((a, p) => a + p.y, 0) };
}

async function main(): Promise<void> {
  const rows = (await pool.query(`
    select p.*, k.employees, k.word_count, k.ai_term_count,
           ${BIZ.map((f) => `b.${f.name.slice(4)} as ${f.name}`).join(", ")},
           c.buyer_type, c.issuer_acquired as cls_acquired, c.rollup_fit as deal_fit, c.services_business as deal_services
      from backtest_panel p
      left join panel_10k k using (cik, cohort_year)
      left join business_score b on b.cik = p.cik
      left join deal_class c on c.accession_number = p.event_accession`)).rows;
  for (const r of rows) {
    r.sic2 = r.sic ? String(r.sic).padStart(4, "0").slice(0, 2) : "";
    r.log_float = Math.log(r.public_float);
    r.has_13d = r.thirteen_d_count > 0 ? 1 : 0;
    r.log_employees = r.employees > 0 ? Math.log(r.employees) : null;
    r.log_revenue_per_employee = r.employees > 0 ? Math.log(r.revenue / r.employees) : null;
    r.ai_per_10k_words = r.word_count > 0 ? (r.ai_term_count / r.word_count) * 1e4 : null;
    const real = r.target && r.cls_acquired !== false && r.buyer_type !== null;
    r.any = real || (r.target && r.buyer_type === null); // unclassified targets stay in "any"
    r.sponsor = real && SPONSOR_TYPES.has(r.buyer_type);
    r.rollup = r.sponsor && r.deal_fit >= ROLLUP_FIT;
    r.sponsor_services = r.sponsor && r.deal_services === true;
  }
  const pos = (k: string) => rows.filter((r) => r[k]).length;
  console.log(`${rows.length} company-years; positives: any ${pos("any")}, sponsor ${pos("sponsor")}, rollup ${pos("rollup")}`);
  console.log(`text coverage ${rows.filter((r) => r.employees > 0).length}, business scores ${rows.filter((r) => ok(r.biz_rollup_fit)).length}`);

  const sets: [string, Feature[], boolean][] = [
    ["size only", SIZE, false],
    ["size + flags", [...SIZE, ...FLAGS], false],
    ["+ industry", [...SIZE, ...FLAGS], true],
    ["+ fundamentals", [...SIZE, ...FLAGS, ...FUND], true],
    ["+ 10-K text", [...SIZE, ...FLAGS, ...TEXT], true],
    ["+ business scores", [...SIZE, ...FLAGS, ...TEXT, ...BIZ], true],
    ["size + business + text", [...SIZE, ...TEXT, ...BIZ], false],
    ["everything", [...SIZE, ...FLAGS, ...FUND, ...TEXT, ...BIZ], true],
    ["lean: size+goodwill+13D+business", [...SIZE, FLAGS[0]!, FLAGS[5]!, ...BIZ], true],
    ["lean, no industry", [...SIZE, FLAGS[0]!, FLAGS[5]!, ...BIZ], false],
  ];
  // AI-rollup-shaped universe, from each company's own pre-deal 10-K.
  const shaped = rows.filter((r) => r.biz_services_share >= SHAPE.services && r.biz_labor_intensity >= SHAPE.labor);
  console.log(`rollup-shaped universe (services >= ${SHAPE.services}, labor >= ${SHAPE.labor}): ${shaped.length} company-years, ` +
    `${shaped.filter((r) => r.sponsor).length} sponsor buyouts, ${shaped.filter((r) => r.any).length} deals of any kind`);
  const runs: [string, Row[], string][] = [["any", rows, "any"], ["sponsor", rows, "sponsor"],
    ["sponsor buyout of a services business", rows, "sponsor_services"], ["sponsor, rollup-shaped universe", shaped, "sponsor"], ["any deal, rollup-shaped universe", shaped, "any"]];
  for (const [title, data, label] of runs) {
    const l2 = data === shaped || label === "sponsor_services" ? 8 : 2;
    const out = sets.map(([name, f, sic]) => {
      const m = evaluate(data, label, f, sic, l2);
      return { features: name, auc: m.auc.toFixed(3), top_decile: `${m.top.toFixed(2)}x`, test_positives: m.pos };
    });
    console.log(`\nlabel: ${label}`); console.table(out);
  }
  await pool.end();
}

await main();
