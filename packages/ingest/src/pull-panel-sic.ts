// SIC codes for backtest_panel, for industry effects in fit-model.ts.
// Uses the codes already stored on companies and backtest_text, then fetches
// the submissions JSON for the rest. Run after build-backtest.ts (a rebuild
// clears the column); reruns only fetch what is still missing.
//
// CLI:
//   tsx src/pull-panel-sic.ts

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";

async function main(): Promise<void> {
  await pool.query(`
    update backtest_panel p set sic = coalesce(
      (select nullif(c.sic, '') from companies c where c.cik = p.cik),
      (select nullif(t.sic, '') from backtest_text t where t.cik = p.cik and coalesce(t.sic, '') <> '' limit 1))
     where p.sic is null`);
  const ciks = (await pool.query<{ cik: string }>(`select distinct cik from backtest_panel where sic is null`)).rows.map((r) => r.cik);
  console.log(`pull-panel-sic: ${ciks.length} companies to look up`);
  let done = 0, last = 0;
  for (const cik of ciks) {
    const wait = 125 - (Date.now() - last); // EDGAR fair access: stay at 8 req/s
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    let sic = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
        headers: { "User-Agent": EDGAR_USER_AGENT }, signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (res?.status === 404) break;
      if (res?.ok) { sic = ((await res.json()) as { sic?: string }).sic ?? ""; break; }
      await new Promise((r) => setTimeout(r, (res?.status === 429 ? 15_000 : 2000) * 2 ** attempt));
    }
    // '' marks "looked up, none", so the company isn't fetched again.
    await pool.query(`update backtest_panel set sic = $2 where cik = $1`, [cik, sic]);
    if (++done % 100 === 0) console.log(`  ${done}/${ciks.length}`);
  }
  const s = await pool.query(`select count(*) filter (where coalesce(sic, '') <> '')::int have, count(*)::int n from backtest_panel`);
  console.log(`sic on ${s.rows[0].have}/${s.rows[0].n} company-years`);
  await pool.end();
}

await main();
