// Extract structured facts from a DEF 14A via OpenRouter / Gemini 3 Flash.
//
// For each issuer:
//   1. Pick the most recent DEF 14A from the `filings` table.
//   2. Fetch the HTML primary doc (cached on disk under data/proxies/).
//   3. Strip XBRL inline-tagging noise -- keep the visible reader-facing
//      content with table structure intact.
//   4. Send to the model with the schema embedded in the prompt.
//   5. Validate against the Zod schema, persist raw JSON + flat fact rows.
//
// Idempotent at the (cik, fiscal_year_covered) level via the unique index on
// proxy_extractions; re-runs replace the prior row's fact-table fan-out.
//
// CLI:
//   tsx src/extract-proxy.ts               # all issuers, latest DEF 14A
//   tsx src/extract-proxy.ts ETSY          # one issuer
//   tsx src/extract-proxy.ts --force ETSY  # re-extract even if cached
//   tsx src/extract-proxy.ts --dry-run     # call model, skip DB write

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { parse } from "node-html-parser";
import {
  PROXY_EXTRACTION_JSON_SCHEMA,
  ProxyExtraction,
} from "@activist/shared";
import { pool } from "./db.js";
import { DATA_DIR, EDGAR_USER_AGENT } from "./env.js";

// DEF 14A narrative extraction. Pay-vs-Performance is pulled deterministically
// from XBRL (pull-ecd.ts) so the LLM only handles fields that aren't tagged:
// board bios, related-party transactions, beneficial ownership, peer group,
// All Other Compensation itemization, governance flags. Output drops to
// ~3-4K tokens, well within DeepSeek V4 Flash's range. Override via env if a
// future model becomes a better fit.
const PROXY_EXTRACTION_MODEL =
  process.env.OPENROUTER_PROXY_MODEL || "deepseek/deepseek-v4-flash";
import { resolveTargets, type IssuerSeed } from "./issuers.js";
import { callOpenRouter } from "./openrouter.js";

const PROXIES_DIR = path.join(DATA_DIR, "proxies");

interface ProxyTarget {
  cik: string;
  ticker: string;
  issuerName: string;
  accessionNumber: string;
  filingDate: string;
  primaryDocUrl: string;
  fiscalYearCovered: number;
}

async function pickLatestProxy(issuer: IssuerSeed): Promise<ProxyTarget> {
  const r = await pool.query<{
    accession_number: string;
    filing_date: string;
    primary_doc_url: string | null;
    fiscal_year: number | null;
    name: string;
  }>(
    `select f.accession_number, f.filing_date::text, f.primary_doc_url, f.fiscal_year, c.name
     from filings f join companies c on c.cik = f.cik
     where f.cik = $1 and f.form = 'DEF 14A'
     order by f.filing_date desc
     limit 1`,
    [issuer.cik],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error(
      `No DEF 14A for ${issuer.ticker} in filings table -- run pull-edgar.ts first`,
    );
  }
  if (!row.primary_doc_url) {
    throw new Error(`DEF 14A ${row.accession_number} has no primary_doc_url`);
  }
  // The DEF 14A filed in year Y covers fiscal year Y-1 in almost every case.
  // EDGAR's `fiscalYear` field on the filing is the SEC's *issuer-reported*
  // fiscal year of the filing itself, not the year covered. We use
  // (filing_year - 1) as the covered year unless overridden.
  const filingYear = parseInt(row.filing_date.slice(0, 4), 10);
  const fiscalYearCovered = filingYear - 1;
  return {
    cik: issuer.cik,
    ticker: issuer.ticker,
    issuerName: row.name,
    accessionNumber: row.accession_number,
    filingDate: row.filing_date,
    primaryDocUrl: row.primary_doc_url,
    fiscalYearCovered,
  };
}

async function fetchProxy(target: ProxyTarget): Promise<string> {
  await mkdir(PROXIES_DIR, { recursive: true });
  const cachePath = path.join(
    PROXIES_DIR,
    `${target.ticker.toLowerCase()}-${target.accessionNumber}.html`,
  );
  try {
    await access(cachePath);
    return await readFile(cachePath, "utf-8");
  } catch {
    // not cached
  }
  const res = await fetch(target.primaryDocUrl, {
    headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
  });
  if (!res.ok) throw new Error(`Fetch ${target.primaryDocUrl}: ${res.status}`);
  const body = await res.text();
  await writeFile(cachePath, body, "utf-8");
  return body;
}

// Strip scripts, styles, hidden XBRL blocks, and presentation-only attrs;
// keep tables, headings, paragraphs, lists. Goal is to give the model the
// visible reader-facing document at ~30% of the original byte size, with
// tables intact for compensation extraction.
function cleanHtml(raw: string): string {
  const root = parse(raw, {
    blockTextElements: { script: false, style: false },
  });

  // Drop entire subtrees we never want.
  const KILL_TAGS = ["script", "style", "meta", "link", "head"];
  for (const tag of KILL_TAGS) {
    for (const el of root.querySelectorAll(tag)) el.remove();
  }
  // XBRL: ix:header / ix:hidden carry no visible content.
  for (const el of root.querySelectorAll("ix\\:header, ix\\:hidden, ix\\:references, ix\\:resources")) {
    el.remove();
  }
  // For remaining ix:* wrappers (ix:nonNumeric, ix:nonFraction), unwrap so
  // the visible text and tags inside survive but the wrapper goes away.
  // node-html-parser doesn't have a native unwrap; we replace the outer HTML
  // with the inner.
  const allElements = root.querySelectorAll("*");
  for (const el of allElements) {
    if (el.tagName && el.tagName.toLowerCase().startsWith("ix:")) {
      el.replaceWith(el.innerHTML);
    }
  }
  // Strip noisy attributes that waste tokens without helping the model.
  for (const el of root.querySelectorAll("*")) {
    for (const attr of ["style", "class", "id", "lang", "dir"]) {
      el.removeAttribute(attr);
    }
  }

  return root.toString();
}

const SYSTEM_PROMPT =
  "You are a financial-document extraction model. You extract structured " +
  "data from US SEC DEF 14A proxy statements.\n\n" +
  "Rules:\n" +
  "1. All dollar amounts are in dollars (not thousands). If the proxy reports " +
  '"$1,234" treat it as 1234. If it reports "(in thousands) $1,234" treat it as 1234000.\n' +
  "2. Use the values exactly as printed; do not infer or compute totals the " +
  "company did not print. Do not characterize, interpret, or editorialize -- " +
  "extract facts.\n" +
  "3. If a field is not present in the document, return null. Do not hallucinate.\n" +
  "4. Return only a single JSON object -- no prose, no code fences, no commentary.";

function userPrompt(target: ProxyTarget, html: string): string {
  return (
    `Extract structured data from this ${target.issuerName} DEF 14A. The fiscal year ` +
    `covered is ${target.fiscalYearCovered}.\n\n` +
    `IMPORTANT: Do NOT extract the Pay-vs-Performance table -- it is sourced ` +
    `separately from the issuer's XBRL filings. Skip that section entirely.\n\n` +
    `Return a single JSON object matching this exact schema (all fields required ` +
    `unless wrapped in [\\"...\\", \\"null\\"]):\n\n` +
    JSON.stringify(PROXY_EXTRACTION_JSON_SCHEMA, null, 2) +
    `\n\n=== PROXY HTML ===\n` +
    html
  );
}

async function persist(target: ProxyTarget, extraction: ProxyExtraction, raw: unknown, usage?: { prompt_tokens: number; completion_tokens: number }): Promise<void> {
  // Replace any prior extraction for this (cik, fy). The unique index would
  // also catch this, but doing it explicitly avoids an upsert dance for the
  // dependent fact tables.
  await pool.query(
    `delete from proxy_extractions where cik = $1 and fiscal_year_covered = $2`,
    [target.cik, target.fiscalYearCovered],
  );
  const inserted = await pool.query<{ id: number }>(
    `insert into proxy_extractions (
       accession_number, cik, fiscal_year_covered, model, raw_json,
       prompt_tokens, completion_tokens
     ) values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [
      target.accessionNumber,
      target.cik,
      target.fiscalYearCovered,
      PROXY_EXTRACTION_MODEL,
      JSON.stringify(raw),
      usage?.prompt_tokens ?? null,
      usage?.completion_tokens ?? null,
    ],
  );
  const extractionId = inserted.rows[0]!.id;

  for (const r of extraction.summary_compensation) {
    await pool.query(
      `insert into summary_compensation (
         extraction_id, name, title, fiscal_year, salary, bonus, stock_awards,
         option_awards, non_equity_incentive, change_in_pension,
         all_other_compensation, total
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (extraction_id, name, fiscal_year) do nothing`,
      [
        extractionId,
        r.name,
        r.title,
        r.fiscal_year,
        r.salary,
        r.bonus,
        r.stock_awards,
        r.option_awards,
        r.non_equity_incentive_plan,
        r.change_in_pension_value,
        r.all_other_compensation,
        r.total,
      ],
    );
  }

  for (const row of extraction.all_other_compensation_detail) {
    for (const item of row.items) {
      await pool.query(
        `insert into all_other_compensation (extraction_id, name, fiscal_year, category, amount, description)
         values ($1,$2,$3,$4,$5,$6)`,
        [extractionId, row.name, row.fiscal_year, item.category, item.amount, item.description ?? ""],
      );
    }
  }

  for (const r of extraction.pay_versus_performance) {
    await pool.query(
      `insert into pay_vs_performance (
         extraction_id, year, ceo_compensation_actually_paid,
         average_neo_compensation_actually_paid, company_tsr_indexed,
         peer_group_tsr_indexed, gaap_net_income, company_selected_measure_name,
         company_selected_measure_value
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (extraction_id, year) do nothing`,
      [
        extractionId,
        r.year,
        r.ceo_compensation_actually_paid,
        r.average_neo_compensation_actually_paid,
        r.company_tsr_indexed,
        r.peer_group_tsr_indexed,
        r.gaap_net_income,
        r.company_selected_measure_name,
        r.company_selected_measure_value,
      ],
    );
  }

  for (const r of extraction.board) {
    await pool.query(
      `insert into directors (
         extraction_id, name, age, director_since_year, independent, is_chair,
         is_lead_independent_director, committees, other_public_boards,
         attendance_below_75pct
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (extraction_id, name) do nothing`,
      [
        extractionId,
        r.name,
        r.age,
        r.director_since_year,
        r.independent,
        r.is_chair,
        r.is_lead_independent_director,
        r.committees,
        r.other_public_boards,
        r.attendance_below_75pct,
      ],
    );
  }

  for (const r of extraction.director_compensation) {
    await pool.query(
      `insert into director_compensation (
         extraction_id, name, fees_earned_or_paid_in_cash, stock_awards,
         option_awards, non_equity_incentive, all_other_compensation, total
       ) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (extraction_id, name) do nothing`,
      [
        extractionId,
        r.name,
        r.fees_earned_or_paid_in_cash,
        r.stock_awards,
        r.option_awards,
        r.non_equity_incentive,
        r.all_other_compensation,
        r.total,
      ],
    );
  }

  for (const r of extraction.equity_ownership) {
    await pool.query(
      `insert into equity_ownership (extraction_id, name, holder_type, shares, percent_class)
       values ($1,$2,$3,$4,$5)
       on conflict (extraction_id, name, holder_type) do nothing`,
      [extractionId, r.name, r.type, r.shares, r.percent_class],
    );
  }

  for (const r of extraction.related_party_transactions) {
    await pool.query(
      `insert into related_party_transactions (extraction_id, description, parties, amount_or_terms)
       values ($1,$2,$3,$4)`,
      [extractionId, r.description, r.parties, r.amount_or_terms ?? ""],
    );
  }

  for (const r of extraction.compensation_consultants) {
    await pool.query(
      `insert into compensation_consultants (extraction_id, name, scope, fees_paid)
       values ($1,$2,$3,$4)`,
      [extractionId, r.name, r.scope ?? "", r.fees_paid],
    );
  }
}

async function extractOne(issuer: IssuerSeed, force: boolean, dryRun: boolean): Promise<void> {
  const target = await pickLatestProxy(issuer);
  console.log(`[${issuer.ticker}] DEF 14A ${target.accessionNumber} filed ${target.filingDate} (FY${target.fiscalYearCovered})`);

  if (!force && !dryRun) {
    const existing = await pool.query<{ id: number }>(
      `select id from proxy_extractions where cik = $1 and fiscal_year_covered = $2`,
      [target.cik, target.fiscalYearCovered],
    );
    if (existing.rows[0]) {
      console.log(`[${issuer.ticker}]   already extracted (id ${existing.rows[0].id}) -- pass --force to re-run`);
      return;
    }
  }

  const raw = await fetchProxy(target);
  console.log(`[${issuer.ticker}]   raw HTML ${raw.length.toLocaleString()} bytes`);
  const clean = cleanHtml(raw);
  console.log(`[${issuer.ticker}]   cleaned   ${clean.length.toLocaleString()} bytes`);

  console.log(`[${issuer.ticker}]   calling ${PROXY_EXTRACTION_MODEL}…`);
  let json: unknown, usage: { prompt_tokens: number; completion_tokens: number } | undefined;
  let modelRaw = "";
  try {
    const result = await callOpenRouter({
      model: PROXY_EXTRACTION_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPrompt(target, clean),
    });
    json = result.json;
    usage = result.usage;
    modelRaw = result.raw;
  } catch (e) {
    // Save the raw model output so we can diagnose without re-running the
    // (paid) call. The error from the parser only includes the first 200
    // chars; the full body is much more useful.
    const failedRaw = (e as Error & { raw?: string }).raw ?? "";
    if (failedRaw) {
      const dump = path.join(DATA_DIR, `failed-${target.ticker.toLowerCase()}-${Date.now()}.txt`);
      await writeFile(dump, failedRaw, "utf-8");
      console.error(`[${issuer.ticker}]   raw model output saved to ${dump} (${failedRaw.length.toLocaleString()} chars)`);
    }
    throw e;
  }
  console.log(
    `[${issuer.ticker}]   prompt_tokens=${usage?.prompt_tokens ?? "?"} ` +
      `completion_tokens=${usage?.completion_tokens ?? "?"} ` +
      `raw_chars=${modelRaw.length}`,
  );

  const parsed = ProxyExtraction.parse(json);
  console.log(
    `[${issuer.ticker}]   parsed: ${parsed.summary_compensation.length} NEOs, ` +
      `${parsed.board.length} directors, ${parsed.pay_versus_performance.length} PvP rows`,
  );

  if (dryRun) {
    console.log(`[${issuer.ticker}]   --dry-run: skipping DB write`);
    return;
  }
  await persist(target, parsed, json, usage);
  console.log(`[${issuer.ticker}]   persisted`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const concurrency = parseInt(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "1", 10);
  const tickers = argv.filter((a) => !a.startsWith("--"));
  const targets = await resolveTargets(tickers);

  // Pre-filter via one bulk query to skip already-extracted issuers --
  // saves a per-issuer DB roundtrip when running R3K-wide. We then re-check
  // inside extractOne in case a parallel worker picked up the same issuer.
  let toRun = targets;
  if (!force && !dryRun) {
    const r = await pool.query<{ cik: string }>(
      `select distinct cik from proxy_extractions`,
    );
    const done = new Set(r.rows.map((row) => row.cik));
    toRun = targets.filter((t) => !done.has(t.cik));
  }
  console.log(`extract-proxy: ${toRun.length}/${targets.length} issuer(s) to extract (concurrency=${concurrency})`);

  let cursor = 0;
  let ok = 0;
  let failed = 0;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= toRun.length) return;
      const issuer = toRun[idx]!;
      try {
        await extractOne(issuer, force, dryRun);
        ok++;
      } catch (e) {
        failed++;
        console.error(`[${issuer.ticker}] FAILED: ${e instanceof Error ? e.message : e}`);
      }
      const done = ok + failed;
      if (done % 25 === 0 || done === toRun.length) {
        const secs = (Date.now() - startedAt) / 1000;
        const rate = done / Math.max(secs, 1);
        const eta = (toRun.length - done) / Math.max(rate, 0.001);
        console.log(`--- progress: ${done}/${toRun.length} (${ok} ok, ${failed} failed) ${rate.toFixed(2)}/s ETA ${(eta / 60).toFixed(1)} min ---`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, toRun.length) }, () => worker()));
  console.log(`done: ${ok} ok, ${failed} failed`);
  await pool.end();
}

await main();
