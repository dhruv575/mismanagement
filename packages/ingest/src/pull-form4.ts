// Pulls Form 4 (insider-transaction) filings into insider_transactions.
//
// Form 4 primary docs are well-formed XML following the SEC ownership-document
// schema. We parse them deterministically -- no LLM. Each filing has 1+
// non-derivative and/or derivative transactions; we flatten them into rows.
//
// The submissions JSON's `primaryDocument` for a Form 4 typically points at
// the rendered HTML (e.g. `xslF345X06/form4.xml`). The raw XML lives at the
// bare filename inside the accession folder. We fetch the folder index,
// pick the first .xml file not in a subdirectory, and parse it.
//
// CLI:
//   tsx src/pull-form4.ts                       # all Form 4s in filings table for R3K
//   tsx src/pull-form4.ts ETSY EBAY             # subset
//   tsx src/pull-form4.ts --since=2024-01-01    # date filter
//   tsx src/pull-form4.ts --limit=100           # cap per issuer (smoke test)
//   tsx src/pull-form4.ts --concurrency=4       # parallel workers per issuer (default 4)
//
// Concurrency note: SEC EDGAR tolerates ~10 req/s with a polite User-Agent.
// Each Form 4 needs 2 sequential HTTP calls (folder index + XML), so a
// concurrency of 4 yields ~4-8 req/s -- well inside the limit for a single
// issuer at a time. For R3K-wide runs the limiting factor is wall-clock,
// not throughput; the script is safe to leave running for hours.

import { XMLParser } from "fast-xml-parser";
import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { resolveTargets, type IssuerSeed } from "./issuers.js";

interface Form4Filing {
  accession_number: string;
  cik: string;
  primary_doc_url: string | null;
  filing_date: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseAttributeValue: false,
});

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
  });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return await res.text();
}

// The accession folder index is HTML; we parse out the first non-XSL .xml
// that isn't in a sub-folder. That's reliably the ownership document.
// Form 4 primary_doc_url consistently follows the pattern
// `.../<accn>/xslF345X0?/ownership.xml` (the SEC's HTML-rendered view).
// The raw XBRL XML sits at the parent path -- `.../<accn>/ownership.xml`.
// Skipping the folder-index fetch halves EDGAR HTTP volume and roughly
// doubles wall-clock throughput on the bulk run. Falls back to the folder
// listing for filings that don't match the pattern.
function guessRawXmlUrl(primaryDocUrl: string | null): string | null {
  if (!primaryDocUrl) return null;
  const m = primaryDocUrl.match(/^(.*\/)xslF345X0\d\/([^/]+\.xml)$/);
  if (!m) return null;
  return `${m[1]}${m[2]}`;
}

async function findRawXmlUrl(filing: Form4Filing): Promise<string> {
  const cikInt = parseInt(filing.cik, 10);
  const accnNoDash = filing.accession_number.replace(/-/g, "");
  const folder = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accnNoDash}/`;
  const html = await fetchText(folder);
  // Match href="...xml" entries. Skip directory entries (trailing /).
  const re = /href="([^"]+\.xml)"/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1]!;
    // We want the bare top-level form4.xml, not xslF345X06/form4.xml.
    // The folder listing returns absolute paths under /Archives/edgar/data/...
    // -- pick the one whose path segment count is shortest (no subdir).
    if (href.includes("/xsl")) continue;
    matches.push(href);
  }
  if (matches.length === 0) {
    throw new Error(`no XML in folder ${folder}`);
  }
  // Prefer matches whose basename is form4.xml or wf-form4*.xml
  matches.sort((a, b) => {
    const pri = (s: string) =>
      /\/(form4|wf-form4[^/]*)\.xml$/i.test(s) ? 0 : 1;
    return pri(a) - pri(b);
  });
  return new URL(matches[0]!, folder).toString();
}

// Some Form 4 filers tag transactionDate with a trailing timezone offset
// (e.g. "2026-05-07-05:00") which Postgres' date type rejects. Strip
// anything past the YYYY-MM-DD prefix.
function normalizeDate(x: unknown): string | null {
  if (x == null) return null;
  const s = String(x).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

function num(x: unknown): number | null {
  if (x == null) return null;
  const n = typeof x === "number" ? x : parseFloat(String(x));
  return Number.isFinite(n) ? n : null;
}

function bool01(x: unknown): boolean | null {
  if (x == null || x === "") return null;
  const s = String(x).trim();
  if (s === "1" || s.toLowerCase() === "true") return true;
  if (s === "0" || s.toLowerCase() === "false") return false;
  return null;
}

// Some XML elements have a `value` child for the actual scalar; that's the
// SEC's convention for fields that can carry footnotes alongside the value.
function val(x: unknown): unknown {
  if (x == null) return null;
  if (typeof x === "object" && "value" in (x as Record<string, unknown>)) {
    return (x as Record<string, unknown>).value;
  }
  return x;
}

interface ParsedRow {
  index: number;
  derivative: boolean;
  transactionDate: string | null;
  transactionCode: string | null;
  shares: number | null;
  pricePerShare: number | null;
  acquiredOrDisposed: string | null;
  sharesOwnedAfter: number | null;
  directOrIndirect: string | null;
}

interface Form4Parsed {
  insiderCik: string | null;
  insiderName: string;
  isDirector: boolean | null;
  isOfficer: boolean | null;
  isTenPercentOwner: boolean | null;
  officerTitle: string | null;
  tenB51Plan: boolean | null;
  rows: ParsedRow[];
}

function parseOwnershipDocument(xml: string): Form4Parsed {
  const root = xmlParser.parse(xml) as { ownershipDocument?: Record<string, unknown> };
  const doc = root.ownershipDocument ?? {};

  // Some Form 4s have multiple co-filers in a single document (fund + parent,
  // affiliated entities, etc.). fast-xml-parser returns an array in that case,
  // not an object — the old code blindly cast to Record and ended up with
  // every reportingOwner-derived field empty (e.g. the $1B RIVN row had a
  // blank insider_name because Rivian's parent + fund filed jointly).
  // Normalize to an array, then:
  //   - insiderName: join all names with " / " so the editorial copy can
  //     show "PRUDENTIAL FINANCIAL INC / PRUDENTIAL INSURANCE CO OF AMERICA"
  //   - insiderCik: take the first (representative)
  //   - relationship flags: OR across owners (if any co-filer is a director,
  //     the filing is a director's filing)
  //   - officerTitle: first non-empty across owners
  const rawRo = doc.reportingOwner;
  const owners: Record<string, unknown>[] = Array.isArray(rawRo)
    ? (rawRo as Record<string, unknown>[])
    : rawRo
      ? [rawRo as Record<string, unknown>]
      : [];

  const getId = (o: Record<string, unknown>): Record<string, unknown> =>
    (o.reportingOwnerId ?? {}) as Record<string, unknown>;
  const getRel = (o: Record<string, unknown>): Record<string, unknown> =>
    (o.reportingOwnerRelationship ?? {}) as Record<string, unknown>;

  const firstOwId = owners[0] ? getId(owners[0]) : {};
  const insiderCik = firstOwId.rptOwnerCik
    ? String(firstOwId.rptOwnerCik).padStart(10, "0")
    : null;
  const names = owners
    .map((o) => String(getId(o).rptOwnerName ?? "").trim())
    .filter((s) => s.length > 0);
  const insiderName = names.join(" / ");

  // Merged relationship view across all co-filers.
  let isDirectorMerged: boolean | null = null;
  let isOfficerMerged: boolean | null = null;
  let isTenPctMerged: boolean | null = null;
  let officerTitleMerged: string | null = null;
  for (const o of owners) {
    const rel = getRel(o);
    const d = bool01(rel.isDirector);
    const off = bool01(rel.isOfficer);
    const tp = bool01(rel.isTenPercentOwner);
    if (d === true) isDirectorMerged = true;
    else if (isDirectorMerged === null && d === false) isDirectorMerged = false;
    if (off === true) isOfficerMerged = true;
    else if (isOfficerMerged === null && off === false) isOfficerMerged = false;
    if (tp === true) isTenPctMerged = true;
    else if (isTenPctMerged === null && tp === false) isTenPctMerged = false;
    if (officerTitleMerged === null) {
      const t = (rel.officerTitle as string) || null;
      if (t && t.trim().length > 0) officerTitleMerged = t.trim();
    }
  }


  const tenB51Plan =
    bool01(doc.aff10b5One) ?? // schema X0609+
    bool01((doc as Record<string, unknown>).aff10b51) ?? // older variant
    null;

  // Non-derivative + derivative transactions, normalized to the same shape.
  const flatten = (table: Record<string, unknown> | undefined, isDeriv: boolean): ParsedRow[] => {
    if (!table) return [];
    const txKey = isDeriv ? "derivativeTransaction" : "nonDerivativeTransaction";
    const raw = table[txKey];
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((tx, i) => {
      const tt = (tx as Record<string, unknown>) ?? {};
      const coding = (tt.transactionCoding ?? {}) as Record<string, unknown>;
      const amounts = (tt.transactionAmounts ?? {}) as Record<string, unknown>;
      const post = (tt.postTransactionAmounts ?? {}) as Record<string, unknown>;
      const own = (tt.ownershipNature ?? {}) as Record<string, unknown>;
      return {
        index: i,
        derivative: isDeriv,
        transactionDate: normalizeDate(val((tt.transactionDate ?? {}) as Record<string, unknown>) as string),
        transactionCode: (coding.transactionCode as string) || null,
        shares: num(val((amounts.transactionShares ?? {}) as Record<string, unknown>)),
        pricePerShare: num(val((amounts.transactionPricePerShare ?? {}) as Record<string, unknown>)),
        acquiredOrDisposed: (val((amounts.transactionAcquiredDisposedCode ?? {}) as Record<string, unknown>) as string) || null,
        sharesOwnedAfter: num(val((post.sharesOwnedFollowingTransaction ?? {}) as Record<string, unknown>)),
        directOrIndirect: (val((own.directOrIndirectOwnership ?? {}) as Record<string, unknown>) as string) || null,
      };
    });
  };

  const ndRows = flatten(doc.nonDerivativeTable as Record<string, unknown>, false);
  const dRows = flatten(doc.derivativeTable as Record<string, unknown>, true);
  // Re-index across the whole filing so transaction_index is unique.
  const rows: ParsedRow[] = [];
  let i = 0;
  for (const r of [...ndRows, ...dRows]) rows.push({ ...r, index: i++ });

  return {
    insiderCik,
    insiderName,
    isDirector: isDirectorMerged,
    isOfficer: isOfficerMerged,
    isTenPercentOwner: isTenPctMerged,
    officerTitle: officerTitleMerged,
    tenB51Plan,
    rows,
  };
}

async function persist(filing: Form4Filing, parsed: Form4Parsed): Promise<void> {
  // Idempotent: replace any existing rows for this accession before inserting.
  await pool.query(
    `delete from insider_transactions where accession_number = $1`,
    [filing.accession_number],
  );
  for (const r of parsed.rows) {
    const txValue =
      r.shares != null && r.pricePerShare != null ? r.shares * r.pricePerShare : null;
    await pool.query(
      `insert into insider_transactions (
         accession_number, transaction_index, cik, insider_cik, insider_name,
         is_director, is_officer, is_ten_percent_owner, officer_title,
         transaction_date, transaction_code, derivative,
         shares, price_per_share, transaction_value,
         acquired_or_disposed, shares_owned_after, direct_or_indirect,
         ten_b_5_one_plan, filed_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       on conflict (accession_number, transaction_index) do nothing`,
      [
        filing.accession_number,
        r.index,
        filing.cik,
        parsed.insiderCik,
        parsed.insiderName,
        parsed.isDirector,
        parsed.isOfficer,
        parsed.isTenPercentOwner,
        parsed.officerTitle,
        r.transactionDate,
        r.transactionCode,
        r.derivative,
        r.shares,
        r.pricePerShare,
        txValue,
        r.acquiredOrDisposed,
        r.sharesOwnedAfter,
        r.directOrIndirect,
        parsed.tenB51Plan,
        filing.filing_date,
      ],
    );
  }
}

async function processFiling(filing: Form4Filing): Promise<{ rows: number } | { error: string }> {
  try {
    // Fast path: derive raw XML URL from primary_doc_url without an EDGAR
    // round-trip. Falls back to the folder-listing path only when the URL
    // doesn't match the expected pattern.
    const guess = guessRawXmlUrl(filing.primary_doc_url);
    let xml: string;
    if (guess) {
      try {
        xml = await fetchText(guess);
      } catch {
        // The guess can 404 for legacy filings stored at a different path;
        // fall back to the slow path then.
        const url = await findRawXmlUrl(filing);
        xml = await fetchText(url);
      }
    } else {
      const url = await findRawXmlUrl(filing);
      xml = await fetchText(url);
    }
    const parsed = parseOwnershipDocument(xml);
    await persist(filing, parsed);
    return { rows: parsed.rows.length };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function pullOne(issuer: IssuerSeed, opts: { since?: string; limit?: number; concurrency: number; progressEvery: number }): Promise<{ pulled: number; rows: number; failures: number }> {
  const params: unknown[] = [issuer.cik];
  let where = "f.cik = $1 and f.form = '4'";
  if (opts.since) {
    params.push(opts.since);
    where += ` and f.filing_date >= $${params.length}::date`;
  }
  const limitClause = opts.limit ? `limit ${opts.limit}` : "";
  const r = await pool.query<Form4Filing>(
    `select f.accession_number, f.cik, f.primary_doc_url, f.filing_date::text
     from filings f
     where ${where}
       and not exists (select 1 from insider_transactions it where it.accession_number = f.accession_number)
     order by f.filing_date desc
     ${limitClause}`,
    params,
  );

  if (r.rows.length === 0) return { pulled: 0, rows: 0, failures: 0 };

  // Bounded parallelism: spawn `concurrency` workers that pull from a shared
  // queue of filings. Each worker handles one filing at a time, using its
  // share of the SEC's polite request budget (~10 req/s overall).
  let cursor = 0;
  let pulled = 0;
  let totalRows = 0;
  let failures = 0;
  const total = r.rows.length;
  const startedAt = Date.now();

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;
      const filing = r.rows[idx]!;
      const result = await processFiling(filing);
      if ("error" in result) {
        failures++;
        console.error(`  ${filing.accession_number}: ${result.error}`);
      } else {
        pulled++;
        totalRows += result.rows;
      }
      const done = pulled + failures;
      if (done % opts.progressEvery === 0 || done === total) {
        const secs = (Date.now() - startedAt) / 1000;
        const rate = done / secs;
        const eta = (total - done) / rate;
        console.log(
          `  [${issuer.ticker}] ${done}/${total} ` +
            `(${pulled} ok, ${failures} failed, ${totalRows} txs)  ` +
            `${rate.toFixed(1)} filings/s, ETA ${eta.toFixed(0)}s`,
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency, total) }, () => worker()),
  );
  return { pulled, rows: totalRows, failures };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const since = argv.find((a) => a.startsWith("--since="))?.split("=")[1];
  const limit = parseInt(argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0", 10) || undefined;
  const concurrency = parseInt(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "4", 10);
  const progressEvery = parseInt(argv.find((a) => a.startsWith("--progress-every="))?.split("=")[1] ?? "100", 10);
  const tickers = argv.filter((a) => !a.startsWith("--"));
  const targets = await resolveTargets(tickers);
  console.log(`pull-form4: resolving filings for ${targets.length} issuer(s)…`);

  // Global filing-level queue. Per-issuer concurrency stalled the run on
  // issuers with few filings (we'd drain the queue in < 1s then sit waiting
  // for the next issuer's SELECT). One big SELECT + a global N-worker pool
  // keeps EDGAR saturated end-to-end.
  const ciks = targets.map((t) => t.cik);
  const tickerByCik = new Map(targets.map((t) => [t.cik, t.ticker]));
  const params: unknown[] = [ciks];
  let where = "f.cik = any($1::text[]) and f.form = '4'";
  if (since) {
    params.push(since);
    where += ` and f.filing_date >= $${params.length}::date`;
  }
  // For consistency with prior --limit semantics (per-issuer cap) we use
  // a window-function rank rather than a flat LIMIT.
  const filingsRes = await pool.query<Form4Filing>(
    limit
      ? `select accession_number, cik, primary_doc_url, filing_date
         from (
           select f.accession_number, f.cik, f.primary_doc_url, f.filing_date::text,
                  row_number() over (partition by f.cik order by f.filing_date desc) as rn
           from filings f
           where ${where}
             and not exists (select 1 from insider_transactions it where it.accession_number = f.accession_number)
         ) t
         where rn <= ${limit}`
      : `select f.accession_number, f.cik, f.primary_doc_url, f.filing_date::text
         from filings f
         where ${where}
           and not exists (select 1 from insider_transactions it where it.accession_number = f.accession_number)
         order by f.filing_date desc`,
    params,
  );
  const filings = filingsRes.rows;
  console.log(`pull-form4: ${filings.length} filings to process, concurrency=${concurrency}` +
    `${since ? ` since=${since}` : ""}${limit ? ` limit=${limit}/issuer` : ""}`);
  if (filings.length === 0) {
    await pool.end();
    return;
  }

  let cursor = 0;
  let pulled = 0;
  let totalRows = 0;
  let failures = 0;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= filings.length) return;
      const filing = filings[idx]!;
      const result = await processFiling(filing);
      if ("error" in result) {
        failures++;
        const ticker = tickerByCik.get(filing.cik) ?? filing.cik;
        console.error(`  [${ticker}] ${filing.accession_number}: ${result.error}`);
      } else {
        pulled++;
        totalRows += result.rows;
      }
      const done = pulled + failures;
      if (done % progressEvery === 0 || done === filings.length) {
        const secs = (Date.now() - startedAt) / 1000;
        const rate = done / secs;
        const eta = (filings.length - done) / Math.max(rate, 0.001);
        console.log(
          `  progress: ${done}/${filings.length} ` +
            `(${pulled} ok, ${failures} failed, ${totalRows} txs)  ` +
            `${rate.toFixed(1)} filings/s, ETA ${(eta / 60).toFixed(1)} min`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, filings.length) }, () => worker()),
  );
  console.log(`done: ${pulled} filings, ${totalRows} transactions, ${failures} failures`);
  await pool.end();
}

await main();
