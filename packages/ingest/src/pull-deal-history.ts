// Deal filings and Schedule 13Ds since mid-2017 for every SEC registrant,
// including companies that have since been bought and delisted. Source is
// the EDGAR quarterly form index (one gzip per quarter), so nothing depends
// on which companies are in the universe today.
//
//   deal_filings  <- original DEFM14A / PREM14A / SC 13E3 / SC TO-T. Merger
//                    proxies are filed by the issuer; tender offers and
//                    13E-3s list both parties, so the header's SUBJECT
//                    COMPANY decides the target. Issuers missing from
//                    `companies` are added from their submissions JSON;
//                    blank-check companies (SIC 6770) are skipped.
//   sc13d_index   <- every original Schedule 13D, one row per listed party.
//
// Acquirer and issuer_acquired come afterwards from `pull-deals --enrich`.
//
// CLI:
//   tsx src/pull-deal-history.ts                # 2017Q3 to the current quarter
//   tsx src/pull-deal-history.ts --from=2023Q1

import { gunzipSync } from "node:zlib";
import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { headerSubject } from "./header.js";

const DEAL_FORMS = new Set(["DEFM14A", "PREM14A", "SC 13E3", "SC TO-T"]);
const TWO_PARTY = new Set(["SC 13E3", "SC TO-T"]);
// Original 13Ds; the form was renamed when EDGAR moved it to XML in Dec 2024.
const SC13D_FORMS = new Set(["SC 13D", "SCHEDULE 13D"]);

let lastFetch = 0;
async function secFetch(url: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    // EDGAR fair access: at most 10 req/s; stay at 8.
    const wait = 125 - (Date.now() - lastFetch);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetch = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": EDGAR_USER_AGENT }, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status === 404) throw new Error(`404 ${url}`);
      if (attempt >= 5) throw new Error(`${res.status} ${url}`);
      await new Promise((r) => setTimeout(r, (res.status === 429 ? 15_000 : 2000) * 2 ** attempt));
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("404")) throw e;
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

interface IdxRow { form: string; name: string; cik: string; date: string; accession: string }

// "SC 13D   8X8 INC /DE/   1023731   2023-05-26  edgar/data/1023731/0001085146-23-002486.txt"
const LINE = /^(\S+(?: \S+)*?)\s{2,}(.+?)\s{2,}(\d+)\s+(\d{4}-\d{2}-\d{2})\s+edgar\/data\/\d+\/(\d{10}-\d{2}-\d{6})\.txt/;

async function readQuarter(year: number, q: number): Promise<IdxRow[]> {
  const text = gunzipSync(await secFetch(`https://www.sec.gov/Archives/edgar/full-index/${year}/QTR${q}/form.gz`)).toString("latin1");
  const rows: IdxRow[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m || !(DEAL_FORMS.has(m[1]!) || SC13D_FORMS.has(m[1]!))) continue;
    rows.push({ form: m[1]!, name: m[2]!.trim(), cik: m[3]!.padStart(10, "0"), date: m[4]!, accession: m[5]! });
  }
  return rows;
}

const folder = (cik: string, accession: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}`;

async function subjectOf(cik: string, accession: string): Promise<string | null> {
  const text = (await secFetch(`${folder(cik, accession)}/${accession}.hdr.sgml`).catch(() =>
    secFetch(`${folder(cik, accession)}/${accession}-index-headers.html`))).toString("latin1");
  return headerSubject(text);
}

interface Submissions { name: string; tickers?: string[]; sic: string; sicDescription: string | null }

// Returns false when the issuer should be skipped (blank-check company).
async function ensureCompany(cik: string): Promise<boolean> {
  const known = await pool.query(`select 1 from companies where cik = $1`, [cik]);
  if (known.rowCount) return true;
  const sub = JSON.parse((await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`)).toString("utf8")) as Submissions;
  if (sub.sic === "6770") return false;
  // Delisted issuers usually drop their ticker, and an old ticker may now
  // belong to someone else; fall back to a CIK placeholder.
  const want = sub.tickers?.[0]?.toUpperCase();
  const taken = want ? (await pool.query(`select 1 from companies where ticker = $1`, [want])).rowCount : 1;
  await pool.query(
    `insert into companies (cik, ticker, name, sic, sic_description) values ($1,$2,$3,$4,$5) on conflict do nothing`,
    [cik, want && !taken ? want : `CIK${Number(cik)}`, sub.name, sub.sic || null, sub.sicDescription],
  );
  return true;
}

function quarters(from: string): [number, number][] {
  const [fy, fq] = [Number(from.slice(0, 4)), Number(from.slice(5))];
  const now = new Date();
  const [ny, nq] = [now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) + 1];
  const out: [number, number][] = [];
  for (let y = fy, q = fq; y < ny || (y === ny && q <= nq); q === 4 ? (y++, q = 1) : q++) out.push([y, q]);
  return out;
}

async function main(): Promise<void> {
  const from = process.argv.find((a) => a.startsWith("--from="))?.split("=")[1] ?? "2017Q3";
  let deals = 0, skipped = 0, d13 = 0;
  for (const [y, q] of quarters(from)) {
    const rows = await readQuarter(y, q);

    // 13Ds: store every party; the backtest resolves the subject.
    const sc13d = rows.filter((r) => SC13D_FORMS.has(r.form));
    for (let i = 0; i < sc13d.length; i += 500) {
      const chunk = sc13d.slice(i, i + 500);
      await pool.query(
        `insert into sc13d_index (accession_number, cik, filing_date)
         select * from unnest($1::text[], $2::text[], $3::date[]) on conflict do nothing`,
        [chunk.map((r) => r.accession), chunk.map((r) => r.cik), chunk.map((r) => r.date)],
      );
    }
    d13 += sc13d.length;

    // Deal filings: one row per accession, keyed to the target.
    const byAccession = new Map<string, IdxRow[]>();
    for (const r of rows) if (DEAL_FORMS.has(r.form)) byAccession.set(r.accession, [...(byAccession.get(r.accession) ?? []), r]);
    const have = new Set((await pool.query<{ accession_number: string }>(
      `select accession_number from deal_filings where accession_number = any($1)`, [[...byAccession.keys()]],
    )).rows.map((r) => r.accession_number));
    for (const [accession, parties] of byAccession) {
      if (have.has(accession)) continue;
      const first = parties[0]!;
      try {
        const cik = TWO_PARTY.has(first.form) ? await subjectOf(first.cik, accession) : first.cik;
        if (!cik || !(await ensureCompany(cik))) { skipped++; continue; }
        await pool.query(
          `insert into deal_filings (accession_number, cik, form, filing_date, document_url)
           values ($1,$2,$3,$4,$5) on conflict (accession_number) do nothing`,
          [accession, cik, first.form, first.date, `${folder(first.cik, accession)}/${accession}.txt`],
        );
        deals++;
      } catch (e) {
        console.error(`  ${accession} FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(`${y}Q${q}: ${byAccession.size} deal filings, ${sc13d.length} 13D rows (totals: ${deals} new deals, ${skipped} skipped, ${d13} 13D rows)`);
  }
  await pool.end();
}

await main();
