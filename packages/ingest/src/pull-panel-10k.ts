// The 10-K in force on each backtest_panel as-of date, for every company-year
// (pull-backtest-text reads only a sample). Stores the text measures plus an
// excerpt of Item 1 (Business) for score-business.ts.
//
// Reruns only fetch rows not yet read.
//
// CLI:
//   tsx src/pull-panel-10k.ts [--concurrency=4]

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { htmlToText, measure10K } from "./text-signals.js";

const EXCERPT_CHARS = 5000;

let lastFetch = 0;
async function secFetch(url: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    // Shared slot pacer: EDGAR fair access is 10 req/s; stay at 8.
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
interface Submissions { filings: { recent: FilingList; files: { name: string; filingFrom?: string }[] } }

// One submissions fetch per company covers all its cohorts; older pages are
// fetched only when the recent list doesn't reach back far enough.
const subs = new Map<string, Promise<FilingList[] | null>>();
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
      return list;
    })());
  }
  return subs.get(cik)!;
}

const addMonths = (d: string, m: number) => {
  const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10);
};

// Item 1 (Business): the heading that starts real text rather than the
// table of contents, i.e. the one followed by the most text before Item 1A/2.
export function businessExcerpt(text: string): string | null {
  const heads = [...text.matchAll(/item\s*1\s*[.:\-–—]?\s*business\b/gi)].map((m) => m.index!);
  let best: { at: number; len: number } | null = null;
  for (const at of heads) {
    const rest = text.slice(at + 10, at + 200_000);
    const end = rest.search(/item\s*1a\s*[.:\-–—]?\s*risk|item\s*2\s*[.:\-–—]?\s*propert/i);
    const len = end < 0 ? rest.length : end;
    if (!best || len > best.len) best = { at, len };
  }
  if (!best || best.len < 1500) return null;
  return text.slice(best.at, best.at + Math.min(best.len, EXCERPT_CHARS)).replace(/\s+/g, " ").trim();
}

async function main(): Promise<void> {
  const concurrency = parseInt(process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "4", 10);
  await pool.query(`create table if not exists panel_10k (
    cik text not null, cohort_year smallint not null,
    accession_number text, filing_date date, word_count int, ai_term_count int, employees int,
    business text, read_at timestamptz not null default now(),
    primary key (cik, cohort_year))`);
  // Ordered by company so each submissions fetch serves all its cohorts.
  const rows = (await pool.query<{ cik: string; cohort_year: number; as_of: string }>(
    `select p.cik, p.cohort_year, p.as_of::text from backtest_panel p
      where not exists (select 1 from panel_10k k where k.cik = p.cik and k.cohort_year = p.cohort_year)
      order by p.cik, p.cohort_year`,
  )).rows;
  console.log(`pull-panel-10k: ${rows.length} company-years to read`);
  let cursor = 0, done = 0, read = 0, excerpts = 0;
  const started = Date.now();
  const worker = async (): Promise<void> => {
    while (cursor < rows.length) {
      const r = rows[cursor++]!;
      const from = addMonths(r.as_of, -15);
      try {
        const list = await submissions(r.cik, addMonths("2018-04-01", -15));
        let hit: { accession: string; date: string; doc: string } | null = null;
        for (const l of list ?? []) {
          for (let i = 0; i < l.form.length; i++) {
            const date = l.filingDate[i]!;
            if (l.form[i] === "10-K" && date <= r.as_of && date >= from && (!hit || date > hit.date)) {
              hit = { accession: l.accessionNumber[i]!, date, doc: l.primaryDocument[i]! };
            }
          }
        }
        let m: ReturnType<typeof measure10K> | null = null, business: string | null = null;
        if (hit) {
          const html = await secFetch(`https://www.sec.gov/Archives/edgar/data/${Number(r.cik)}/${hit.accession.replace(/-/g, "")}/${hit.doc}`);
          if (html) {
            const text = htmlToText(html);
            m = measure10K(text); read++;
            business = businessExcerpt(text);
            if (business) excerpts++;
          }
        }
        await pool.query(
          `insert into panel_10k (cik, cohort_year, accession_number, filing_date, word_count, ai_term_count, employees, business)
           values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (cik, cohort_year) do nothing`,
          [r.cik, r.cohort_year, hit?.accession ?? null, hit?.date ?? null, m?.words ?? null, m?.aiCount ?? null, m?.employees ?? null, business],
        );
      } catch (e) {
        console.error(`  ${r.cik} ${r.cohort_year} FAILED: ${e instanceof Error ? e.message : e}`);
      }
      if (++done % 250 === 0 || done === rows.length) {
        const rate = done / ((Date.now() - started) / 60_000);
        console.log(`  ${done}/${rows.length} (${read} 10-Ks, ${excerpts} business excerpts) ~${Math.round((rows.length - done) / rate)} min left`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await pool.end();
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("pull-panel-10k.ts");
if (isMain) await main();
