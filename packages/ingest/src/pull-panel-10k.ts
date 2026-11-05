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
// table of contents or a cross-reference ('see "Item 1. Business—Our
// Company"' inside the risk factors, which used to win because it ran on
// to Item 2). A real heading is not preceded by see/in/under/a quote, and
// its section ends at Item 1A when the filing has one; the longest such
// section wins. Excerpts that still read like risk factors are rejected.
// Letters may be split by markup ("Propertie s"), so words allow inner spaces.
const word = (w: string) => w.split("").join(String.raw`\s?`);
const ITEM = String.raw`i\s?t\s?e\s?m\s*`, SEP = String.raw`\s*[.:\-–—]?\s*`;
const HEAD = new RegExp(`${ITEM}1${SEP}${word("business")}`, "gi");
const END = new RegExp(`${ITEM}1\\s?a${SEP}${word("risk")}|${ITEM}2${SEP}${word("propert")}`, "gi");
const RISKY = /\b(may|could|might) (materially |adversely |negatively |significantly )*(adversely affect|harm|be adversely|have an adverse|have a material adverse)/gi;
// A mention rather than a heading: 'see "Item 1A. Risk Factors"', 'in Part I, Item 1: Business,'.
const isRef = (text: string, at: number) => {
  const before = text.slice(Math.max(0, at - 40), at);
  return /(see|in|under|refer to|described|discussed|included|and|our)\s*["“'(]?\s*(part\s*i\s*[,.\-–—]*\s*)?$/i.test(before) || /["“(]\s*(part\s*i\s*[,.\-–—]*\s*)?$/i.test(before);
};
export function businessExcerpt(text: string, maxChars = EXCERPT_CHARS): string | null {
  let best: { at: number; len: number } | null = null;
  for (const m of text.matchAll(HEAD)) {
    const at = m.index!;
    if (isRef(text, at)) continue;
    // The section ends at the next Item 1A or Item 2 heading that isn't itself a reference.
    let end = -1;
    END.lastIndex = at + 10;
    for (let e = END.exec(text); e; e = END.exec(text)) { if (!isRef(text, e.index)) { end = e.index; break; } if (e.index > at + 400_000) break; }
    const len = (end < 0 ? Math.min(text.length, at + 400_000) : end) - at;
    if (!best || len > best.len) best = { at, len };
  }
  if (!best || best.len < 1500) return null;
  let body = text.slice(best.at, best.at + best.len);
  // Drop a forward-looking-statements preamble: it is all "could adversely
  // affect" and says nothing about the business. It ends at the first
  // business heading after it.
  const fls = body.slice(0, 600).search(/cautionary|forward[- ]looking/i);
  if (fls >= 0) {
    const after = body.slice(fls + 200, fls + 15_000).search(/\b(overview|general|our company|company overview|introduction|our business|description of (the )?business)\b/i);
    if (after >= 0) body = `${body.slice(0, fls)} ${body.slice(fls + 200 + after)}`;
  }
  const out = body.slice(0, maxChars).replace(/\s+/g, " ").trim();
  return out.length < 1500 || riskDensity(out) > RISK_MAX ? null : out;
}
// Real Business sections (forward-looking boilerplate included) stay under this.
export const RISK_MAX = 3;
// Risk-factor phrases per 1,000 words; real Business sections sit well under 1.
export const riskDensity = (s: string) => ((s.match(RISKY)?.length ?? 0) / Math.max(1, s.length / 6)) * 1000;

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
