// Classify deals by how closely they resemble an AI rollup: a financial
// buyer or holdco (Long Lake, Thrive Holdings, General Catalyst's
// creation-to-rollup strategy) buying a labor-intensive services business
// to lift margins with software/AI and consolidation. The few real AI
// rollups are too recent to train on, so the backtest label is the
// historical analog: sponsor/holdco buyouts of services-heavy businesses.
//
// Reads the opening of each deal document (cover letter and summary term
// sheet name the buyer and describe the target) with the LLM. Results go to
// deal_class, keyed by accession; reruns skip classified filings.
//
// CLI:
//   tsx src/classify-deals.ts                # deals that label backtest_panel
//   tsx src/classify-deals.ts --all          # every non-self deal filing's first filing per target
//   [--model=anthropic/claude-haiku-5.5] [--concurrency=6]

import { z } from "zod";
import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { callLLM } from "./llm.js";
import { htmlToText } from "./text-signals.js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const MODEL = arg("model", "anthropic/claude-haiku-5.5");

// This runs beside the 10-K pulls, so it keeps well under EDGAR's 10 req/s.
let lastFetch = 0;
async function secPrefix(url: string, bytes: number): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const slot = Math.max(Date.now(), lastFetch + 1000);
    lastFetch = slot;
    if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
    try {
      const res = await fetch(url, { headers: { "User-Agent": EDGAR_USER_AGENT }, signal: AbortSignal.timeout(90_000) });
      if (res.status === 404) return "";
      if (res.ok) {
        // EDGAR ignores Range: read the prefix and cancel.
        const reader = res.body!.getReader(), chunks: Uint8Array[] = [];
        let n = 0;
        while (n < bytes) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
        await reader.cancel().catch(() => {});
        return Buffer.concat(chunks).toString("utf8");
      }
      if (attempt >= 4) throw new Error(`${res.status} ${url}`);
      await new Promise((r) => setTimeout(r, (res.status === 429 ? 15_000 : 2000) * 2 ** attempt));
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

const BUYER_TYPES = ["strategic", "financial_sponsor", "sponsor_platform", "holdco_or_ai_rollup", "management_or_insider", "other", "unclear"] as const;
const DealClass = z.object({
  buyer: z.string().nullable(),
  buyer_type: z.enum(BUYER_TYPES).catch("unclear"),
  issuer_acquired: z.boolean().catch(true),
  target_business: z.string().catch(""),
  services_business: z.boolean().catch(false),
  labor_intensive: z.boolean().catch(false),
  rollup_fit: z.coerce.number().min(0).max(10).catch(0),
  reason: z.string().catch(""),
});

const PROMPT = `You classify US public-company acquisitions from the opening of the deal document (merger proxy, going-private schedule, or tender offer).

We care about deals that resemble an "AI rollup": a financial buyer or holding company (private equity, a sponsor-backed platform, a permanent-capital holdco, or an AI-native rollup vehicle such as Long Lake or Thrive Holdings) acquiring a services business whose costs are mostly people doing repeatable knowledge or process work (accounting, IT services, BPO and call centers, insurance brokerage and claims, healthcare administration and revenue cycle, staffing, legal and compliance services, property management, marketing services, payroll/HR services, logistics brokerage, engineering services), intending to lift margins with software/automation and add-on acquisitions.

Answer from the text. Return JSON only:
{
  "buyer": string|null,              // the ultimate acquirer or sponsor, e.g. "Thoma Bravo"
  "buyer_type": one of ${BUYER_TYPES.map((t) => `"${t}"`).join(", ")},
                                     // strategic = an operating company; sponsor_platform = a PE-owned operating company; management_or_insider = controlling holder or management buyout
  "issuer_acquired": boolean,        // false if the filer is the buyer, or this is a reorganization/spin-off
  "target_business": string,         // under 15 words
  "services_business": boolean,      // the target mainly sells services rather than products, drugs, commodities, real estate or financial balance sheet
  "labor_intensive": boolean,        // people costs are the target's main cost
  "rollup_fit": number,              // 0-10, how closely the deal matches the AI-rollup pattern above (buyer type and target both count)
  "reason": string                   // under 25 words
}`;

async function main(): Promise<void> {
  const concurrency = parseInt(arg("concurrency", "6"), 10);
  await pool.query(`create table if not exists deal_class (
    accession_number text primary key, model text not null, buyer text, buyer_type text,
    issuer_acquired boolean, target_business text, services_business boolean, labor_intensive boolean,
    rollup_fit real, reason text, classified_at timestamptz not null default now())`);
  const scope = process.argv.includes("--all")
    ? `select distinct on (d.cik) d.accession_number from deal_filings d
        where not d.is_self_filed and d.form <> '8-K' and d.issuer_acquired is not false order by d.cik, d.filing_date`
    : `select event_accession as accession_number from backtest_panel where event_accession is not null`;
  const rows = (await pool.query<{ accession_number: string; document_url: string; form: string; name: string; sic_description: string | null; acquirer: string | null }>(
    `select d.accession_number, d.document_url, d.form, c.name, c.sic_description, d.acquirer
       from deal_filings d left join companies c using (cik)
      where d.accession_number in (${scope}) and d.document_url is not null
        and not exists (select 1 from deal_class k where k.accession_number = d.accession_number)`,
  )).rows;
  console.log(`classify-deals: ${rows.length} deals (${MODEL})`);
  let cursor = 0, done = 0;
  const worker = async (): Promise<void> => {
    while (cursor < rows.length) {
      const r = rows[cursor++]!;
      try {
        const raw = await secPrefix(r.document_url, 1_500_000);
        const text = htmlToText(raw.slice(Math.max(0, raw.indexOf("<DOCUMENT>")))).replace(/\s+/g, " ").slice(0, 30_000);
        const header = `Form ${r.form}. Target: ${r.name ?? "?"} (${r.sic_description ?? "industry unknown"}).` +
          (r.acquirer ? ` Acquirer named in our data: ${r.acquirer}.` : "");
        const { json } = await callLLM({ model: MODEL, systemPrompt: PROMPT, userPrompt: `${header}\n\n${text}`, maxTokens: 1000 });
        const c = DealClass.parse(json);
        await pool.query(
          `insert into deal_class (accession_number, model, buyer, buyer_type, issuer_acquired, target_business, services_business, labor_intensive, rollup_fit, reason)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (accession_number) do nothing`,
          [r.accession_number, MODEL, c.buyer, c.buyer_type, c.issuer_acquired, c.target_business, c.services_business, c.labor_intensive, c.rollup_fit, c.reason],
        );
      } catch (e) {
        console.error(`  ${r.accession_number} FAILED: ${e instanceof Error ? e.message : e}`);
      }
      if (++done % 50 === 0 || done === rows.length) console.log(`  ${done}/${rows.length}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const s = await pool.query(`select buyer_type, count(*)::int n, round(avg(rollup_fit)::numeric, 1) fit,
      count(*) filter (where services_business and labor_intensive)::int services_labor
    from deal_class group by 1 order by 2 desc`);
  console.table(s.rows);
  await pool.end();
}

await main();
