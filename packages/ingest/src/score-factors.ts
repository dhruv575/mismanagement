// Score every stored Item 1 excerpt (business_text) on every factor in
// factors.ts with Jev. Scores live in factor_score as JSON, so adding a
// factor only scores the new question; --refresh rescores everything.
//
// CLI:
//   tsx src/score-factors.ts [--kind=panel|current|both] [--refresh] [--concurrency=16] [--limit=N]

import { pool } from "./db.js";
import { FACTORS, JEV } from "./factors.js";
import { decideFactors } from "./jev.js";
import { riskDensity, RISK_MAX } from "./pull-panel-10k.js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;

export async function ensureTable(): Promise<void> {
  await pool.query(`create table if not exists factor_score (
    cik text not null, kind text not null, model text not null, accession_number text,
    scores jsonb not null, source text, scored_at timestamptz not null default now(),
    primary key (cik, kind))`);
}

async function run(kind: string, refresh: boolean, concurrency: number, limit: number): Promise<void> {
  // Panel companies whose new excerpt failed fall back to the old 5,000-char
  // excerpt from panel_10k, when it passes the same reference/risk checks.
  const rows = (await pool.query<{ cik: string; acc: string | null; text: string | null; old: string | null; have: Record<string, number> | null }>(`
    select bt.cik, bt.accession_number acc, bt.text,
           ${kind === "panel" ? `(select k.business from panel_10k k where k.cik = bt.cik and k.business is not null order by k.cohort_year limit 1)` : "null"} old,
           fs.scores have
      from business_text bt left join factor_score fs on fs.cik = bt.cik and fs.kind = bt.kind
     where bt.kind = $1 limit $2`, [kind, limit])).rows;
  const todo = rows.map((r) => {
    const fallback = !r.text && r.old && riskDensity(r.old) <= RISK_MAX && !/^item\s*1\.?\s*business\s*[,"”]/i.test(r.old) ? r.old : null;
    const text = r.text ?? fallback;
    const missing = refresh || !r.have ? FACTORS : FACTORS.filter((f) => !(f.name in r.have!));
    return { ...r, text, source: r.text ? "item1" : fallback ? "item1-old" : null, missing };
  }).filter((r) => r.text && r.missing.length);
  console.log(`score-factors ${kind}: ${todo.length} of ${rows.length} excerpts need scoring`);
  let cursor = 0, done = 0, failed = 0, cost = 0;
  const worker = async (): Promise<void> => {
    while (cursor < todo.length) {
      const r = todo[cursor++]!;
      try {
        const { scores, cost: c } = await decideFactors(r.text!, r.missing);
        cost += c;
        await pool.query(
          `insert into factor_score (cik, kind, model, accession_number, scores, source) values ($1,$2,$3,$4,$5,$6)
           on conflict (cik, kind) do update set scores = case when $7 then excluded.scores else factor_score.scores || excluded.scores end,
             model = excluded.model, accession_number = excluded.accession_number, source = excluded.source, scored_at = now()`,
          [r.cik, kind, JEV, r.acc, JSON.stringify(scores), r.source, refresh],
        );
      } catch (e) {
        failed++;
        if (failed < 20) console.error(`  ${r.cik} FAILED: ${e instanceof Error ? e.message : e}`);
      }
      if (++done % 250 === 0 || done === todo.length) console.log(`  ${kind} ${done}/${todo.length} (${failed} failed, $${cost.toFixed(4)})`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("score-factors.ts");
if (isMain) {
  await ensureTable();
  const kind = arg("kind", "both"), refresh = process.argv.includes("--refresh");
  const c = parseInt(arg("concurrency", "16"), 10), limit = parseInt(arg("limit", "100000"), 10);
  if (kind !== "current") await run("panel", refresh, c, limit);
  if (kind !== "panel") await run("current", refresh, c, limit);
  await pool.end();
}
