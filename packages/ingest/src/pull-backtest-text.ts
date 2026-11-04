// Text signals (quiet on AI, low revenue per employee) for a sample of the
// point-in-time backtest panel. Reading every historical 10-K would be ~20K
// documents; the deal count, not the control count, limits precision, so
// this reads every target plus CONTROLS_PER_TARGET random non-targets per
// target in the same cohort and weights the controls back up.
//
// Each sampled company is read from the last 10-K it filed in the 15 months
// before the cohort's as-of date. Thresholds match refresh-scores.ts, with
// the sampled controls standing in for the universe:
//   - quiet on AI: AI mentions per 10K words below the 25th percentile of
//     the cohort's controls
//   - low productivity: revenue per employee below the 25th percentile of
//     controls in the same 2-digit SIC (all cohorts pooled; 8+ needed)
//
// Run after build-backtest.ts. Reruns only fetch rows not yet read.
//
// CLI:
//   tsx src/pull-backtest-text.ts [--concurrency=4]

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { htmlToText, measure10K } from "./text-signals.js";

const CONTROLS_PER_TARGET = 5;

let lastFetch = 0;
async function secFetch(url: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    // Shared across workers: EDGAR fair access is 10 req/s; stay at 8.
    // Each request claims the next 125ms slot.
    const slot = Math.max(Date.now(), lastFetch + 125);
    lastFetch = slot;
    if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
    try {
      const res = await fetch(url, { headers: { "User-Agent": EDGAR_USER_AGENT }, signal: AbortSignal.timeout(90_000) });
      if (res.status === 404) return null;
      if (res.ok) return await res.text();
      if (attempt >= 5) throw new Error(`${res.status} ${url}`);
      await new Promise((r) => setTimeout(r, (res.status === 429 ? 15_000 : 2000) * 2 ** attempt));
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

interface FilingList { accessionNumber: string[]; filingDate: string[]; form: string[]; primaryDocument: string[] }
interface Submissions { sic: string; filings: { recent: FilingList; files: { name: string }[] } }

// All filings for a company, paging into the older submissions files only
// when the recent list doesn't reach back far enough.
const subs = new Map<string, Promise<{ sic: string | null; list: FilingList[] } | null>>();
function submissions(cik: string, oldest: string) {
  if (!subs.has(cik)) {
    subs.set(cik, (async () => {
      const raw = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
      if (!raw) return null;
      const s = JSON.parse(raw) as Submissions;
      const list = [s.filings.recent];
      const dates = s.filings.recent.filingDate;
      if (dates.length && dates[dates.length - 1]! > oldest) {
        for (const f of s.filings.files) {
          const page = await secFetch(`https://data.sec.gov/submissions/${f.name}`);
          if (page) list.push(JSON.parse(page) as FilingList);
        }
      }
      return { sic: s.sic || null, list };
    })());
  }
  return subs.get(cik)!;
}

const addMonths = (d: string, m: number) => {
  const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10);
};

async function sample(): Promise<void> {
  // Deterministic sample: controls ordered by a hash of (cik, cohort), so a
  // rebuilt panel keeps the rows (and 10-Ks) already read where it can.
  const picked = `
    select cik, cohort_year, target from (
      select p.cik, p.cohort_year, p.target,
             row_number() over (partition by p.cohort_year, p.target order by md5(p.cik || p.cohort_year)) as rn,
             ${CONTROLS_PER_TARGET} * count(*) filter (where p.target) over (partition by p.cohort_year) as n_controls
        from backtest_panel p
    ) x
    where target or rn <= n_controls`;
  await pool.query(`delete from backtest_text t where (t.cik, t.cohort_year, t.target) not in (${picked})`);
  await pool.query(`insert into backtest_text (cik, cohort_year, target, weight)
    select cik, cohort_year, target, 1 from (${picked}) s on conflict (cik, cohort_year) do nothing`);
  // Each control stands for (non-targets in cohort) / (controls sampled).
  await pool.query(`
    update backtest_text t set weight = case when t.target then 1 else w.weight end
      from (select p.cohort_year,
                   count(*) filter (where not p.target)::float
                     / nullif((select count(*) from backtest_text b where b.cohort_year = p.cohort_year and not b.target), 0) as weight
              from backtest_panel p group by 1) w
     where w.cohort_year = t.cohort_year`);
}

async function main(): Promise<void> {
  const concurrency = parseInt(process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "4", 10);
  await sample();
  const rows = (await pool.query<{ cik: string; cohort_year: number; as_of: string }>(
    `select t.cik, t.cohort_year, p.as_of::text from backtest_text t
       join backtest_panel p using (cik, cohort_year)
      where t.word_count is null and t.accession_number is null and t.sic is null`,
  )).rows;
  console.log(`pull-backtest-text: ${rows.length} sampled company-years to read`);
  let cursor = 0, done = 0, read = 0;
  const worker = async (): Promise<void> => {
    while (cursor < rows.length) {
      const r = rows[cursor++]!;
      const from = addMonths(r.as_of, -15);
      try {
        const s = await submissions(r.cik, from);
        let hit: { accession: string; date: string; doc: string } | null = null;
        for (const l of s?.list ?? []) {
          l.form.forEach((form, i) => {
            const date = l.filingDate[i]!;
            if (form === "10-K" && date <= r.as_of && date >= from && (!hit || date > hit.date)) {
              hit = { accession: l.accessionNumber[i]!, date, doc: l.primaryDocument[i]! };
            }
          });
        }
        const h = hit as { accession: string; date: string; doc: string } | null;
        let m: ReturnType<typeof measure10K> | null = null;
        if (h) {
          const html = await secFetch(`https://www.sec.gov/Archives/edgar/data/${Number(r.cik)}/${h.accession.replace(/-/g, "")}/${h.doc}`);
          if (html) { m = measure10K(htmlToText(html)); read++; }
        }
        // sic is set even when no 10-K is found, so the row isn't retried.
        await pool.query(
          `update backtest_text set accession_number = $3, filing_date = $4, sic = $5, word_count = $6, ai_term_count = $7, employees = $8
            where cik = $1 and cohort_year = $2`,
          [r.cik, r.cohort_year, h?.accession ?? null, h?.date ?? null, s?.sic ?? "", m?.words ?? null, m?.aiCount ?? null, m?.employees ?? null],
        );
      } catch (e) {
        console.error(`  ${r.cik} ${r.cohort_year} FAILED: ${e instanceof Error ? e.message : e}`);
      }
      if (++done % 100 === 0 || done === rows.length) console.log(`  ${done}/${rows.length} (${read} 10-Ks read)`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // Signals, with the sampled controls as the reference distribution.
  await pool.query(`
    with ai as (
      select t.cik, t.cohort_year, t.ai_term_count::float / t.word_count * 1e4 as rate
        from backtest_text t where t.word_count > 0
    ),
    ai_cut as (
      select a.cohort_year, percentile_cont(0.25) within group (order by a.rate) as cut
        from ai a join backtest_text t using (cik, cohort_year) where not t.target group by 1
    ),
    rpe as (
      select t.cik, t.cohort_year, left(t.sic, 2) as sic2, p.revenue / t.employees as rpe, t.target
        from backtest_text t join backtest_panel p using (cik, cohort_year)
       where t.employees > 0 and p.revenue > 0 and coalesce(t.sic, '') <> ''
    ),
    rpe_cut as (
      select sic2, percentile_cont(0.25) within group (order by rpe) as cut
        from rpe where not target group by 1 having count(*) >= 8
    )
    update backtest_text t set
      signal_ai_quiet = coalesce((select a.rate < c.cut from ai a join ai_cut c using (cohort_year)
                                   where a.cik = t.cik and a.cohort_year = t.cohort_year), false),
      signal_low_productivity = coalesce((select r.rpe < c.cut from rpe r join rpe_cut c using (sic2)
                                           where r.cik = t.cik and r.cohort_year = t.cohort_year), false)`);

  const s = await pool.query(`
    select sum(weight * target::int) / sum(weight) as base,
           sum(weight * (target and signal_ai_quiet)::int) / nullif(sum(weight * signal_ai_quiet::int), 0) as ai_rate,
           sum(weight * (target and signal_low_productivity)::int) / nullif(sum(weight * signal_low_productivity::int), 0) as rpe_rate,
           count(*) filter (where word_count > 0) as read, count(*) as n
      from backtest_text`);
  const x = s.rows[0];
  console.log(`sample ${x.n} (${x.read} with a 10-K): base ${(100 * x.base).toFixed(1)}%, ` +
    `quiet on AI lift ${(x.ai_rate / x.base).toFixed(2)}, low productivity lift ${(x.rpe_rate / x.base).toFixed(2)}`);
  await pool.end();
}

await main();
