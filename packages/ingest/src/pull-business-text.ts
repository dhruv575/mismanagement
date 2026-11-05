// Long Item 1 (Business) excerpts, stored once so factor experiments never
// refetch EDGAR. Two kinds:
//   panel   -- each backtest company's earliest panel 10-K (point-in-time for
//              every cohort the score is used in; see score-business.ts)
//   current -- each current company's latest 10-K (what the live site scores)
//
// CLI:
//   tsx src/pull-business-text.ts [--kind=panel|current|both] [--refresh] [--concurrency=6] [--limit=N]

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { businessExcerpt, riskDensity } from "./pull-panel-10k.js";
import { htmlToText } from "./text-signals.js";

export const LONG_CHARS = 14_000;
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;

let lastFetch = 0;
export async function secText(url: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const slot = Math.max(Date.now(), lastFetch + 125); // EDGAR fair access: stay at 8 req/s
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

const docUrl = (cik: string, acc: string, doc: string) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, "")}/${doc}`;

export async function ensureTable(): Promise<void> {
  await pool.query(`create table if not exists business_text (
    cik text not null, kind text not null, accession_number text, filing_date date,
    text text, risk_density real, fetched_at timestamptz not null default now(),
    primary key (cik, kind))`);
}

// Primary document name for an accession, from the filing index.
async function primaryDoc(cik: string, acc: string): Promise<string | null> {
  const raw = await secText(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, "")}/index.json`);
  if (!raw) return null;
  const items = (JSON.parse(raw) as { directory: { item: { name: string; size?: string }[] } }).directory.item;
  // The 10-K body is the largest .htm that isn't an exhibit.
  const htm = items.filter((i) => /\.html?$/i.test(i.name) && !/^(r\d+|ex|exhibit|filingsummary)/i.test(i.name) && !/ex-?\d/i.test(i.name));
  htm.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
  return htm[0]?.name ?? null;
}

async function run(kind: "panel" | "current", refresh: boolean, concurrency: number, limit: number): Promise<void> {
  const skip = refresh ? "" : `and not exists (select 1 from business_text bt where bt.cik = x.cik and bt.kind = '${kind}')`;
  const rows = kind === "panel"
    ? (await pool.query<{ cik: string; acc: string; date: string }>(`select * from (
        select distinct on (cik) cik, accession_number acc, filing_date::text date from panel_10k
         where accession_number is not null order by cik, cohort_year) x where true ${skip} limit $1`, [limit])).rows
    : (await pool.query<{ cik: string; acc: null; date: null }>(`select x.cik, null acc, null date from (select t.cik, c.market_cap_at_universe_pull mcap from takeover_scores t left join companies c using (cik)) x where true ${skip} order by x.mcap desc nulls last limit $1`, [limit])).rows;
  console.log(`business-text ${kind}: ${rows.length} companies`);
  let cursor = 0, done = 0, got = 0, failed = 0;
  const worker = async (): Promise<void> => {
    while (cursor < rows.length) {
      const r = rows[cursor++]!;
      try {
        let acc = r.acc, date = r.date, doc: string | null = null;
        if (kind === "current") {
          const sub = await secText(`https://data.sec.gov/submissions/CIK${r.cik}.json`);
          const f = sub ? (JSON.parse(sub) as { filings: { recent: { form: string[]; accessionNumber: string[]; filingDate: string[]; primaryDocument: string[] } } }).filings.recent : null;
          const i = f ? f.form.findIndex((x) => x === "10-K") : -1;
          if (f && i >= 0) { acc = f.accessionNumber[i]!; date = f.filingDate[i]!; doc = f.primaryDocument[i]!; }
        } else if (acc) doc = await primaryDoc(r.cik, acc);
        let text: string | null = null;
        if (acc && doc) {
          const html = await secText(docUrl(r.cik, acc, doc));
          text = html ? businessExcerpt(htmlToText(html), LONG_CHARS) : null;
        }
        if (text) got++;
        await pool.query(
          `insert into business_text (cik, kind, accession_number, filing_date, text, risk_density) values ($1,$2,$3,$4,$5,$6)
           on conflict (cik, kind) do update set accession_number = excluded.accession_number, filing_date = excluded.filing_date,
             text = excluded.text, risk_density = excluded.risk_density, fetched_at = now()`,
          [r.cik, kind, acc, date, text, text ? riskDensity(text) : null],
        );
      } catch (e) {
        failed++;
        console.error(`  ${r.cik} FAILED: ${e instanceof Error ? e.message : e}`);
      }
      if (++done % 250 === 0 || done === rows.length) console.log(`  ${kind} ${done}/${rows.length} (${got} excerpts, ${failed} failed)`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("pull-business-text.ts");
if (isMain) {
  await ensureTable();
  const kind = arg("kind", "both"), refresh = process.argv.includes("--refresh");
  const c = parseInt(arg("concurrency", "6"), 10), limit = parseInt(arg("limit", "100000"), 10);
  if (kind !== "current") await run("panel", refresh, c, limit);
  if (kind !== "panel") await run("current", refresh, c, limit);
  await pool.end();
}
