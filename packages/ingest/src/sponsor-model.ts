// The two takeover models behind the site, both fit on backtest_panel with
// business factors that Jev (TypeSafe's decision model, via AI Gateway) read
// from each company's 10-K Item 1 (factors.ts, score-factors.ts).
//
//   pe       (devil side) -- P(a financial sponsor, sponsor-backed platform,
//            holdco or insider group buys the company within 12 months).
//            Logistic on size, goodwill, 13D, the six AI-rollup factors plus
//            contracted revenue and regulation. 144 positives.
//   sponsor  (angel side) -- P(that buyer is buying a services business), the
//            historical analog of an AI-rollup deal. Two-stage: the PE
//            probability times Jev's services share, Platt-calibrated on the
//            33 sponsor buyouts of services businesses. Fitting it directly
//            on 33 noisy positives did no better (experiment2.ts), and half
//            of those positives (telecoms, railroads, casinos) are not what an
//            AI rollup buys; the two-stage score ranks the 13 people-heavy
//            ones (labor_intensive) best of everything tried.
//
// Backtest numbers are expanding-window (fit on earlier cohorts, test on
// each of 2020-2024) and are stored with each model for the site.
//
// Steps (run in order; each is rerunnable):
//   tsx src/sponsor-model.ts --fit        fit both models, store in takeover_model
//   tsx src/sponsor-model.ts --score-10k  read each current company's latest 10-K and score it with Jev
//   tsx src/sponsor-model.ts --apply      write sponsor_scores and pe_scores for the current universe
//   tsx src/sponsor-model.ts              all three (--score-10k only reads what's new)

import { pool } from "./db.js";
import { LLM_MODEL } from "./env.js";
import { FACTORS, JEV } from "./factors.js";
import { decideFactors } from "./jev.js";
import { callLLM } from "./llm.js";
import { auc, designer, expanding, F, fit, ok, sigmoid, summary, topDecile, type Feature, type Row } from "./logit.js";
import { ensureTable as ensureText, LONG_CHARS, secText } from "./pull-business-text.js";
import { businessExcerpt } from "./pull-panel-10k.js";
import { ensureTable as ensureFactors } from "./score-factors.js";
import { BUSINESS_SCORES } from "./score-business.js";
import { htmlToText } from "./text-signals.js";

const SPONSOR_TYPES = ["financial_sponsor", "sponsor_platform", "holdco_or_ai_rollup", "management_or_insider"];
const OUTER = [2020, 2021, 2022, 2023, 2024];
// Visible flags on the site (sponsor-buyout rate well above base when set).
export const RECURRING_MIN = 7;
export const ROLLUP_SHAPE_MIN = 5;

const j = (n: string) => F(`j_${n}`, 0, 10, { missingFlag: false });
export const PE_FEATURES: Feature[] = [
  // Clipped to the training range: the panel starts at $500M of float.
  F("log_float", Math.log(500e6), 28, { missingFlag: false }),
  F("goodwill_to_assets", 0, 1),
  F("has_13d", 0, 1, { missingFlag: false }),
  ...[...BUSINESS_SCORES, "contracted", "regulated"].map(j),
  F("jev_missing", 0, 1, { missingFlag: false }),
];
const PE_L2 = 5;
// Angel side: services share, as a probability, sharpens the PE score.
const SHAPE = "services_share";
// Squared: on the people-heavy buyouts this ranked best (experiment2.ts),
// and it keeps software with sky-high take-private odds (Grindr, SailPoint)
// from passing as AI-rollup targets.
const SHAPE_POWER = 2;
const shapeOf = (r: Row) => Math.min(Math.max((r[`j_${SHAPE}`] ?? 1) / 10, 0.01), 0.99) ** SHAPE_POWER;

interface Stored {
  features: Feature[]; impute: number[]; mean: number[]; sd: number[]; beta: number[]; base_rate: number;
  platt?: [number, number]; shape?: string; bands?: Band[];
}
// The multiple a company shows is the lift its rank band achieved out of
// sample: companies ranked in the same top-N% of their cohort, 2020-2024.
interface Band { top: number; n: number; deals: number; lift: number }
const BAND_TOPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1];
const PRIOR = 60; // pseudo-companies at the base rate, so sparse bands shrink toward 1x
function bandsFrom(pred: { cohort: number; s: number; y: number }[]): Band[] {
  // Each prediction's rank within its own cohort, 0 = top.
  const ranked = [...new Set(pred.map((p) => p.cohort))].flatMap((c) => {
    const g = pred.filter((p) => p.cohort === c).sort((a, b) => b.s - a.s);
    return g.map((p, i) => ({ q: i / g.length, y: p.y }));
  });
  const base = ranked.reduce((a, p) => a + p.y, 0) / ranked.length;
  let lo = 0;
  const bands = BAND_TOPS.map((top) => {
    const xs = ranked.filter((p) => p.q >= lo && p.q < top); lo = top;
    const deals = xs.reduce((a, p) => a + p.y, 0);
    return { top, n: xs.length, deals, lift: (deals + PRIOR * base) / (xs.length + PRIOR) / base };
  });
  // Never rank-inverted: a higher band is at least as likely as the one below.
  for (let i = bands.length - 2; i >= 0; i--) bands[i]!.lift = Math.max(bands[i]!.lift, bands[i + 1]!.lift);
  return bands;
}
// Smooth in rank: log-lift interpolated between band midpoints (on log rank).
function bandLift(bands: Band[], pct: number): number {
  const t = Math.max(1 - pct, 0.0005);
  const pts = bands.map((b, i) => ({ x: Math.log(((i ? bands[i - 1]!.top : 0) + b.top) / 2), y: Math.log(b.lift) }));
  const x = Math.log(t);
  if (x <= pts[0]!.x) return Math.exp(pts[0]!.y);
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i]!.x) { const a = pts[i - 1]!, b = pts[i]!; return Math.exp(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y)); }
  }
  return Math.exp(pts.at(-1)!.y);
}

// The stored model's design: same transform as logit.designer, from saved stats.
const design = (m: Stored) => (r: Row) => {
  const raw = m.features.flatMap((f, i) => {
    const v = r[f.name];
    // impute is stored already transformed (logit.designer).
    const c = ok(v) ? Math.min(Math.max(v, f.lo), f.hi) : 0;
    const tt = ok(v) ? (f.log ? Math.log1p(c) : c) : m.impute[i]!;
    return f.missingFlag ? [tt, ok(v) ? 0 : 1] : [tt];
  });
  return [1, ...raw.map((v, k) => (v - m.mean[k]!) / m.sd[k]!)];
};
const linear = (m: Stored, r: Row) => design(m)(r).reduce((a, v, k) => a + v * m.beta[k]!, 0);
// Both models map their score to a probability with a Platt fit on the
// out-of-sample backtest predictions, so "N times average" is not inflated
// by in-sample overfitting.
export const predictPE = (m: Stored, r: Row) => (m.platt ? sigmoid(m.platt[0] + m.platt[1] * linear(m, r)) : sigmoid(linear(m, r)));
export const predictSponsor = (pe: Stored, s: Stored, r: Row) => sigmoid(s.platt![0] + s.platt![1] * (linear(pe, r) + Math.log(shapeOf(r))));

// Jev factors onto a row as j_<name>; missing when the 10-K had no excerpt.
function withFactors(r: Row, scores: Record<string, number> | null): Row {
  for (const f of FACTORS) r[`j_${f.name}`] = scores?.[f.name] ?? null;
  r.jev_missing = scores ? 0 : 1;
  return r;
}

async function loadPanel(): Promise<Row[]> {
  const rows = (await pool.query(`
    select p.cik, p.cohort_year, p.public_float, p.goodwill_to_assets, p.thirteen_d_count, fs.scores,
           coalesce(p.target and c.issuer_acquired and c.buyer_type = any($1), false) as pe,
           coalesce(p.target and c.issuer_acquired and c.services_business and c.buyer_type = any($1), false) as sponsor,
           coalesce(p.target and c.issuer_acquired and c.services_business and c.labor_intensive and c.buyer_type = any($1), false) as sponsor_strict
      from backtest_panel p
      left join factor_score fs on fs.cik = p.cik and fs.kind = 'panel'
      left join deal_class c on c.accession_number = p.event_accession`, [SPONSOR_TYPES])).rows;
  return rows.map((r) => withFactors({ ...r, log_float: Math.log(r.public_float), has_13d: r.thirteen_d_count > 0 ? 1 : 0 }, r.scores));
}

function fitStored(rows: Row[], label: string, feats: Feature[], l2: number): Stored {
  const d = designer(rows, feats);
  const y: number[] = rows.map((r) => (r[label] ? 1 : 0));
  const beta = fit(rows.map(d.x), y, l2);
  return { features: feats, impute: d.impute, mean: d.mean, sd: d.sd, beta, base_rate: y.reduce((a, b) => a + b, 0) / y.length };
}

// Platt scaling: P(y) = sigmoid(a + b*s), two parameters, Newton.
function platt(s: number[], y: number[]): [number, number] {
  const X = s.map((v) => [1, v]);
  const b = fit(X, y, 0);
  return [b[0]!, b[1]!];
}

async function save(id: string, m: Stored, metrics: Record<string, unknown>, cols: string[]): Promise<void> {
  await pool.query(
    `insert into takeover_model (id, fitted_at, features, metrics, coefficients, impute) values ($5, now(), $1, $2, $3, $4)
     on conflict (id) do update set fitted_at = now(), features = excluded.features, metrics = excluded.metrics,
       coefficients = excluded.coefficients, impute = excluded.impute`,
    [JSON.stringify(m), JSON.stringify(metrics),
      JSON.stringify(["intercept", ...cols].map((name, k) => ({ name, coef: m.beta[k], odds_per_sd: Math.exp(m.beta[k]!) }))),
      JSON.stringify(m.impute), id],
  );
}

// Every Jev factor's plain evidence for a label: how often companies that
// scored high (7+) went on to the outcome, against everyone, and whether the
// model uses it. Descriptive (in-sample), for the site's model pages.
function evidence(rows: Row[], label: string) {
  const scored = rows.filter((r) => !r.jev_missing);
  const base = scored.filter((r) => r[label]).length / scored.length;
  const used = new Set(PE_FEATURES.map((f) => f.name));
  return FACTORS.map((f) => {
    const hi = scored.filter((r) => (r[`j_${f.name}`] ?? 0) >= 7), lo = scored.filter((r) => (r[`j_${f.name}`] ?? 10) < 3);
    const rate = (xs: Row[]) => (xs.length ? xs.filter((r) => r[label]).length / xs.length : null);
    return {
      name: f.name, label: f.label, group: f.group, in_model: used.has(`j_${f.name}`) || (label === "sponsor" && f.name === SHAPE),
      n_high: hi.length, deals_high: hi.filter((r) => r[label]).length, lift_high: rate(hi) == null ? null : rate(hi)! / base,
      n_low: lo.length, lift_low: rate(lo) == null ? null : rate(lo)! / base,
    };
  });
}

async function fitModels(): Promise<void> {
  const rows = await loadPanel();
  const cols = PE_FEATURES.flatMap((f) => (f.missingFlag ? [f.name, `${f.name}_missing`] : [f.name]));
  const count = (k: string) => rows.filter((r) => r[k]).length;

  // ---- pe ----
  const pe = fitStored(rows, "pe", PE_FEATURES, PE_L2);
  const peOut = expanding(rows, "pe", PE_FEATURES, PE_L2, OUTER);
  const peBT = summary(peOut);
  pe.platt = platt(peOut.map((p) => p.s), peOut.map((p) => p.y));
  pe.bands = bandsFrom(peOut);
  console.table(pe.bands.map((b) => ({ top: `${b.top * 100}%`, n: b.n, deals: b.deals, lift: b.lift.toFixed(2) })));
  const peMetrics = {
    rows: rows.length, positives: count("pe"), base_rate: pe.base_rate, model: JEV, factors: evidence(rows, "pe"),
    backtest: { auc: peBT.auc, top_decile: peBT.top, test_positives: peBT.pos, auc_2024: summary(peOut.filter((p) => p.cohort === 2024)).auc, first: OUTER[0], last: OUTER.at(-1) },
  };
  await save("pe", pe, peMetrics, cols);
  console.log(`fit pe: ${rows.length} company-years, ${count("pe")} sponsor buyouts; backtest AUC ${peBT.auc.toFixed(3)}, top decile ${peBT.top.toFixed(2)}x`);
  console.table(["intercept", ...cols].map((name, k) => ({ name, odds_per_sd: Math.exp(pe.beta[k]!).toFixed(2) })));

  // ---- sponsor (two-stage) ----
  // Backtest: the PE fit's out-of-sample scores, times the shape; the Platt
  // fit for the live score is made on these same out-of-sample scores.
  const byKey = new Map(peOut.map((p) => [`${p.cik}:${p.cohort}`, p.s]));
  const test = rows.filter((r) => byKey.has(`${r.cik}:${r.cohort_year}`));
  const ab = platt(test.map((r) => byKey.get(`${r.cik}:${r.cohort_year}`)! + Math.log(shapeOf(r))), test.map((r) => (r.sponsor ? 1 : 0)));
  const sponsor: Stored = { ...pe, platt: ab, base_rate: count("sponsor") / rows.length, shape: SHAPE };
  const twoStage = (label: string) => {
    const pred = test.map((r) => ({ cohort: r.cohort_year as number, s: byKey.get(`${r.cik}:${r.cohort_year}`)! + Math.log(shapeOf(r)), y: r[label] ? 1 : 0 }));
    return { auc: auc(pred.map((p) => p.s), pred.map((p) => p.y)), top_decile: topDecile(pred), test_positives: pred.reduce((a, p) => a + p.y, 0) };
  };
  const bt = twoStage("sponsor"), strict = twoStage("sponsor_strict");
  sponsor.bands = bandsFrom(test.map((r) => ({ cohort: r.cohort_year as number, s: byKey.get(`${r.cik}:${r.cohort_year}`)! + Math.log(shapeOf(r)), y: r.sponsor ? 1 : 0 })));
  console.table(sponsor.bands.map((b) => ({ top: `${b.top * 100}%`, n: b.n, deals: b.deals, lift: b.lift.toFixed(2) })));
  await save("sponsor", sponsor, {
    rows: rows.length, positives: count("sponsor"), base_rate: sponsor.base_rate, model: JEV, shape: SHAPE, factors: evidence(rows, "sponsor"),
    backtest: { ...bt, first: OUTER[0], last: OUTER.at(-1), strict: { ...strict, positives: count("sponsor_strict") } },
  }, cols);
  console.log(`fit sponsor (two-stage): ${count("sponsor")} services buyouts; backtest AUC ${bt.auc.toFixed(3)}, top decile ${bt.top_decile.toFixed(2)}x; ` +
    `people-heavy only (${count("sponsor_strict")}): AUC ${strict.auc.toFixed(3)}, top decile ${strict.top_decile.toFixed(2)}x; platt ${ab.map((v) => v.toFixed(3)).join(", ")}; pe platt ${pe.platt!.map((v) => v.toFixed(3)).join(", ")}`);
}

// ---- current 10-Ks ----

const SUMMARY_PROMPT = `Describe what this company does in under 15 words, from its 10-K Business section. Plain words, no marketing. Return JSON: {"summary": string}`;

async function score10k(concurrency = 12): Promise<void> {
  await ensureText(); await ensureFactors();
  await pool.query(`create table if not exists current_business (
    cik text primary key, accession_number text, filing_date date, model text,
    ${BUSINESS_SCORES.map((s) => `${s} real`).join(", ")}, summary text, scored_at timestamptz not null default now())`);
  await pool.query(`alter table current_business add column if not exists factors jsonb`);
  const ciks = (await pool.query<{ cik: string; accession_number: string | null; scored: boolean; has_summary: boolean }>(
    `select t.cik, bt.accession_number, fs.cik is not null as scored, cb.summary is not null as has_summary
       from takeover_scores t left join business_text bt on bt.cik = t.cik and bt.kind = 'current'
       left join factor_score fs on fs.cik = t.cik and fs.kind = 'current' and fs.accession_number = bt.accession_number
       left join current_business cb on cb.cik = t.cik`)).rows;
  console.log(`score-10k: checking ${ciks.length} companies for a new 10-K`);
  let cursor = 0, done = 0, scored = 0, failed = 0;
  const worker = async (): Promise<void> => {
    while (cursor < ciks.length) {
      const c = ciks[cursor++]!;
      try {
        const sub = await secText(`https://data.sec.gov/submissions/CIK${c.cik}.json`);
        const r = sub ? (JSON.parse(sub) as { filings: { recent: { form: string[]; accessionNumber: string[]; filingDate: string[]; primaryDocument: string[] } } }).filings.recent : null;
        const i = r ? r.form.findIndex((f) => f === "10-K") : -1;
        if (!r || i < 0 || (r.accessionNumber[i] === c.accession_number && c.scored)) continue;
        const acc = r.accessionNumber[i]!, date = r.filingDate[i]!;
        let text: string | null = null;
        if (acc === c.accession_number) {
          text = (await pool.query(`select text from business_text where cik = $1 and kind = 'current'`, [c.cik])).rows[0]?.text ?? null;
        } else {
          const html = await secText(`https://www.sec.gov/Archives/edgar/data/${Number(c.cik)}/${acc.replace(/-/g, "")}/${r.primaryDocument[i]}`);
          text = html ? businessExcerpt(htmlToText(html), LONG_CHARS) : null;
          await pool.query(
            `insert into business_text (cik, kind, accession_number, filing_date, text) values ($1,'current',$2,$3,$4)
             on conflict (cik, kind) do update set accession_number = excluded.accession_number, filing_date = excluded.filing_date, text = excluded.text, fetched_at = now()`,
            [c.cik, acc, date, text]);
        }
        if (!text) continue;
        await scoreCurrent(c.cik, acc, date, text, acc !== c.accession_number || !c.has_summary);
        scored++;
      } catch (e) {
        failed++;
        console.error(`  ${c.cik} FAILED: ${e instanceof Error ? e.message : e}`);
      } finally {
        if (++done % 500 === 0 || done === ciks.length) console.log(`  ${done}/${ciks.length} (${scored} scored, ${failed} failed)`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// Jev factors into factor_score and current_business (the six columns the
// site shows, plus every factor as JSON). A one-line summary comes from the
// cheap text model when the filing is new or none exists yet.
export async function scoreCurrent(cik: string, acc: string, date: string | null, text: string, summarize: boolean): Promise<void> {
  const { scores } = await decideFactors(text, FACTORS);
  await pool.query(
    `insert into factor_score (cik, kind, model, accession_number, scores, source) values ($1,'current',$2,$3,$4,'item1')
     on conflict (cik, kind) do update set model = excluded.model, accession_number = excluded.accession_number, scores = excluded.scores, source = excluded.source, scored_at = now()`,
    [cik, JEV, acc, JSON.stringify(scores)]);
  let summary: string | null = null;
  if (summarize) {
    try {
      const { json } = await callLLM({ model: LLM_MODEL, systemPrompt: SUMMARY_PROMPT, userPrompt: text.slice(0, 6000), maxTokens: 100 });
      summary = typeof (json as { summary?: unknown })?.summary === "string" ? (json as { summary: string }).summary.slice(0, 160) : null;
    } catch { /* keep the old summary */ }
  }
  const six = BUSINESS_SCORES.map((k) => Math.round(scores[k]! * 10) / 10);
  await pool.query(
    `insert into current_business (cik, accession_number, filing_date, model, ${BUSINESS_SCORES.join(", ")}, summary, factors)
     values ($1,$2,$3,$4,${BUSINESS_SCORES.map((_, k) => `$${5 + k}`).join(",")},$${5 + BUSINESS_SCORES.length},$${6 + BUSINESS_SCORES.length})
     on conflict (cik) do update set accession_number = excluded.accession_number, filing_date = excluded.filing_date,
       model = excluded.model, ${BUSINESS_SCORES.map((s) => `${s} = excluded.${s}`).join(", ")},
       summary = coalesce(excluded.summary, current_business.summary), factors = excluded.factors, scored_at = now()`,
    [cik, acc, date, JEV, ...six, summary, JSON.stringify(scores)]);
}

// Score current excerpts already in business_text (from pull-business-text)
// that current_business doesn't have from Jev yet. No EDGAR requests.
async function backfill(concurrency = 16): Promise<void> {
  await ensureFactors();
  await pool.query(`alter table current_business add column if not exists factors jsonb`);
  const rows = (await pool.query<{ cik: string; acc: string; date: string | null; text: string; has_summary: boolean }>(`
    select bt.cik, bt.accession_number acc, bt.filing_date::text date, bt.text, cb.summary is not null has_summary
      from business_text bt left join current_business cb on cb.cik = bt.cik
     where bt.kind = 'current' and bt.text is not null
       and (cb.cik is null or cb.model is distinct from $1 or cb.accession_number is distinct from bt.accession_number)`, [JEV])).rows;
  console.log(`backfill: ${rows.length} current excerpts to score`);
  let cursor = 0, done = 0, failed = 0;
  const worker = async (): Promise<void> => {
    while (cursor < rows.length) {
      const r = rows[cursor++]!;
      try { await scoreCurrent(r.cik, r.acc, r.date, r.text, !r.has_summary); } catch (e) { failed++; if (failed < 10) console.error(`  ${r.cik} FAILED: ${e instanceof Error ? e.message : e}`); }
      if (++done % 500 === 0 || done === rows.length) console.log(`  ${done}/${rows.length} (${failed} failed)`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ---- apply ----

async function latestFloats(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const y = new Date().getUTCFullYear();
  // Oldest first so the newest frame wins.
  for (const year of [y - 2, y - 1, y]) {
    const raw = await secText(`https://data.sec.gov/api/xbrl/frames/dei/EntityPublicFloat/USD/CY${year}Q2I.json`);
    for (const d of raw ? (JSON.parse(raw) as { data: { cik: number; val: number }[] }).data : []) out.set(String(d.cik).padStart(10, "0"), d.val);
  }
  return out;
}

// Banded lift when the model has bands (current fits), else probability / base.
const mult = (m: Stored, p: number, pct: number) => (m.bands ? bandLift(m.bands, pct) : p / m.base_rate);

const percentiles = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return (p: number) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! < p) lo = mid + 1; else hi = mid; } return lo / sorted.length; };
};

async function apply(): Promise<void> {
  const get = async (id: string) => (await pool.query(`select features from takeover_model where id = $1`, [id])).rows[0]?.features as Stored | undefined;
  const pe = await get("pe"), sp = await get("sponsor");
  if (!pe || !sp?.platt) throw new Error("no fitted models; run --fit first");
  const floats = await latestFloats();
  const rows = (await pool.query(`
    select t.cik, t.total_assets, t.goodwill, t.active_13d_count, c.market_cap_at_universe_pull as mcap, fs.scores
      from takeover_scores t join companies c using (cik) left join factor_score fs on fs.cik = t.cik and fs.kind = 'current'`)).rows;
  const scored = rows.map((r) => {
    const float = floats.get(r.cik) ?? (r.mcap ? r.mcap * 0.85 : null); // float runs below market cap
    const x = withFactors({
      log_float: float ? Math.log(float) : null,
      goodwill_to_assets: r.total_assets > 0 ? (r.goodwill ?? 0) / r.total_assets : null,
      has_13d: r.active_13d_count > 0 ? 1 : 0,
    }, r.scores);
    return x.log_float == null ? null : { cik: r.cik as string, x, p: predictSponsor(pe, sp, x), q: predictPE(pe, x) };
  }).filter((s): s is NonNullable<typeof s> => s != null);
  const pctP = percentiles(scored.map((s) => s.p)), pctQ = percentiles(scored.map((s) => s.q));
  await pool.query(`create table if not exists sponsor_scores (
    cik text primary key, probability double precision not null, multiple double precision not null,
    percentile double precision not null, signal_recurring_revenue boolean not null, signal_rollup_shape boolean not null,
    ${BUSINESS_SCORES.map((s) => `${s} real`).join(", ")}, scored_at timestamptz not null default now())`);
  await pool.query(`create table if not exists pe_scores (cik text primary key, probability double precision not null,
    multiple double precision not null, percentile double precision not null, scored_at timestamptz not null default now())`);
  await pool.query("begin");
  try {
    await pool.query(`delete from sponsor_scores`);
    await pool.query(`delete from pe_scores`);
    for (let i = 0; i < scored.length; i += 500) {
      const c = scored.slice(i, i + 500);
      const v = (k: string) => c.map((s) => s.x[`j_${k}`] ?? null);
      await pool.query(
        `insert into sponsor_scores (cik, probability, multiple, percentile, signal_recurring_revenue, signal_rollup_shape, ${BUSINESS_SCORES.join(", ")})
         select * from unnest($1::text[], $2::float8[], $3::float8[], $4::float8[], $5::boolean[], $6::boolean[], ${BUSINESS_SCORES.map((_, k) => `$${7 + k}::real[]`).join(", ")})`,
        [c.map((s) => s.cik), c.map((s) => s.p), c.map((s) => mult(sp, s.p, pctP(s.p))), c.map((s) => pctP(s.p)),
          c.map((s) => (s.x.j_recurring_revenue ?? 0) >= RECURRING_MIN), c.map((s) => (s.x.j_rollup_fit ?? 0) >= ROLLUP_SHAPE_MIN),
          ...BUSINESS_SCORES.map(v)],
      );
      await pool.query(`insert into pe_scores (cik, probability, multiple, percentile) select * from unnest($1::text[], $2::float8[], $3::float8[], $4::float8[])`,
        [c.map((s) => s.cik), c.map((s) => s.q), c.map((s) => mult(pe, s.q, pctQ(s.q))), c.map((s) => pctQ(s.q))]);
    }
    await pool.query("commit");
  } catch (e) { await pool.query("rollback"); throw e; }
  const s = await pool.query(`select count(*)::int n, count(*) filter (where multiple >= 3)::int over3x,
      (select count(*)::int from pe_scores where multiple >= 3) pe_over3x from sponsor_scores`);
  console.log(`apply: ${JSON.stringify(s.rows[0])} (${rows.length - scored.length} without a size, ${scored.filter((x) => x.x.jev_missing).length} without a 10-K read)`);
}

async function main(): Promise<void> {
  const all = !["--fit", "--score-10k", "--apply", "--backfill"].some((a) => process.argv.includes(a));
  if (process.argv.includes("--backfill")) await backfill();
  if (all || process.argv.includes("--fit")) await fitModels();
  if (all || process.argv.includes("--score-10k")) await score10k();
  if (all || process.argv.includes("--apply")) await apply();
  await pool.end();
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("sponsor-model.ts");
if (isMain) await main();
