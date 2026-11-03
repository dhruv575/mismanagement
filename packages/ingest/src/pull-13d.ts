// Pulls Schedule 13D and 13G filings (active/passive 5%+ stakes) into
// thirteen_d_filings via an LLM (Vercel AI Gateway).
//
// 13D/G primary docs are short HTML (~6-30KB text). The fields we want
// (sole/shared voting + dispositive power, aggregate shares + percent,
// group members, purpose-of-transaction language) are partly tabular and
// partly narrative -- doable in one small-model call per filing, a fraction of a cent each.
//
// Active vs passive intent: form-type alone isn't dispositive (13G holders
// can convert to 13D when intent changes). We extract from the document's
// "purpose of transaction" / Item 4 text.
//
// CLI:
//   tsx src/pull-13d.ts                       # all 13D/G filings in DB
//   tsx src/pull-13d.ts ETSY EBAY             # subset by subject ticker
//   tsx src/pull-13d.ts --since=2025-01-01    # date filter
//   tsx src/pull-13d.ts --limit=50            # cap (smoke test / cost control)
//   tsx src/pull-13d.ts --13d-only            # skip passive 13G holders
//   tsx src/pull-13d.ts --headers-only        # fix filer + self-filed from EDGAR headers (no LLM)
//   tsx src/pull-13d.ts --classify-intent     # decide intent where extraction left it null (--all: every 13D)

import { z } from "zod";
import { pool } from "./db.js";
import { EDGAR_USER_AGENT, LLM_MODEL } from "./env.js";
import { resolveTargets, type IssuerSeed } from "./issuers.js";
import { callLLM } from "./llm.js";

interface Filing {
  accession_number: string;
  cik: string;
  form: string;
  filing_date: string;
  primary_doc_url: string | null;
}

// .default(null): smaller models omit keys they have no value for instead of
// writing null; treat an omitted key as null.
const NullableNumber = z.number().nullable().default(null);
const NullableString = z.string().nullable().default(null);
const NullableBool = z.boolean().nullable().default(null);

const ThirteenDExtraction = z.object({
  filer_name: NullableString,
  filer_cik: NullableString,
  event_date: NullableString,
  aggregate_shares: NullableNumber,
  aggregate_percent: NullableNumber,
  sole_voting_power: NullableNumber,
  shared_voting_power: NullableNumber,
  sole_dispositive_power: NullableNumber,
  shared_dispositive_power: NullableNumber,
  group_members: z.array(z.string()).default([]),
  is_active_intent: NullableBool,
  purpose_summary: NullableString,
  cooperation_agreement_present: NullableBool,
  standstill_present: NullableBool,
});

type ThirteenDExtraction = z.infer<typeof ThirteenDExtraction>;

const SCHEMA_DESC = {
  type: "object",
  properties: {
    filer_name: { type: "string", description: "Reporting Person / filer name from cover page" },
    filer_cik: {
      type: ["string", "null"],
      description: "10-digit zero-padded CIK if disclosed on cover page; null otherwise",
    },
    event_date: {
      type: ["string", "null"],
      description: "ISO date of the event triggering the filing (Item on cover page); null if not present",
    },
    aggregate_shares: {
      type: ["number", "null"],
      description: "Aggregate amount beneficially owned (Item 9 / Row 9), in shares (not thousands)",
    },
    aggregate_percent: {
      type: ["number", "null"],
      description: "Percent of class beneficially owned (Item 11 / Row 11), e.g. 5.1 for 5.1%",
    },
    sole_voting_power: { type: ["number", "null"], description: "Item 5 / Row 5, shares" },
    shared_voting_power: { type: ["number", "null"], description: "Item 6 / Row 6, shares" },
    sole_dispositive_power: { type: ["number", "null"], description: "Item 7 / Row 7, shares" },
    shared_dispositive_power: { type: ["number", "null"], description: "Item 8 / Row 8, shares" },
    group_members: {
      type: "array",
      items: { type: "string" },
      description: "Members of any 13D group disclosed in Item 2; empty array if no group",
    },
    is_active_intent: {
      type: ["boolean", "null"],
      description:
        "true if Item 4 (Purpose of Transaction) language indicates active intent to influence " +
        "control/management/strategy; false for purely passive investment intent (typical 13G); " +
        "null if Item 4 is absent or ambiguous",
    },
    purpose_summary: {
      type: ["string", "null"],
      description:
        "One- or two-sentence factual summary of Item 4 / purpose-of-transaction language. Quote " +
        "or paraphrase the filer's own words; do not editorialize.",
    },
    cooperation_agreement_present: {
      type: ["boolean", "null"],
      description:
        "true if the filing references a cooperation agreement (board seats, voting commitments) " +
        "with the issuer; false otherwise; null if not addressed",
    },
    standstill_present: {
      type: ["boolean", "null"],
      description:
        "true if the filing references a standstill agreement limiting further accumulation or " +
        "specified actions; false otherwise; null if not addressed",
    },
  },
  required: ["filer_name", "group_members"],
} as const;

const SYSTEM_PROMPT =
  "You extract structured data from US SEC Schedule 13D and 13G filings. " +
  "All share counts are in shares (not thousands). Percent ownership is in " +
  "percent (5.1 means 5.1%, not 0.051). If a field is not present, return " +
  "null. Do not characterize, interpret, or editorialize -- extract facts. " +
  "Return only a single JSON object.";

// Retries on EDGAR 429 (rate-limit) and 5xx (transient server) responses
// with exponential backoff. At high concurrency a non-trivial fraction of
// fetches hit 429; without retry they'd permanently fail and waste the
// LLM tokens we'd already budgeted for that filing.
// Every request takes a slot from a shared pacer: 8 req/s keeps the run
// under EDGAR's 10 req/s however many workers are running.
let nextSlot = 0;
const MIN_GAP_MS = 125;

async function fetchHtml(url: string): Promise<string> {
  const maxAttempts = 5;
  let delay = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const now = Date.now();
    nextSlot = Math.max(nextSlot + MIN_GAP_MS, now);
    if (nextSlot > now) await new Promise((r) => setTimeout(r, nextSlot - now));
    const res = await fetch(url, {
      headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
    });
    if (res.ok) return await res.text();
    const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retriable || attempt === maxAttempts) {
      throw new Error(`${url}: ${res.status}`);
    }
    // Honor Retry-After if present, else exponential backoff with jitter.
    const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay + Math.floor(Math.random() * 500);
    await new Promise((r) => setTimeout(r, wait));
    delay = Math.min(delay * 2, 15_000);
  }
  throw new Error(`${url}: unreachable`);
}

interface FilingHeader { subjectCik: string | null; filerName: string | null; filerCik: string | null }

// The EDGAR header names the subject company and the filer outright, which
// beats asking the model for either. Lives next to the primary document.
async function fetchHeader(filing: Filing): Promise<FilingHeader | null> {
  if (!filing.primary_doc_url) return null;
  // The accession folder, not the document's own: new-format XML filings keep
  // the rendered document in an xslSCHEDULE_13D_X0n/ subfolder.
  const accnNoDash = filing.accession_number.replace(/-/g, "");
  const folder = filing.primary_doc_url.slice(0, filing.primary_doc_url.indexOf(accnNoDash) + accnNoDash.length) + "/";
  const text = (await fetchHtml(`${folder}${filing.accession_number}-index-headers.html`))
    .replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const block = (label: string) => text.split(label)[1]?.split(/\n\s*(?:SUBJECT COMPANY|FILED BY|GROUP MEMBERS):/)[0] ?? "";
  const field = (b: string, key: string) => b.split(`${key}:`)[1]?.split("\n")[0]?.trim() || null;
  const subject = block("SUBJECT COMPANY:");
  const filer = block("FILED BY:");
  if (!subject && !filer) return null;
  return {
    subjectCik: field(subject, "CENTRAL INDEX KEY"),
    filerName: field(filer, "COMPANY CONFORMED NAME"),
    filerCik: field(filer, "CENTRAL INDEX KEY"),
  };
}

function htmlToText(html: string): string {
  // 13D/G filings have minimal styling; a tag-strip + whitespace collapse is
  // enough. We keep line breaks at <br> / </p> / </tr> boundaries so the
  // model can see the cover-page layout.
  return html
    .replace(/<(br|\/p|\/tr|\/table|\/div)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractOne(filing: Filing, issuerName: string): Promise<ThirteenDExtraction | null> {
  if (!filing.primary_doc_url) {
    console.error(`  ${filing.accession_number}: no primary_doc_url`);
    return null;
  }
  const html = await fetchHtml(filing.primary_doc_url);
  const text = htmlToText(html);

  const userPrompt =
    `This is a ${filing.form} filing about ${issuerName} filed ${filing.filing_date}. ` +
    `Extract structured data per the schema below. Return a single JSON object.\n\n` +
    JSON.stringify(SCHEMA_DESC, null, 2) +
    `\n\n=== FILING TEXT ===\n` +
    text;

  const { json } = await callLLM({ systemPrompt: SYSTEM_PROMPT, userPrompt });
  const extracted = ThirteenDExtraction.parse(json);
  const header = await fetchHeader(filing).catch(() => null);
  if (header?.filerName) extracted.filer_name = header.filerName;
  if (header?.filerCik) extracted.filer_cik = header.filerCik;
  if (!extracted.filer_name) return null;
  headers.set(filing.accession_number, header);
  return extracted;
}

// Header per accession, read by persist() to decide is_self_filed.
const headers = new Map<string, FilingHeader | null>();

// Self-filed when the header's subject is another company; fall back to
// comparing names when the header couldn't be read.
function selfFiled(filing: Filing, filerName: string, issuerName: string): boolean {
  const subject = headers.get(filing.accession_number)?.subjectCik;
  return subject ? subject.padStart(10, "0") !== filing.cik.padStart(10, "0") : isSelfFiled(filerName, issuerName);
}

// An issuer's submissions feed lists the 13D/Gs it filed on other companies
// alongside those filed on it. When the filer is the issuer itself, the
// filing is about someone else's stock and must not count against it.
const normName = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(the|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|l p|n v|s a|sa|nv|ag|se)\b/g, " ")
    .replace(/\s+/g, " ").trim();
function isSelfFiled(filer: string, issuer: string): boolean {
  const a = normName(filer), b = normName(issuer);
  return a.length > 2 && b.length > 2 && (a === b || a.startsWith(b + " ") || b.startsWith(a + " "));
}

// The model sometimes returns the CUSIP or a dashed file number as the CIK,
// and sums group members into stakes over 100%. Keep only values that can
// be real.
function cleanCik(v: string | null): string | null {
  if (!v || !/^[\d-]+$/.test(v)) return null;
  const digits = v.replace(/-/g, "");
  return digits.length >= 1 && digits.length <= 10 ? digits.padStart(10, "0") : null;
}
const cleanPct = (v: number | null) => (v != null && v >= 0 && v < 100 ? v : null);

async function persist(filing: Filing, extracted: ThirteenDExtraction, raw: unknown, issuerName: string): Promise<void> {
  await pool.query(
    `insert into thirteen_d_filings (
       accession_number, cik, form, filing_date, event_date,
       filer_name, filer_cik, is_active_intent, purpose_summary,
       cooperation_agreement_present, standstill_present,
       aggregate_shares, aggregate_percent,
       sole_voting_power, shared_voting_power,
       sole_dispositive_power, shared_dispositive_power,
       group_members, model, raw_json, is_self_filed, extracted_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now())
     on conflict (accession_number) do update set
       filer_name = excluded.filer_name,
       filer_cik = excluded.filer_cik,
       event_date = excluded.event_date,
       is_active_intent = excluded.is_active_intent,
       purpose_summary = excluded.purpose_summary,
       cooperation_agreement_present = excluded.cooperation_agreement_present,
       standstill_present = excluded.standstill_present,
       aggregate_shares = excluded.aggregate_shares,
       aggregate_percent = excluded.aggregate_percent,
       sole_voting_power = excluded.sole_voting_power,
       shared_voting_power = excluded.shared_voting_power,
       sole_dispositive_power = excluded.sole_dispositive_power,
       shared_dispositive_power = excluded.shared_dispositive_power,
       group_members = excluded.group_members,
       model = excluded.model,
       raw_json = excluded.raw_json,
       is_self_filed = excluded.is_self_filed,
       extracted_at = now()`,
    [
      filing.accession_number,
      filing.cik,
      filing.form,
      filing.filing_date,
      extracted.event_date,
      extracted.filer_name,
      cleanCik(extracted.filer_cik),
      extracted.is_active_intent,
      extracted.purpose_summary,
      extracted.cooperation_agreement_present,
      extracted.standstill_present,
      extracted.aggregate_shares,
      cleanPct(extracted.aggregate_percent),
      extracted.sole_voting_power,
      extracted.shared_voting_power,
      extracted.sole_dispositive_power,
      extracted.shared_dispositive_power,
      extracted.group_members,
      LLM_MODEL,
      JSON.stringify(raw),
      selfFiled(filing, extracted.filer_name!, issuerName),
    ],
  );
}

async function pullOne(issuer: IssuerSeed, opts: { since?: string; limit?: number; force: boolean }): Promise<{ pulled: number; failures: number }> {
  const params: unknown[] = [issuer.cik];
  let where = "f.cik = $1 and (f.form like 'SC 13%' or f.form like 'SCHEDULE 13%')";
  if (opts.since) {
    params.push(opts.since);
    where += ` and f.filing_date >= $${params.length}::date`;
  }
  const cacheJoin = opts.force
    ? ""
    : `and not exists (select 1 from thirteen_d_filings t where t.accession_number = f.accession_number)`;
  const limitClause = opts.limit ? `limit ${opts.limit}` : "";

  const r = await pool.query<Filing>(
    `select f.accession_number, f.cik, f.form, f.filing_date::text, f.primary_doc_url
     from filings f
     where ${where}
       ${cacheJoin}
     order by f.filing_date desc
     ${limitClause}`,
    params,
  );

  let pulled = 0;
  let failures = 0;
  for (const filing of r.rows) {
    try {
      const extracted = await extractOne(filing, issuer.name);
      if (!extracted) {
        failures++;
        continue;
      }
      await persist(filing, extracted, extracted, issuer.name);
      console.log(
        `  ${filing.accession_number} ${filing.form.padEnd(11)} ` +
          `${(extracted.filer_name ?? "").slice(0, 35).padEnd(35)} ` +
          `${(extracted.aggregate_percent ?? "?").toString().padStart(5)}%  ` +
          `active=${extracted.is_active_intent}`,
      );
      pulled++;
    } catch (e) {
      failures++;
      console.error(`  ${filing.accession_number}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { pulled, failures };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const since = argv.find((a) => a.startsWith("--since="))?.split("=")[1];
  const limit = parseInt(argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0", 10) || undefined;
  const concurrency = parseInt(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "4", 10);
  const force = argv.includes("--force");
  const only13d = argv.includes("--13d-only");
  if (argv.includes("--headers-only")) return backfillHeaders(concurrency);
  if (argv.includes("--classify-intent")) return classifyIntent(concurrency, argv.includes("--all"));
  const tickers = argv.filter((a) => !a.startsWith("--"));
  const targets = await resolveTargets(tickers);

  // Global filing-level queue (was: per-issuer pool). LLM calls
  // dominate runtime; iterating empty-13D issuers serially wastes worker
  // time, and most R3K issuers have zero 13D activity. One SELECT across
  // all CIKs + a flat N-worker pool keeps the LLM pipeline saturated.
  const ciks = targets.map((t) => t.cik);
  const nameByCik = new Map(targets.map((t) => [t.cik, t.name]));
  const tickerByCik = new Map(targets.map((t) => [t.cik, t.ticker]));
  const params: unknown[] = [ciks];
  let where = "f.cik = any($1::text[]) and (f.form like 'SC 13%' or f.form like 'SCHEDULE 13%')";
  if (only13d) where += " and f.form ilike '%13D%'";
  if (since) {
    params.push(since);
    where += ` and f.filing_date >= $${params.length}::date`;
  }
  const filingsRes = await pool.query<Filing>(
    limit
      ? `select accession_number, cik, form, filing_date, primary_doc_url
         from (
           select f.accession_number, f.cik, f.form, f.filing_date::text, f.primary_doc_url,
                  row_number() over (partition by f.cik order by f.filing_date desc) as rn
           from filings f
           where ${where}
             ${force ? "" : "and not exists (select 1 from thirteen_d_filings t where t.accession_number = f.accession_number)"}
         ) t
         where rn <= ${limit}`
      : `select f.accession_number, f.cik, f.form, f.filing_date::text, f.primary_doc_url
         from filings f
         where ${where}
           ${force ? "" : "and not exists (select 1 from thirteen_d_filings t where t.accession_number = f.accession_number)"}
         order by f.filing_date desc`,
    params,
  );
  const filings = filingsRes.rows;
  console.log(`pull-13d: ${filings.length} filings to process across ${targets.length} issuer(s)` +
    `${since ? ` since=${since}` : ""}${limit ? ` limit=${limit}/issuer` : ""} concurrency=${concurrency}`);
  if (filings.length === 0) {
    await pool.end();
    return;
  }

  let cursor = 0;
  let pulled = 0;
  let failures = 0;
  let done = 0;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= filings.length) return;
      const filing = filings[idx]!;
      const issuerName = nameByCik.get(filing.cik) ?? filing.cik;
      const ticker = tickerByCik.get(filing.cik) ?? filing.cik;
      try {
        const extracted = await extractOne(filing, issuerName);
        if (!extracted) {
          failures++;
        } else {
          await persist(filing, extracted, extracted, issuerName);
          console.log(
            `  [${ticker}] ${filing.accession_number} ${filing.form.padEnd(11)} ` +
              `${(extracted.filer_name ?? "").slice(0, 35).padEnd(35)} ` +
              `${(extracted.aggregate_percent ?? "?").toString().padStart(5)}%  ` +
              `active=${extracted.is_active_intent}`,
          );
          pulled++;
        }
      } catch (e) {
        failures++;
        console.error(`  [${ticker}] ${filing.accession_number} FAILED: ${e instanceof Error ? e.message : e}`);
      }
      done++;
      if (done % 50 === 0 || done === filings.length) {
        const secs = (Date.now() - startedAt) / 1000;
        const rate = done / secs;
        const eta = (filings.length - done) / Math.max(rate, 0.001);
        console.log(`--- progress: ${done}/${filings.length} (${pulled} extracted, ${failures} failed) ${rate.toFixed(1)} filings/s, ETA ${(eta / 60).toFixed(1)} min ---`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, filings.length) }, () => worker()));
  console.log(`done: ${pulled} extracted, ${failures} failures`);
  await pool.end();
}

// Run `fn` over `items` with N workers, logging progress every 200.
async function pool_(label: string, items: unknown[], concurrency: number, fn: (i: number) => Promise<boolean>): Promise<void> {
  let cursor = 0, done = 0, ok = 0;
  const t0 = Date.now();
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      try { if (await fn(i)) ok++; } catch (e) { console.error(`  ${label} ${i} FAILED: ${e instanceof Error ? e.message : e}`); }
      if (++done % 200 === 0 || done === items.length) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`--- progress: ${done}/${items.length} (${ok} updated) ${rate.toFixed(1)}/s, ETA ${((items.length - done) / Math.max(rate, 0.001) / 60).toFixed(1)} min ---`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

// --headers-only: correct filer and self-filed on existing rows from the
// EDGAR header. No LLM calls.
async function backfillHeaders(concurrency: number): Promise<void> {
  const rows = (await pool.query<Filing>(
    `select t.accession_number, t.cik, t.form, t.filing_date::text, f.primary_doc_url
       from thirteen_d_filings t join filings f using (accession_number)
      where f.primary_doc_url is not null`,
  )).rows;
  console.log(`headers-only: ${rows.length} filings`);
  await pool_("header", rows, concurrency, async (i) => {
    const f = rows[i]!;
    const h = await fetchHeader(f);
    if (!h) return false;
    const self = h.subjectCik ? h.subjectCik.padStart(10, "0") !== f.cik.padStart(10, "0") : null;
    await pool.query(
      `update thirteen_d_filings set
         filer_name = coalesce($2, filer_name),
         filer_cik = coalesce($3, filer_cik),
         is_self_filed = coalesce($4, is_self_filed)
       where accession_number = $1`,
      [f.accession_number, h.filerName, h.filerCik ? h.filerCik.padStart(10, "0") : null, self],
    );
    return true;
  });
  await pool.end();
}

const IntentAnswer = z.object({ active: z.boolean() });
const INTENT_PROMPT =
  "You classify the purpose statement (Item 4) of an SEC Schedule 13D. Answer active=true only when " +
  "the filer states plans or intent to influence the company: seek board seats or nominate directors, " +
  "push for a sale, merger, spin-off or strategic review, change management, capital allocation or " +
  "governance, run a proxy contest, or engage with management or the board to make such changes. " +
  "Boilerplate reservations of rights ('may in the future...', 'reserve the right to...') alone are " +
  "not active. Investment-only, financing, estate-planning, forward-sale or insider/officer holdings " +
  "are not active. Return only JSON: {\"active\": true|false}.";

// --classify-intent: second pass over 13Ds the extraction left undecided,
// using only the purpose summary it already stored.
async function classifyIntent(concurrency: number, all: boolean): Promise<void> {
  const rows = (await pool.query<{ accession_number: string; purpose_summary: string }>(
    `select accession_number, purpose_summary from thirteen_d_filings
      where ${all ? "true" : "is_active_intent is null"} and purpose_summary is not null
        and form ilike '%13D%' and not is_self_filed`,
  )).rows;
  console.log(`classify-intent: ${rows.length} filings`);
  await pool_("intent", rows, concurrency, async (i) => {
    const r = rows[i]!;
    const { json } = await callLLM({ systemPrompt: INTENT_PROMPT, userPrompt: r.purpose_summary, maxTokens: 50 });
    const { active } = IntentAnswer.parse(json);
    await pool.query(`update thirteen_d_filings set is_active_intent = $2 where accession_number = $1`, [r.accession_number, active]);
    return true;
  });
  // Amendments that leave Item 4 unchanged carry no purpose text; they keep
  // the intent of the same filer's latest earlier filing on the company.
  const inherited = await pool.query(
    `update thirteen_d_filings a set is_active_intent = (
       select p.is_active_intent from thirteen_d_filings p
        where p.cik = a.cik and p.filer_cik = a.filer_cik
          and p.filing_date < a.filing_date and p.is_active_intent is not null
        order by p.filing_date desc limit 1)
     where a.is_active_intent is null and a.form ilike '%13D/A' and a.filer_cik is not null`,
  );
  console.log(`inherited intent onto ${inherited.rowCount} amendment(s) (null where no earlier filing decided)`);
  await pool.end();
}

await main();
