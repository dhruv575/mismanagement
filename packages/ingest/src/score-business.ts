// Score each backtest company's business against the AI-rollup target
// profile, from the Item 1 excerpt pull-panel-10k.ts stored. One score per
// company, from its earliest excerpt in the panel: that 10-K predates every
// cohort's as-of date the score is used for, so it is point-in-time, and a
// business model rarely changes year to year.
//
// The model sees only the excerpt, not the company's name or outcome.
//
// CLI:
//   tsx src/score-business.ts [--model=anthropic/claude-haiku-5.5] [--concurrency=8]

import { z } from "zod";
import { pool } from "./db.js";
import { callLLM } from "./llm.js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const MODEL = arg("model", "anthropic/claude-haiku-5.5");

const n10 = z.coerce.number().min(0).max(10).catch(5);
export const Score = z.object({
  services_share: n10, labor_intensity: n10, ai_automatable: n10, fragmented_market: n10,
  recurring_revenue: n10, rollup_fit: n10, summary: z.string().catch(""),
});
export const BUSINESS_SCORES = ["services_share", "labor_intensity", "ai_automatable", "fragmented_market", "recurring_revenue", "rollup_fit"] as const;

export const PROMPT = `You rate a public company's business model from the Business section of its 10-K.

Context: "AI rollups" are holding companies and private-equity-style buyers that acquire services businesses whose costs are mostly people doing repeatable knowledge or process work (accounting, IT services, BPO and call centers, insurance brokerage and claims, healthcare administration and revenue cycle, staffing, legal and compliance, property management, marketing services, payroll/HR, freight brokerage, engineering services), then use AI and software to automate that work and lift margins, often adding more acquisitions.

Rate each 0-10 from the text alone. Return JSON only:
{
  "services_share": number,     // 10 = revenue is almost all services; 0 = products, drugs, commodities, real estate or lending
  "labor_intensity": number,    // 10 = employee costs dominate the cost base
  "ai_automatable": number,     // 10 = most of what the employees do is document, communication, analysis or process work current AI could do
  "fragmented_market": number,  // 10 = many small competitors, room for add-on acquisitions
  "recurring_revenue": number,  // 10 = contracted or repeat revenue
  "rollup_fit": number,         // 10 = an ideal AI-rollup acquisition target, all things considered
  "summary": string             // what the company does, under 15 words
}`;

async function main(): Promise<void> {
  const concurrency = parseInt(arg("concurrency", "8"), 10);
  await pool.query(`create table if not exists business_score (
    cik text primary key, cohort_year smallint not null, model text not null,
    ${BUSINESS_SCORES.map((s) => `${s} real`).join(", ")}, summary text,
    scored_at timestamptz not null default now())`);
  const rows = (await pool.query<{ cik: string; cohort_year: number; business: string }>(
    `select distinct on (k.cik) k.cik, k.cohort_year, k.business from panel_10k k
      where k.business is not null and not exists (select 1 from business_score s where s.cik = k.cik)
      order by k.cik, k.cohort_year`,
  )).rows;
  console.log(`score-business: ${rows.length} companies (${MODEL})`);
  let cursor = 0, done = 0, failed = 0;
  const worker = async (): Promise<void> => {
    while (cursor < rows.length) {
      const r = rows[cursor++]!;
      try {
        const { json } = await callLLM({ model: MODEL, systemPrompt: PROMPT, userPrompt: r.business, maxTokens: 800 });
        const s = Score.parse(json);
        await pool.query(
          `insert into business_score (cik, cohort_year, model, ${BUSINESS_SCORES.join(", ")}, summary)
           values ($1,$2,$3,${BUSINESS_SCORES.map((_, i) => `$${4 + i}`).join(",")},$${4 + BUSINESS_SCORES.length}) on conflict do nothing`,
          [r.cik, r.cohort_year, MODEL, ...BUSINESS_SCORES.map((k) => s[k]), s.summary],
        );
      } catch (e) {
        failed++;
        console.error(`  ${r.cik} FAILED: ${e instanceof Error ? e.message : e}`);
      }
      if (++done % 200 === 0 || done === rows.length) console.log(`  ${done}/${rows.length} (${failed} failed)`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await pool.end();
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("score-business.ts");
if (isMain) await main();
