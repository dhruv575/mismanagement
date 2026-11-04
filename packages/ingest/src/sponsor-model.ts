// AI-rollup-style buyout model: the probability that a financial sponsor,
// sponsor-backed platform, holdco or insider group buys the company within
// 12 months AND the target is a services business (deal_class) -- the
// historical analog of an AI-rollup acquisition. Chosen by experiment.ts:
// expanding-window AUC ~0.91, top decile ~6.7x on 24 test positives, against
// ~0.77 / ~3.8x for any sponsor buyout and ~0.64 / ~2x for any deal. Part of
// that edge is definitional (the business scores pick out services
// companies); the lean feature set did as well as everything else.
//
// Steps (run in order; each is rerunnable):
//   tsx src/sponsor-model.ts --fit        fit on backtest_panel, store in takeover_model ('sponsor')
//   tsx src/sponsor-model.ts --score-10k  LLM-score each current company's latest 10-K Business section
//   tsx src/sponsor-model.ts --apply      write sponsor_scores for the current universe
//   tsx src/sponsor-model.ts              all three (--score-10k only fetches what's new)

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { callLLM } from "./llm.js";
import { businessExcerpt } from "./pull-panel-10k.js";
import { BUSINESS_SCORES, PROMPT, Score } from "./score-business.js";
import { htmlToText } from "./text-signals.js";

const MODEL = "anthropic/claude-haiku-5.5";
const SPONSOR_TYPES = ["financial_sponsor", "sponsor_platform", "holdco_or_ai_rollup", "management_or_insider"];
// Few positives (33): regularize harder than the all-sponsor fit.
const L2 = 8;
// Visible flags from the business scores (sponsor-buyout rate in the
// backtest: recurring 7+ ~2.4% vs 1.2% overall; rollup fit 5+ ~3.7%).
export const RECURRING_MIN = 7;
export const ROLLUP_SHAPE_MIN = 5;

interface Feature { name: string; lo: number; hi: number; missingFlag: boolean }
const FEATURES: Feature[] = [
  // Clipped to the training range: the panel starts at $500M of float.
  { name: "log_float", lo: Math.log(500e6), hi: 28, missingFlag: false },
  { name: "goodwill_to_assets", lo: 0, hi: 1, missingFlag: true },
  { name: "has_13d", lo: 0, hi: 1, missingFlag: false },
  ...BUSINESS_SCORES.map((s) => ({ name: s, lo: 0, hi: 10, missingFlag: true })),
];
interface Stored { features: Feature[]; impute: number[]; mean: number[]; sd: number[]; beta: number[]; base_rate: number }

// ---- model ----

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clip = (f: Feature, v: number) => Math.min(Math.max(v, f.lo), f.hi);
const raw = (m: Pick<Stored, "features" | "impute">, r: Record<string, unknown>) =>
  m.features.flatMap((f, i) => { const v = r[f.name]; const t = ok(v) ? clip(f, v) : m.impute[i]!; return f.missingFlag ? [t, ok(v) ? 0 : 1] : [t]; });
export const predict = (m: Stored, r: Record<string, unknown>) =>
  sigmoid([1, ...raw(m, r).map((v, j) => (v - m.mean[j]!) / m.sd[j]!)].reduce((a, v, j) => a + v * m.beta[j]!, 0));

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

async function fitModel(): Promise<void> {
  const rows = (await pool.query(`
    select p.public_float, p.goodwill_to_assets, p.thirteen_d_count,
           ${BUSINESS_SCORES.map((s) => `b.${s}`).join(", ")},
           (p.target and c.issuer_acquired and c.services_business and c.buyer_type = any($1)) as y
      from backtest_panel p
      left join business_score b using (cik)
      left join deal_class c on c.accession_number = p.event_accession`, [SPONSOR_TYPES])).rows
    .map((r) => ({ ...r, log_float: Math.log(r.public_float), has_13d: r.thirteen_d_count > 0 ? 1 : 0 }));
  const impute = FEATURES.map((f) => { const v = rows.map((r) => r[f.name]).filter(ok).map((v) => clip(f, v)); return v.reduce((a, b) => a + b, 0) / v.length; });
  const R = rows.map((r) => raw({ features: FEATURES, impute }, r)), k = R[0]!.length;
  const mean = Array.from({ length: k }, (_, j) => R.reduce((a, v) => a + v[j]!, 0) / R.length);
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(R.reduce((a, v) => a + (v[j]! - mean[j]!) ** 2, 0) / R.length) || 1);
  const X = R.map((v) => [1, ...v.map((x, j) => (x - mean[j]!) / sd[j]!)]), y: number[] = rows.map((r) => (r.y ? 1 : 0));
  let beta = new Array(k + 1).fill(0);
  for (let iter = 0; iter < 50; iter++) {
    const g = new Array(k + 1).fill(0), H = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0));
    X.forEach((x, i) => {
      const p = sigmoid(x.reduce((a, v, j) => a + v * beta[j], 0)), s = p * (1 - p);
      for (let a = 0; a <= k; a++) { g[a] += (y[i]! - p) * x[a]!; for (let b = 0; b <= a; b++) H[a]![b] += s * x[a]! * x[b]!; }
    });
    for (let a = 0; a <= k; a++) { for (let b = 0; b < a; b++) H[b]![a] = H[a]![b]; if (a) { g[a] -= L2 * beta[a]; H[a]![a] += L2; } }
    const step = solve(H, g);
    beta = beta.map((v, j) => v + step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const base_rate = y.reduce((a, b) => a + b, 0) / y.length;
  const stored: Stored = { features: FEATURES, impute, mean, sd, beta, base_rate };
  const cols = FEATURES.flatMap((f) => (f.missingFlag ? [f.name, `${f.name}_missing`] : [f.name]));
  await pool.query(
    `insert into takeover_model (id, fitted_at, features, metrics, coefficients, impute) values ('sponsor', now(), $1, $2, $3, $4)
     on conflict (id) do update set fitted_at = now(), features = excluded.features, metrics = excluded.metrics,
       coefficients = excluded.coefficients, impute = excluded.impute`,
    [JSON.stringify(stored), JSON.stringify({ rows: rows.length, positives: y.reduce((a, b) => a + b, 0), base_rate }),
      JSON.stringify(["intercept", ...cols].map((name, j) => ({ name, coef: beta[j], odds_per_sd: Math.exp(beta[j]) }))), JSON.stringify(impute)],
  );
  console.log(`fit: ${rows.length} company-years, ${y.reduce((a, b) => a + b, 0)} sponsor buyouts of services businesses (base ${(100 * base_rate).toFixed(2)}%)`);
  console.table(["intercept", ...cols].map((name, j) => ({ name, odds_per_sd: Math.exp(beta[j]).toFixed(2) })));
}

// ---- current 10-Ks ----

let lastFetch = 0;
async function secText(url: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const slot = Math.max(Date.now(), lastFetch + 125); // EDGAR fair access: 8 req/s
    lastFetch = slot;
    if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
    try {
      const res = await fetch(url, { headers: { "User-Agent": EDGAR_USER_AGENT }, signal: AbortSignal.timeout(90_000) });
      if (res.status === 404) return null;
      if (res.ok) return await res.text();
      if (attempt >= 4) throw new Error(`${res.status} ${url}`);
      await new Promise((r) => setTimeout(r, (res.status === 429 ? 15_000 : 2000) * 2 ** attempt));
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function score10k(concurrency = 6): Promise<void> {
  await pool.query(`create table if not exists current_business (
    cik text primary key, accession_number text, filing_date date, model text,
    ${BUSINESS_SCORES.map((s) => `${s} real`).join(", ")}, summary text, scored_at timestamptz not null default now())`);
  const ciks = (await pool.query<{ cik: string; accession_number: string | null }>(
    `select t.cik, cb.accession_number from takeover_scores t left join current_business cb using (cik)`)).rows;
  console.log(`score-10k: checking ${ciks.length} companies for a new 10-K`);
  let cursor = 0, done = 0, scored = 0, failed = 0;
  const worker = async (): Promise<void> => {
    while (cursor < ciks.length) {
      const c = ciks[cursor++]!;
      try {
        const sub = await secText(`https://data.sec.gov/submissions/CIK${c.cik}.json`);
        const r = sub ? (JSON.parse(sub) as { filings: { recent: { form: string[]; accessionNumber: string[]; filingDate: string[]; primaryDocument: string[] } } }).filings.recent : null;
        const i = r ? r.form.findIndex((f) => f === "10-K") : -1;
        if (r && i >= 0 && r.accessionNumber[i] !== c.accession_number) {
          const html = await secText(`https://www.sec.gov/Archives/edgar/data/${Number(c.cik)}/${r.accessionNumber[i]!.replace(/-/g, "")}/${r.primaryDocument[i]}`);
          const business = html ? businessExcerpt(htmlToText(html)) : null;
          if (business) {
            const { json } = await callLLM({ model: MODEL, systemPrompt: PROMPT, userPrompt: business, maxTokens: 800 });
            const s = Score.parse(json);
            await pool.query(
              `insert into current_business (cik, accession_number, filing_date, model, ${BUSINESS_SCORES.join(", ")}, summary)
               values ($1,$2,$3,$4,${BUSINESS_SCORES.map((_, j) => `$${5 + j}`).join(",")},$${5 + BUSINESS_SCORES.length})
               on conflict (cik) do update set accession_number = excluded.accession_number, filing_date = excluded.filing_date,
                 model = excluded.model, ${BUSINESS_SCORES.map((s) => `${s} = excluded.${s}`).join(", ")},
                 summary = excluded.summary, scored_at = now()`,
              [c.cik, r.accessionNumber[i], r.filingDate[i], MODEL, ...BUSINESS_SCORES.map((k) => s[k]), s.summary],
            );
            scored++;
          }
        }
      } catch (e) {
        failed++;
        console.error(`  ${c.cik} FAILED: ${e instanceof Error ? e.message : e}`);
      }
      if (++done % 250 === 0 || done === ciks.length) console.log(`  ${done}/${ciks.length} (${scored} scored, ${failed} failed)`);
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

async function apply(): Promise<void> {
  const m = (await pool.query(`select features from takeover_model where id = 'sponsor'`)).rows[0]?.features as Stored | undefined;
  if (!m) throw new Error("no sponsor model; run --fit first");
  const floats = await latestFloats();
  const rows = (await pool.query(`
    select t.cik, t.total_assets, t.goodwill, t.active_13d_count, c.market_cap_at_universe_pull as mcap,
           ${BUSINESS_SCORES.map((s) => `cb.${s}`).join(", ")}
      from takeover_scores t join companies c using (cik) left join current_business cb using (cik)`)).rows;
  await pool.query(`create table if not exists sponsor_scores (
    cik text primary key, probability double precision not null, multiple double precision not null,
    percentile double precision not null, signal_recurring_revenue boolean not null, signal_rollup_shape boolean not null,
    ${BUSINESS_SCORES.map((s) => `${s} real`).join(", ")}, scored_at timestamptz not null default now())`);
  const scored = rows.map((r) => {
    const float = floats.get(r.cik) ?? (r.mcap ? r.mcap * 0.85 : null); // float runs below market cap
    const x = {
      ...r, log_float: float ? Math.log(float) : null,
      goodwill_to_assets: r.total_assets > 0 ? (r.goodwill ?? 0) / r.total_assets : null,
      has_13d: r.active_13d_count > 0 ? 1 : 0,
    };
    return { r, p: x.log_float == null ? null : predict(m, x) };
  }).filter((s): s is { r: any; p: number } => s.p != null);
  const sorted = scored.map((s) => s.p).sort((a, b) => a - b);
  const pct = (p: number) => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! < p) lo = mid + 1; else hi = mid; } return lo / sorted.length; };
  await pool.query(`delete from sponsor_scores`);
  for (let i = 0; i < scored.length; i += 500) {
    const c = scored.slice(i, i + 500);
    await pool.query(
      `insert into sponsor_scores (cik, probability, multiple, percentile, signal_recurring_revenue, signal_rollup_shape, ${BUSINESS_SCORES.join(", ")})
       select * from unnest($1::text[], $2::float8[], $3::float8[], $4::float8[], $5::boolean[], $6::boolean[], ${BUSINESS_SCORES.map((_, j) => `$${7 + j}::real[]`).join(", ")})`,
      [c.map((s) => s.r.cik), c.map((s) => s.p), c.map((s) => s.p / m.base_rate), c.map((s) => pct(s.p)),
        c.map((s) => (s.r.recurring_revenue ?? 0) >= RECURRING_MIN), c.map((s) => (s.r.rollup_fit ?? 0) >= ROLLUP_SHAPE_MIN),
        ...BUSINESS_SCORES.map((k) => c.map((s) => s.r[k] ?? null))],
    );
  }
  const s = await pool.query(`select count(*)::int n, count(*) filter (where signal_recurring_revenue)::int rec,
      count(*) filter (where signal_rollup_shape)::int shape, round(avg(probability)::numeric * 100, 2) avg_pct,
      count(*) filter (where multiple >= 3)::int over3x from sponsor_scores`);
  console.log(`apply: ${JSON.stringify(s.rows[0])} (${rows.length - scored.length} without a size)`);
}

async function main(): Promise<void> {
  const all = !["--fit", "--score-10k", "--apply"].some((a) => process.argv.includes(a));
  if (all || process.argv.includes("--fit")) await fitModel();
  if (all || process.argv.includes("--score-10k")) await score10k();
  if (all || process.argv.includes("--apply")) await apply();
  await pool.end();
}

await main();
