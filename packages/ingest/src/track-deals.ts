// Deal tracker, meant to run daily:
//
//   1. Announcements: EDGAR full-text search for 8-Ks reporting a merger
//      agreement (Item 1.01, "Agreement and Plan of Merger") by companies
//      we track, so a deal shows up the day it's announced rather than
//      weeks later with the proxy.
//   2. Classification: every deal filing since SINCE without a deal_class
//      row goes through classify-deals (buyer, buyer type, whether the
//      filer is the one being acquired).
//   3. Rollup buyers: deal_filings.rollup_buyer is set when the classified
//      buyer matches a rollup_buyers alias (acquisition vehicles such as
//      Long Lake's "Gaia Purchaser" included). Name mentions alone no
//      longer count.
//   4. Scorecard: the first time a company is seen being acquired, its
//      AI-rollup model score at that moment goes to rollup_scorecard, so the
//      model's record on new deals accumulates honestly.
//
// CLI:
//   tsx src/track-deals.ts                    # last 14 days of announcements
//   tsx src/track-deals.ts --from=2025-01-01  # backfill announcements

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { classifyDeals, setSecPace } from "./classify-deals.js";

const SINCE = "2025-01-01"; // classification and scorecard window
// The model's training labels run through deals filed before this date
// (last cohort's 12-month window); later deals are out of sample.
const TRAINED_THROUGH = "2026-04-01";

// AI-rollup and holdco buyers. Aliases are matched case-insensitively
// against the buyer the deal document names, including the shell
// companies buyers acquire through.
const ROLLUP_BUYERS: { slug: string; name: string; aliases: string[]; kind: string; note: string }[] = [
  { slug: "long-lake", name: "Long Lake", aliases: ["Long Lake", "Gaia Purchaser", "Gaia Parent"], kind: "AI holding company",
    note: "Buys services businesses and runs them with AI; HOA management, payroll, business travel (Amex GBT, 2026)." },
  { slug: "thrive-holdings", name: "Thrive Holdings", aliases: ["Thrive Holdings"], kind: "AI holding company",
    note: "Thrive Capital's permanent-capital vehicle, backed by OpenAI; accounting, IT services, built environment, ADT (2026)." },
  { slug: "general-catalyst", name: "General Catalyst", aliases: ["General Catalyst", "Transcarent"], kind: "Venture firm, creation-to-rollup strategy",
    note: "Incubates AI-native platforms that acquire services businesses; Transcarent (Accolade) is a portfolio company." },
  { slug: "ithaca-holdings", name: "Ithaca Holdings", aliases: ["Ithaca Holdings", "Ithaca Holdco"], kind: "Technology holding company",
    note: "Technology and media holdco; taking Bumble private (2026)." },
  { slug: "sequence-ai-holdings", name: "Sequence AI Holdings", aliases: ["Sequence AI"], kind: "AI holding company",
    note: "Taking Baldwin Insurance Group (insurance brokerage) private (2026)." },
  { slug: "crete-professionals-alliance", name: "Crete Professionals Alliance", aliases: ["Crete Professionals", "Crete PA"], kind: "AI accounting rollup",
    note: "Thrive Holdings-backed accounting firm rollup." },
  { slug: "shield-technology-partners", name: "Shield Technology Partners", aliases: ["Shield Technology Partners"], kind: "AI IT-services rollup",
    note: "Thrive Holdings-backed IT services platform." },
];

let lastFetch = 0;
async function secJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const slot = Math.max(Date.now(), lastFetch + 150); // under EDGAR's 10 req/s
    lastFetch = slot;
    if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
    try {
      const res = await fetch(url, { headers: { "User-Agent": EDGAR_USER_AGENT }, signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return null;
      if (res.ok) return (await res.json()) as T;
      if (attempt >= 4) throw new Error(`${res.status} ${url}`);
      await new Promise((r) => setTimeout(r, (res.status === 429 ? 15_000 : 2000) * 2 ** attempt));
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function migrate(): Promise<void> {
  await pool.query(`alter table deal_filings add column if not exists rollup_buyer text`);
  await pool.query(`create table if not exists rollup_buyers (
    slug text primary key, name text not null, aliases text[] not null, kind text not null, note text not null)`);
  await pool.query(`create table if not exists rollup_scorecard (
    cik text primary key, accession_number text not null, announced date not null, buyer text, buyer_type text,
    rollup_buyer text, services_business boolean, probability double precision, multiple double precision,
    percentile double precision, inputs_before boolean, in_training boolean not null, recorded_at timestamptz not null default now())`);
  for (const b of ROLLUP_BUYERS) {
    await pool.query(
      `insert into rollup_buyers values ($1,$2,$3,$4,$5) on conflict (slug) do update set
         name = excluded.name, aliases = excluded.aliases, kind = excluded.kind, note = excluded.note`,
      [b.slug, b.name, b.aliases, b.kind, b.note]);
  }
}

interface Hit { _id: string; _source: { ciks: string[]; form: string; file_date: string; items?: string[]; root_forms?: string[] } }

// 8-K merger announcements by companies we already track (the universe and
// every past deal target). One row per filing; the primary document is
// preferred over exhibits.
async function pullAnnouncements(from: string, to: string): Promise<number> {
  const known = new Set((await pool.query<{ cik: string }>(
    `select cik from companies where coalesce(sic, '') <> '6770'`)).rows.map((r) => r.cik));
  const best = new Map<string, { cik: string; date: string; doc: string }>();
  for (let offset = 0; offset < 10_000; offset += 100) {
    const q = new URLSearchParams({ q: `"Agreement and Plan of Merger"`, forms: "8-K", dateRange: "custom", startdt: from, enddt: to, from: String(offset) });
    const res = await secJson<{ hits: { total: { value: number }; hits: Hit[] } }>(`https://efts.sec.gov/LATEST/search-index?${q}`);
    const hits = res?.hits.hits ?? [];
    for (const h of hits) {
      if (!h._source.items?.includes("1.01")) continue;
      const cik = h._source.ciks.find((c) => known.has(c));
      if (!cik) continue;
      const [accession, doc] = h._id.split(":") as [string, string];
      const prev = best.get(accession);
      // Primary 8-K document over exhibits (ex2-1, ex99-1, ...).
      if (!prev || (/ex[-_]?\d/i.test(prev.doc) && !/ex[-_]?\d/i.test(doc))) best.set(accession, { cik, date: h._source.file_date, doc });
    }
    if (hits.length < 100) break;
  }
  let added = 0;
  for (const [accession, h] of best) {
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(h.cik)}/${accession.replace(/-/g, "")}/${h.doc}`;
    const r = await pool.query(
      `insert into deal_filings (accession_number, cik, form, filing_date, document_url) values ($1,$2,'8-K',$3,$4)
       on conflict (accession_number) do nothing`, [accession, h.cik, h.date, url]);
    added += r.rowCount ?? 0;
  }
  console.log(`announcements ${from}..${to}: ${best.size} merger-agreement 8-Ks from tracked companies, ${added} new`);
  return added;
}

async function tagRollupBuyers(): Promise<void> {
  // Reset, then match the classified buyer against each alias.
  await pool.query(`update deal_filings set rollup_buyer = null where rollup_buyer is not null`);
  const r = await pool.query(`
    update deal_filings d set rollup_buyer = b.slug
      from deal_class c, rollup_buyers b
     where c.accession_number = d.accession_number and c.issuer_acquired
       and exists (select 1 from unnest(b.aliases) a where c.buyer ilike '%' || a || '%')`);
  console.log(`rollup buyers: ${r.rowCount} deal filings tagged`);
}

async function scorecard(): Promise<void> {
  const r = await pool.query(`
    insert into rollup_scorecard (cik, accession_number, announced, buyer, buyer_type, rollup_buyer, services_business,
                                  probability, multiple, percentile, inputs_before, in_training)
    select distinct on (d.cik) d.cik, d.accession_number, d.filing_date, c.buyer, c.buyer_type, d.rollup_buyer, c.services_business,
           s.probability, s.multiple, s.percentile,
           -- the score's 10-K predates the announcement
           cb.filing_date < d.filing_date,
           d.filing_date < $2::date
      from deal_filings d
      join deal_class c on c.accession_number = d.accession_number
      left join sponsor_scores s on s.cik = d.cik
      left join current_business cb on cb.cik = d.cik
     where c.issuer_acquired and not d.is_self_filed and d.filing_date >= $1::date
       and not exists (select 1 from rollup_scorecard k where k.cik = d.cik)
     order by d.cik, d.filing_date`, [SINCE, TRAINED_THROUGH]);
  console.log(`scorecard: ${r.rowCount} new deals recorded`);
  // Buyer tags can change as the registry grows.
  await pool.query(`update rollup_scorecard k set rollup_buyer = d.rollup_buyer from deal_filings d where d.accession_number = k.accession_number`);
}

async function main(): Promise<void> {
  await migrate();
  const to = iso(new Date());
  const from = process.argv.find((a) => a.startsWith("--from="))?.split("=")[1] ?? iso(new Date(Date.now() - 14 * 864e5));
  await pullAnnouncements(from, to);
  setSecPace(150);
  const n = await classifyDeals(`select accession_number from deal_filings where not is_self_filed and filing_date >= '${SINCE}'`, 6);
  console.log(`classified ${n} deal filings`);
  await tagRollupBuyers();
  await scorecard();
  const s = await pool.query(`
    select b.name, count(distinct d.cik)::int targets, string_agg(distinct c.ticker, ', ') tickers
      from deal_filings d join rollup_buyers b on b.slug = d.rollup_buyer join companies c using (cik) group by 1 order by 2 desc`);
  console.table(s.rows);
  await pool.end();
}

await main();
