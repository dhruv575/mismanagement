// Factor experiments for the two takeover models, on backtest_panel:
//   rollup -- sponsor-type buyer acquires a services business (angel side)
//   pe     -- sponsor-type buyer acquires any business (devil side)
//
// Compares the old Haiku business scores with Jev's, measures each Jev
// factor's out-of-sample value, and runs NESTED forward selection: for each
// outer test cohort, features are chosen using only earlier cohorts (inner
// expanding window), so the reported AUC is not flattered by the search.
//
// CLI:
//   tsx src/experiment2.ts [--label=rollup|pe|both] [--quick]

import { pool } from "./db.js";
import { FACTORS } from "./factors.js";
import { expanding, F, type Feature, type Row, summary } from "./logit.js";
import { BUSINESS_SCORES } from "./score-business.js";

const SPONSOR_TYPES = new Set(["financial_sponsor", "sponsor_platform", "holdco_or_ai_rollup", "management_or_insider"]);
const OUTER = [2020, 2021, 2022, 2023, 2024];
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;

export const BASE: Feature[] = [F("log_float", 20.03, 28, { missingFlag: false }), F("goodwill_to_assets", 0, 1), F("has_13d", 0, 1, { missingFlag: false })];
export const FUND: Feature[] = [
  F("sbc_to_revenue", 0, 0.5), F("ocf_to_net_income", -2, 4), F("payouts_to_ocf", 0, 3), F("net_debt_to_ebitda", -5, 10),
  F("float_to_book", 0, 30, { log: true }), F("float_change", -0.8, 2), F("revenue_growth", -0.5, 1),
  F("operating_margin", -0.5, 0.5), F("roa", -0.3, 0.3), F("cash_to_assets", 0, 1), F("debt_to_assets", 0, 1),
  F("log_employees", 2, 13), F("log_revenue_per_employee", 9, 16),
];
// Jev factors share one missing flag (they are missing together).
export const JEV_F: Feature[] = FACTORS.map((f) => F(`j_${f.name}`, 0, 10, { missingFlag: false }));
const JEV_MISSING = F("jev_missing", 0, 1, { missingFlag: false });
const HAIKU: Feature[] = BUSINESS_SCORES.map((s) => F(`h_${s}`, 0, 10));
const JEV6: Feature[] = BUSINESS_SCORES.map((s) => F(`j_${s}`, 0, 10, { missingFlag: false }));

export async function loadPanel(): Promise<Row[]> {
  const rows = (await pool.query(`
    select p.*, k.employees,
           ${BUSINESS_SCORES.map((s) => `b.${s} as h_${s}`).join(", ")},
           fs.scores as jev,
           c.buyer_type, c.issuer_acquired as cls_acquired, c.services_business as deal_services, c.labor_intensive as deal_labor
      from backtest_panel p
      left join panel_10k k using (cik, cohort_year)
      left join business_score b on b.cik = p.cik
      left join factor_score fs on fs.cik = p.cik and fs.kind = 'panel'
      left join deal_class c on c.accession_number = p.event_accession`)).rows;
  for (const r of rows) {
    r.log_float = Math.log(r.public_float);
    r.has_13d = r.thirteen_d_count > 0 ? 1 : 0;
    r.log_employees = r.employees > 0 ? Math.log(r.employees) : null;
    r.log_revenue_per_employee = r.employees > 0 && r.revenue > 0 ? Math.log(r.revenue / r.employees) : null;
    for (const f of FACTORS) r[`j_${f.name}`] = r.jev?.[f.name] ?? null;
    r.jev_missing = r.jev ? 0 : 1;
    // Same labels as sponsor-model.ts.
    const sponsor = r.target && r.cls_acquired && SPONSOR_TYPES.has(r.buyer_type);
    r.pe = !!sponsor;
    r.rollup = !!(sponsor && r.deal_services);
    // Strict: the deal classifier also called the target labor-intensive.
    r.rollup_strict = !!(sponsor && r.deal_services && r.deal_labor);
  }
  return rows;
}

const fmt = (m: ReturnType<typeof summary>) => ({ auc: m.auc.toFixed(3), top_decile: `${m.top.toFixed(2)}x`, test_pos: m.pos });

// Forward selection scored by an inner expanding window over `train`'s last
// three cohorts. Stops when the best addition gains under `minGain` AUC.
function forward(train: Row[], label: string, base: Feature[], pool_: Feature[], l2: number, maxSteps: number, minGain = 0.002): Feature[] {
  const cohorts = [...new Set(train.map((r) => r.cohort_year as number))].sort().slice(-3);
  const score = (fs: Feature[]) => summary(expanding(train, label, fs, l2, cohorts)).auc;
  let chosen = [...base], best = score(chosen);
  for (let step = 0; step < maxSteps; step++) {
    let pick: Feature | null = null, pickScore = best;
    for (const f of pool_) {
      if (chosen.some((c) => c.name === f.name)) continue;
      const s = score([...chosen, f]);
      if (s > pickScore) { pickScore = s; pick = f; }
    }
    if (!pick || pickScore - best < minGain) break;
    chosen.push(pick); best = pickScore;
  }
  return chosen;
}

// Two-stage angel model: P(sponsor buys it) from the PE fit (144 positives),
// times how rollup-shaped the business is (a Jev factor, as a probability).
// Scored against both rollup labels, next to direct fits on those labels.
function twoStage(rows: Row[]): void {
  const pe = expanding(rows, "pe", [...BASE, ...JEV6, JEV_MISSING], 2, OUTER);
  const byKey = new Map(pe.map((p, i) => [`${p.cik}:${p.cohort}`, i]));
  const test = rows.filter((r) => r.cohort_year >= OUTER[0]!);
  const shapes = ["rollup_target", "office_work", "people_services", "rollup_fit", "services_share"].filter((s) => FACTORS.some((f) => f.name === s));
  for (const label of ["rollup", "rollup_strict"]) {
    const out: Record<string, unknown>[] = [];
    const direct = summary(expanding(rows, label, [...BASE, ...JEV6, JEV_MISSING], label === "rollup" ? 8 : 12, OUTER));
    out.push({ model: "direct fit, base + Jev six", auc: direct.auc.toFixed(3), top: `${direct.top.toFixed(2)}x`, pos: direct.pos });
    const directH = summary(expanding(rows, label, [...BASE, ...HAIKU], label === "rollup" ? 8 : 12, OUTER));
    out.push({ model: "direct fit, base + Haiku six (current)", auc: directH.auc.toFixed(3), top: `${directH.top.toFixed(2)}x`, pos: directH.pos });
    for (const shape of shapes) for (const power of [0.5, 1, 2]) {
      const pred = test.map((r) => {
        const p = pe[byKey.get(`${r.cik}:${r.cohort_year}`)!]!;
        const sh = Math.min(Math.max((r[`j_${shape}`] ?? 1) / 10, 0.01), 0.99);
        return { cohort: r.cohort_year, s: p.s + power * Math.log(sh), y: r[label] ? 1 : 0 };
      });
      const m = summary(pred);
      out.push({ model: `PE x ${shape}^${power}`, auc: m.auc.toFixed(3), top: `${m.top.toFixed(2)}x`, pos: m.pos });
    }
    console.log(`
two-stage vs direct, label ${label}:`); console.table(out);
  }
}

async function main(): Promise<void> {
  const rows = await loadPanel();
  const which = arg("label", "both"), quick = process.argv.includes("--quick");
  console.log(`${rows.length} company-years; rollup positives ${rows.filter((r) => r.rollup).length}, pe positives ${rows.filter((r) => r.pe).length}; ` +
    `jev coverage ${rows.filter((r) => r.jev).length}, haiku coverage ${rows.filter((r) => r.h_rollup_fit != null).length}`);
  if (which === "both" || which === "two-stage") twoStage(rows);
  for (const [label, l2] of [["rollup", 8], ["rollup_strict", 12], ["pe", 2]] as const) {
    if (which !== "both" && which !== label) continue;
    console.log(`\n===== label: ${label} (L2 ${l2}) =====`);
    const sets: [string, Feature[]][] = [
      ["base (size, goodwill, 13D)", BASE],
      ["base + Haiku six (current model)", [...BASE, ...HAIKU]],
      ["base + Jev six", [...BASE, ...JEV6, JEV_MISSING]],
      ["base + all Jev factors", [...BASE, ...JEV_F, JEV_MISSING]],
      ["base + fundamentals", [...BASE, ...FUND]],
      ["base + fundamentals + all Jev", [...BASE, ...FUND, ...JEV_F, JEV_MISSING]],
    ];
    console.table(sets.map(([name, f]) => {
      const p = expanding(rows, label, f, l2, OUTER);
      return { features: name, ...fmt(summary(p)), auc_2024: summary(p.filter((x) => x.cohort === 2024)).auc.toFixed(3) };
    }));

    // One factor at a time on top of base + Jev six: the marginal value of each.
    const anchor = [...BASE, ...JEV6, JEV_MISSING];
    const a0 = summary(expanding(rows, label, anchor, l2, OUTER)).auc;
    const marg = [...JEV_F.filter((f) => !JEV6.some((g) => g.name === f.name)), ...FUND].map((f) => {
      const m = summary(expanding(rows, label, [...anchor, f], l2, OUTER));
      return { factor: f.name, delta_auc: +(m.auc - a0).toFixed(4), top_decile: `${m.top.toFixed(2)}x` };
    }).sort((a, b) => b.delta_auc - a.delta_auc);
    console.log(`marginal value over base + Jev six (AUC ${a0.toFixed(3)}):`);
    console.table(marg);
    if (quick) continue;

    // Nested forward selection: honest estimate of "pick the best factors".
    const poolF = [...JEV_F, ...FUND];
    const nested: ReturnType<typeof expanding> = [];
    const picks: Record<string, number> = {};
    for (const c of OUTER) {
      const train = rows.filter((r) => r.cohort_year < c);
      const fs = forward(train, label, [...BASE, JEV_MISSING], poolF, l2, 8);
      for (const f of fs) picks[f.name] = (picks[f.name] ?? 0) + 1;
      nested.push(...expanding(rows.filter((r) => r.cohort_year <= c), label, fs, l2, [c]));
      console.log(`  outer ${c}: ${fs.slice(BASE.length + 1).map((f) => f.name).join(", ") || "(base only)"}`);
    }
    console.log(`nested forward selection: ${JSON.stringify(fmt(summary(nested)))}  2024 AUC ${summary(nested.filter((x) => x.cohort === 2024)).auc.toFixed(3)}`);
    console.log(`picked how often (of ${OUTER.length}):`, Object.entries(picks).filter(([k]) => !BASE.some((b) => b.name === k) && k !== "jev_missing").sort((a, b) => b[1] - a[1]));
  }
  await pool.end();
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("experiment2.ts");
if (isMain) await main();
