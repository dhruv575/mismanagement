// Inputs for the AI take-private screen. All deterministic -- no LLM.
//
// Per issuer (R3K default, or tickers on the CLI):
//   1. companies.sic           <- submissions JSON
//   2. headcount               <- latest 10-K human-capital sentence (regex)
//   3. filing_text_signals     <- latest 10-K word count + AI/automation term count
//   4. deal_filings            <- DEFM14A / PREM14A / SC 13E3 / SC TO-T on the
//                                 issuer, with cash price + premium parsed out
//
// Separately (--buyers), EDGAR full-text search for known AI-rollup buyers
// finds deal filings on issuers that have already left the R3K (e.g. GBTG,
// JHG once taken private), and upserts those issuers into `companies`.
//
// CLI:
//   tsx src/pull-deals.ts                 # all R3K issuers
//   tsx src/pull-deals.ts ADT CBZ         # subset by ticker
//   tsx src/pull-deals.ts --buyers        # full-text search for buyer names only
//   tsx src/pull-deals.ts --enrich        # acquirer from EDGAR headers (tender offers, 13E-3) or the LLM (merger proxies)
//   tsx src/pull-deals.ts --concurrency=4

import { pool } from "./db.js";
import { z } from "zod";
import { EDGAR_USER_AGENT } from "./env.js";
import { callLLM } from "./llm.js";
import { resolveTargets, type IssuerSeed } from "./issuers.js";
import { AI_TERMS, HEADCOUNT, htmlToText } from "./text-signals.js";

const DEAL_FORMS = new Set(["DEFM14A", "PREM14A", "SC 13E3", "SC 13E3/A", "SC TO-T", "SC TO-T/A"]);

// Buyer names searched in EDGAR full-text search. One form per query: a long
// comma-separated forms list silently returned zero hits during testing.
const BUYERS = ["Long Lake", "Thrive Holdings", "General Catalyst"];
const BUYER_FORMS = ["DEFM14A", "PREM14A", "SC 13E3", "8-K"];

interface Recent {
  accessionNumber: string[];
  filingDate: string[];
  reportDate: string[];
  form: string[];
  primaryDocument: string[];
}
interface Submissions {
  name: string;
  tickers?: string[];
  sic: string;
  sicDescription: string | null;
  filings: { recent: Recent };
}

async function readPrefix(res: Response, bytes: number): Promise<string> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (n < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

let lastFetch = 0;
async function secFetch(url: string, range?: number): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    // EDGAR fair-access limit is 10 req/s across the process.
    const wait = 120 - (Date.now() - lastFetch);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetch = Date.now();
    // range: read only the first N bytes (full-submission .txt files run to tens of MB).
    const res = await fetch(url, { headers: { "User-Agent": EDGAR_USER_AGENT, ...(range ? { Range: `bytes=0-${range}` } : {}) } });
    // SEC ignores Range on Archives; stop reading the stream once we have enough.
    const text = !res.ok ? "" : range ? await readPrefix(res, range) : await res.text();
    // efts.sec.gov intermittently returns 200 with an OpenSearch ConnectionError body.
    if (res.ok && !text.includes('"errorType"')) return text;
    if (res.status === 404) throw new Error(`404 ${url}`);
    if (attempt >= 5) throw new Error(`${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

const docUrl = (cik: string, accession: string, doc: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${doc}`;

// Merger proxies only: amendments and 13E-3 exhibits quote other prices
// (prior offers, comparable deals) before the merger consideration.
const PRICED_FORMS = new Set(["DEFM14A", "PREM14A"]);

function parseDealTerms(text: string): { price: number | null; premium: number | null; acquirer: string | null } {
  const price = text.match(/\$(\d{1,4}(?:\.\d{1,2})?)\s+(?:per share\s+)?in cash/i);
  const premium = text.match(/premium of approximately (\d{1,3}(?:\.\d)?)\s*%/i);
  // "Parent is an affiliate of Grant Thornton Advisors LLC" / "... controlled by ..."
  const parent = text.match(/Parent (?:is|will be) (?:an affiliate of|controlled by|a subsidiary of|wholly owned by) ([A-Z][\w&.,' -]{2,80}?)(?: \(|,| and |\.)/);
  return {
    price: price ? Number(price[1]) : null,
    premium: premium ? Number(premium[1]) : null,
    acquirer: parent ? parent[1]!.trim() : null,
  };
}

// matchedBuyer = the search term that found the filing. A name match is not
// attribution: bankers' comparable-deal tables cite other buyers' deals.
async function upsertDeal(
  cik: string, accession: string, form: string, date: string, url: string, matchedBuyer: string | null,
): Promise<void> {
  const exists = await pool.query(`select 1 from deal_filings where accession_number = $1`, [accession]);
  if (exists.rowCount) {
    if (matchedBuyer) await pool.query(`update deal_filings set matched_buyer = coalesce(matched_buyer, $2) where accession_number = $1`, [accession, matchedBuyer]);
    return;
  }
  const terms = PRICED_FORMS.has(form)
    ? parseDealTerms(htmlToText(await secFetch(url)))
    : { price: null, premium: null, acquirer: null };
  await pool.query(
    `insert into deal_filings (accession_number, cik, form, filing_date, acquirer, matched_buyer, price_per_share, premium_pct, document_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (accession_number) do nothing`,
    [accession, cik, form, date, terms.acquirer, matchedBuyer, terms.price, terms.premium, url],
  );
}

async function pullOne(issuer: IssuerSeed): Promise<void> {
  const sub = JSON.parse(await secFetch(`https://data.sec.gov/submissions/CIK${issuer.cik}.json`)) as Submissions;
  await pool.query(`update companies set sic = $2, sic_description = coalesce(sic_description, $3) where cik = $1`, [
    issuer.cik, sub.sic || null, sub.sicDescription,
  ]);

  const r = sub.filings.recent;
  const tenK = r.form.findIndex((f) => f === "10-K");
  if (tenK >= 0) {
    const accession = r.accessionNumber[tenK]!;
    const text = htmlToText(await secFetch(docUrl(issuer.cik, accession, r.primaryDocument[tenK]!)));
    const words = Math.round(text.length / 6);
    const aiCount = text.match(AI_TERMS)?.length ?? 0;
    await pool.query(
      `insert into filing_text_signals (accession_number, cik, filing_date, word_count, ai_term_count)
       values ($1,$2,$3,$4,$5)
       on conflict (accession_number) do update set word_count = excluded.word_count, ai_term_count = excluded.ai_term_count`,
      [accession, issuer.cik, r.filingDate[tenK], words, aiCount],
    );
    const m = text.match(HEADCOUNT);
    const employees = m ? Number(m[1]!.replace(/,/g, "")) : NaN;
    // Floor rejects matches like "100 people" in an unrelated context.
    if (Number.isFinite(employees) && employees >= 10) {
      const fy = Number((r.reportDate[tenK] || r.filingDate[tenK]!).slice(0, 4));
      await pool.query(
        `insert into headcount (cik, fiscal_year, employees, matched_text, accession_number)
         values ($1,$2,$3,$4,$5)
         on conflict (cik, fiscal_year) do update set employees = excluded.employees,
           matched_text = excluded.matched_text, accession_number = excluded.accession_number`,
        [issuer.cik, fy, employees, m![0].trim(), accession],
      );
    }
  }

  for (let i = 0; i < r.form.length; i++) {
    if (!DEAL_FORMS.has(r.form[i]!)) continue;
    await upsertDeal(issuer.cik, r.accessionNumber[i]!, r.form[i]!, r.filingDate[i]!,
      docUrl(issuer.cik, r.accessionNumber[i]!, r.primaryDocument[i]!), null);
  }
}

async function pullBuyers(): Promise<void> {
  for (const buyer of BUYERS) {
    for (const form of BUYER_FORMS) {
      const q = new URLSearchParams({ q: `"${buyer}"`, forms: form, dateRange: "custom", startdt: "2025-01-01",
        enddt: new Date().toISOString().slice(0, 10) });
      const res = JSON.parse(await secFetch(`https://efts.sec.gov/LATEST/search-index?${q}`)) as {
        hits: { hits: { _id: string; _source: { ciks: string[]; form: string; file_date: string; items?: string[]; display_names?: string[] } }[] };
      };
      for (const h of res.hits.hits) {
        // 8-Ks only when they report a material agreement (Item 1.01).
        if (form === "8-K" && !h._source.items?.includes("1.01")) continue;
        const [accession, doc] = h._id.split(":") as [string, string];
        const cik = h._source.ciks[0]!;
        // Issuer may be delisted and missing from companies -- seed it from submissions.
        const known = await pool.query(`select 1 from companies where cik = $1`, [cik]);
        if (!known.rowCount) {
          const sub = JSON.parse(await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`)) as Submissions;
          await pool.query(
            `insert into companies (cik, ticker, name, sic, sic_description) values ($1,$2,$3,$4,$5)
             on conflict do nothing`,
            // Delisted issuers drop their ticker from submissions; the search
            // hit's display name keeps it, e.g. "Global Business Travel Group, Inc.  (GBTG)  (CIK ...)".
            [cik, sub.tickers?.[0] ?? h._source.display_names?.[0]?.match(/\(([A-Z.]{1,6})\)/)?.[1] ?? `CIK${Number(cik)}`,
              sub.name, sub.sic || null, sub.sicDescription],
          );
        }
        await upsertDeal(cik, accession, h._source.form, h._source.file_date, docUrl(cik, accession, doc), buyer);
      }
      console.log(`  ${buyer} / ${form}: ${res.hits.hits.length} hit(s)`);
    }
  }
}

// ---- --enrich: fill acquirer (and proxy terms) on stored deal filings ----

// Tender offers and 13E-3s are filed by the bidder, so the EDGAR header's
// FILED BY block names the acquirer. A 13E-3 also lists the issuer as a
// filer; skip it. The SUBJECT block says who the target is: an issuer's
// submissions feed also lists tender offers it made for other companies.
async function readHeader(row: { cik: string; accession_number: string; document_url: string }): Promise<{ filers: string[]; subjectCik: string | null }> {
  const accnNoDash = row.accession_number.replace(/-/g, "");
  const folder = row.document_url.slice(0, row.document_url.indexOf(accnNoDash) + accnNoDash.length);
  const filers: string[] = [];
  let text: string;
  try {
    text = htmlToText(await secFetch(`${folder}/${row.accession_number}-index-headers.html`));
  } catch {
    // Older filings have no header page; the index page tags each company
    // "(Filed by)" or "(Subject)" followed by its CIK.
    const html = await secFetch(`${folder}/${row.accession_number}-index.htm`);
    let subjectCik: string | null = null;
    for (const m of html.matchAll(/companyName">([^<]+?) \((Filed by|Subject)\)[\s\S]*?(\d{10})/g)) {
      if (m[2] === "Subject") subjectCik = m[3]!;
      else if (m[3] !== row.cik) filers.push(m[1]!.replace(/\s+/g, " ").trim());
    }
    return { filers, subjectCik };
  }
  const subjectCik = text.split("SUBJECT COMPANY:")[1]?.split("FILED BY:")[0]?.split("CENTRAL INDEX KEY:")[1]?.trim().slice(0, 10) ?? null;
  for (const part of text.split("FILED BY:").slice(1)) {
    const name = part.split("COMPANY CONFORMED NAME:")[1]?.split("CENTRAL INDEX KEY:")[0]?.trim();
    const cik = part.split("CENTRAL INDEX KEY:")[1]?.trim().slice(0, 10);
    if (name && cik && cik !== row.cik) filers.push(name);
  }
  return { filers, subjectCik };
}

const ProxyTerms = z.object({
  issuer_acquired: z.boolean().nullable().default(null),
  acquirer: z.string().nullable().default(null),
  sponsor: z.string().nullable().default(null),
  price_per_share: z.number().nullable().default(null),
  premium_pct: z.number().nullable().default(null),
});
const PROXY_PROMPT =
  "You read the opening of a US merger proxy (DEFM14A or PREM14A) or going-private Schedule 13E-3 and extract the deal terms. " +
  "issuer_acquired: true only if the filing company is being acquired or taken private by another party; false for " +
  "reorganizations, reincorporations, reverse splits, spin-offs, or deals where the filing company is the buyer. " +
  "acquirer: the company or fund acquiring the issuer (the 'Parent' or buyer), not the merger subsidiary; null if none. " +
  "sponsor: the private-equity firm or ultimate owner behind the acquirer if one is named, else null. " +
  "price_per_share: cash consideration per share in US dollars, null if stock-only or not stated. " +
  "premium_pct: the stated premium to the unaffected price in percent, null if not stated. " +
  "Use only facts stated in the text. Return only JSON with these five keys.";

// Small models sometimes answer with the schema's own wording.
const realName = (s: string | null) =>
  s && s.length <= 150 && !/\b(else null|if one is named|ultimate owner|the acquirer|not stated)\b|^null$/i.test(s) ? s : null;

async function enrich(concurrency: number): Promise<void> {
  const rows = (await pool.query<{ cik: string; accession_number: string; form: string; document_url: string; name: string }>(
    `select d.cik, d.accession_number, d.form, d.document_url, c.name from deal_filings d
       join companies c using (cik)
      where d.acquirer is null and d.issuer_acquired is null and not d.is_self_filed and d.form <> '8-K' and d.document_url is not null`,
  )).rows;
  // Reorganizations and spin-offs file merger proxies too; there the
  // "acquirer" is the issuer itself (or a new holding company of it).
  const core = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).find((w) => w.length > 2 && !["the", "new"].includes(w)) ?? "";
  const isSelf = (acquirer: string, issuer: string) => core(acquirer) !== "" && core(acquirer) === core(issuer);
  console.log(`enrich: ${rows.length} deal filings without an acquirer`);
  let cursor = 0, done = 0, filled = 0;
  const worker = async (): Promise<void> => {
    while (cursor < rows.length) {
      const r = rows[cursor++]!;
      // Read the document with the model: merger proxies always, and 13E-3s
      // whose header lists only the issuer and its insiders.
      const fromText = async (): Promise<boolean> => {
        // Full-submission .txt: skip the SGML header, read the first document.
        const raw = await secFetch(r.document_url, r.document_url.endsWith(".txt") ? 1_500_000 : undefined);
        const text = htmlToText(raw.slice(Math.max(0, raw.indexOf("<DOCUMENT>")))).slice(0, 40_000);
        const { json } = await callLLM({ systemPrompt: PROXY_PROMPT, userPrompt: text, maxTokens: 300 });
        const t = ProxyTerms.parse(json);
        const named = t.issuer_acquired === false ? null : realName(t.sponsor) ?? realName(t.acquirer);
        const acquirer = named && !isSelf(named, r.name) ? named : null;
        const priced = PRICED_FORMS.has(r.form);
        // A proxy where the filer is not being bought (reorganization,
        // spin-off, buyer-side vote) is not a deal on this issuer.
        await pool.query(
          `update deal_filings set acquirer = $2, price_per_share = coalesce(price_per_share, $3),
                  premium_pct = coalesce(premium_pct, $4), issuer_acquired = $5,
                  is_self_filed = is_self_filed or $5 is false where accession_number = $1`,
          [r.accession_number, acquirer, priced ? t.price_per_share : null, priced ? t.premium_pct : null, t.issuer_acquired],
        );
        return acquirer != null;
      };
      try {
        if (PRICED_FORMS.has(r.form)) {
          if (await fromText()) filled++;
        } else {
          const { filers, subjectCik } = await readHeader(r);
          const self = subjectCik != null && subjectCik !== r.cik;
          await pool.query(
            `update deal_filings set acquirer = $2, is_self_filed = $3 where accession_number = $1`,
            [r.accession_number, self ? null : filers.join("; ") || null, self],
          );
          if (!self && filers.length) filled++;
          else if (!self && r.form.startsWith("SC 13E3") && (await fromText())) filled++;
        }
      } catch (e) {
        console.error(`  ${r.accession_number} FAILED: ${e instanceof Error ? e.message : e}`);
      }
      if (++done % 100 === 0 || done === rows.length) console.log(`  progress: ${done}/${rows.length} (${filled} filled)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
  // A buyer counts as matched when it is the acquirer, not just mentioned.
  for (const buyer of BUYERS) {
    await pool.query(`update deal_filings set matched_buyer = $1 where matched_buyer is null and acquirer ilike '%' || $1 || '%'`, [buyer]);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--buyers")) {
    await pullBuyers();
    await pool.end();
    return;
  }
  if (argv.includes("--enrich")) {
    await enrich(parseInt(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "4", 10));
    await pool.end();
    return;
  }
  const concurrency = parseInt(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "2", 10);
  const targets = await resolveTargets(argv.filter((a) => !a.startsWith("--")));
  console.log(`pull-deals: ${targets.length} issuer(s), concurrency=${concurrency}`);
  let cursor = 0, done = 0, failures = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const issuer = targets[cursor++]!;
      try {
        await pullOne(issuer);
      } catch (e) {
        failures++;
        console.error(`[${issuer.ticker}] FAILED: ${e instanceof Error ? e.message : e}`);
      }
      if (++done % 50 === 0 || done === targets.length) console.log(`  ${done}/${targets.length} (${failures} failed)`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  await pool.end();
}

await main();
