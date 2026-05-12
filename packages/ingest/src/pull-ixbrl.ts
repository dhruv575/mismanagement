// Parses inline XBRL from DEF 14A primary docs into the ixbrl_facts table.
//
// Inline XBRL (iXBRL) is HTML with embedded XBRL elements. The visible
// reader-facing text is wrapped in <ix:nonFraction>/<ix:nonNumeric> elements
// that name a concept and reference a <xbrli:context> defining period and
// dimensions (which NEO, which fiscal year, etc.).
//
// We persist whatever the filer has tagged -- generic fact table, no
// hardcoded mapping. Downstream queries / views materialize specific
// disclosures (CEO Pay Ratio, per-NEO SCT) when the tags are present.
//
// What's tagged today varies by filer. The Pay-vs-Performance disclosure is
// universal as of FY2023+ filings. Per-NEO Summary Compensation Table
// tagging is phasing in (large accelerated filers from FY2024). Most large
// filers tag PvP only.
//
// CLI:
//   tsx src/pull-ixbrl.ts                 # all proxies in filings table for R3K
//   tsx src/pull-ixbrl.ts ETSY EBAY       # subset
//   tsx src/pull-ixbrl.ts --force         # re-parse even if facts exist
//   tsx src/pull-ixbrl.ts --concurrency=4 # parallel HTTP

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";
import { resolveTargets, type IssuerSeed } from "./issuers.js";

interface ProxyTarget {
  cik: string;
  ticker: string;
  accession_number: string;
  primary_doc_url: string;
}

interface ContextDef {
  start: string | null;
  end: string | null;
  dimensionMembers: Record<string, string>;
}

interface ParsedFact {
  concept: string;
  contextRef: string;
  unit: string | null;
  numericValue: number | null;
  textValue: string | null;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
  });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return await res.text();
}

// Extracts <xbrli:context id="..."> blocks. Each block defines the period
// (instant or duration) and zero+ dimension members (axis -> member). We
// grab the inner XML of each block via balanced-tag matching, then slice
// the period/dimension fields with focused regex.
function parseContexts(html: string): Map<string, ContextDef> {
  const out = new Map<string, ContextDef>();
  const blockRe = /<xbrli:context\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:context>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const id = m[1]!;
    const inner = m[2]!;
    const start = inner.match(/<xbrli:startDate>([^<]+)<\/xbrli:startDate>/i)?.[1] ?? null;
    const end =
      inner.match(/<xbrli:endDate>([^<]+)<\/xbrli:endDate>/i)?.[1] ??
      inner.match(/<xbrli:instant>([^<]+)<\/xbrli:instant>/i)?.[1] ??
      null;
    const members: Record<string, string> = {};
    const memRe = /<xbrldi:explicitMember\s+dimension="([^"]+)"[^>]*>([^<]+)<\/xbrldi:explicitMember>/gi;
    let mm: RegExpExecArray | null;
    while ((mm = memRe.exec(inner)) !== null) {
      members[mm[1]!] = mm[2]!.trim();
    }
    out.set(id, { start, end, dimensionMembers: members });
  }
  return out;
}

// Strips any nested HTML markup from the visible content of an ix:* element
// so the numeric / text value is plain. iXBRL allows arbitrary HTML inside
// the wrapper (formatting, footnotes), but the value we want is the text.
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumericValue(visible: string, attrs: Record<string, string>): number | null {
  // Strip currency symbols and parens (negatives).
  let txt = visible.replace(/\$/g, "").replace(/^\((.+)\)$/, "-$1").trim();
  // Comma vs. period as decimal separator. SEC filings predominantly use
  // US format ("1,234.56" with comma=thousands, period=decimal), but a few
  // filers (TGLS, some foreign issuers) use European format ("1.234,56" or
  // "311,85" with comma=decimal). Heuristic:
  //   - period present + period after the comma  -> US ("1,234.56")
  //   - one comma, 1-2 digits after it, no period -> EU decimal ("311,85")
  //   - otherwise, treat comma as thousands-sep and strip.
  // The ix:nonFraction `format` attr (e.g. ixt:numdotdecimal) is the
  // authoritative source but filers tag it inconsistently — fall through
  // to text shape when format is missing/ambiguous.
  const format = attrs.format ?? "";
  const formatSaysCommaDecimal = /commadecimal|numcommadot|numdotcomma/i.test(format);
  // EU shape: a single comma with 1-2 trailing digits and no period -- in US
  // format a comma is a thousands separator and should be followed by groups
  // of 3 digits, so "311,85" can't be US.
  const euShape = !txt.includes(".") && /^-?\d+,\d{1,2}$/.test(txt);
  if (formatSaysCommaDecimal || euShape) {
    txt = txt.replace(/\./g, "").replace(",", ".");
  } else {
    txt = txt.replace(/,/g, "");
  }
  const cleaned = txt;
  let n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;

  // Inline XBRL `scale` attr multiplies (e.g. scale="3" means thousands).
  // BUT: PvP TSR fields (ecd:TotalShareholderRtnAmt and the peer variant)
  // are a special case. The disclosure rule defines them as "the dollar
  // value of a $100 initial investment", so the visible text is ALWAYS
  // the actual amount (typically $10–$1000) — filers display it directly
  // to readers. A non-trivial population of filers (SMR scale=6, FSS
  // scale=6, ENVIRI scale=3, etc.) erroneously include a scale attribute
  // that would inflate the value to absurd magnitudes ($339M for a $100
  // investment). We ignore the scale attribute for these two concepts
  // unconditionally.
  //
  // Other concepts (e.g. us-gaap:Revenues tagged with visible "1.5" and
  // scale="6" meaning $1.5M) are unaffected — scale remains active.
  const TSR_CONCEPTS = new Set([
    "ecd:TotalShareholderRtnAmt",
    "ecd:PeerGroupTotalShareholderRtnAmt",
  ]);
  // PvP per-executive-per-year comp values. Filers occasionally tag a
  // scale="6" on a value they ALSO wrote out in full (e.g. visible
  // "33,105" + scale=6 ⇒ nonsensical $33B PEO CAP). We can't blindly
  // ignore scale: some filers legitimately use it (TSLA tags Musk's $43B
  // CAP as visible "43,019" + scale="6" + decimals="-6", which is the
  // canonical "value in millions, rounded to nearest million" pattern).
  //
  // Detection: in well-formed iXBRL, `-decimals` matches `scale`. TSLA
  // has decimals=-6 and scale=6 → consistent → trust scale. SMR has
  // decimals=0 and scale=6 → INCONSISTENT → ignore scale. NVRI's bad TSR
  // tagging (decimals=-1 scale=3) fell into the same trap. The rule:
  // for PvP comp concepts, drop the scale multiplier if the decimals
  // attribute indicates a precision finer than the scale would imply.
  const PVP_COMP_CONCEPTS = new Set([
    "ecd:PeoTotalCompAmt",
    "ecd:PeoActuallyPaidCompAmt",
    "ecd:NonPeoNeoAvgTotalCompAmt",
    "ecd:NonPeoNeoAvgCompActuallyPaidAmt",
  ]);
  const concept = attrs.name ?? "";
  const scaleRaw = parseInt(attrs.scale ?? "0", 10);
  const decimalsRaw = attrs.decimals != null ? parseInt(attrs.decimals, 10) : null;
  let skipScale = TSR_CONCEPTS.has(concept);
  if (
    PVP_COMP_CONCEPTS.has(concept) &&
    scaleRaw > 0 &&
    decimalsRaw !== null &&
    Number.isFinite(decimalsRaw) &&
    -decimalsRaw < scaleRaw
  ) {
    skipScale = true;
  }
  if (Number.isFinite(scaleRaw) && scaleRaw !== 0 && !skipScale) {
    n *= Math.pow(10, scaleRaw);
  }

  // `sign` attr can flip sign explicitly (some filers tag negatives this way).
  if (attrs.sign === "-") n = -n;
  return n;
}

function parseAttrs(attrString: string): Record<string, string> {
  // iXBRL is case-sensitive about attribute names ("contextRef" not
  // "contextref"), but downstream code uses lowercase keys for tolerance --
  // some HTML processors normalize to lower. We lowercase on the way in.
  const out: Record<string, string> = {};
  const re = /([a-zA-Z][a-zA-Z0-9_:-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString)) !== null) out[m[1]!.toLowerCase()] = m[2]!;
  return out;
}

// Walks <ix:nonFraction> and <ix:nonNumeric> elements. Both can have nested
// content; we extract by scanning forward and matching the corresponding
// closing tag, accounting for arbitrary depth. We don't try to handle
// nested ix:* elements inside the outer one (rare in proxies, and we'd
// double-count if we did).
function parseFacts(html: string): ParsedFact[] {
  const out: ParsedFact[] = [];
  const tagRe = /<ix:(nonFraction|nonNumeric)([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1]!.toLowerCase();
    const attrs = parseAttrs(m[2]!);
    if (!attrs.name || !attrs.contextref) continue;
    // Find the matching close tag from the position after our open.
    const closeRe = new RegExp(`</ix:${tag}>`, "i");
    const after = html.slice(tagRe.lastIndex);
    const closeMatch = after.match(closeRe);
    if (!closeMatch) continue;
    const innerEnd = closeMatch.index!;
    const inner = after.slice(0, innerEnd);
    const visible = visibleText(inner);

    const fact: ParsedFact = {
      concept: attrs.name,
      contextRef: attrs.contextref,
      unit: attrs.unitref ?? null,
      numericValue: tag === "nonfraction" ? parseNumericValue(visible, attrs) : null,
      textValue: tag === "nonnumeric" ? visible : null,
    };
    out.push(fact);
  }
  return out;
}

async function persist(target: ProxyTarget, contexts: Map<string, ContextDef>, facts: ParsedFact[]): Promise<{ persisted: number }> {
  // Idempotent: replace this filing's facts before inserting.
  await pool.query(
    `delete from ixbrl_facts where accession_number = $1`,
    [target.accession_number],
  );

  if (facts.length === 0) return { persisted: 0 };

  // Bulk UNNEST insert: one round-trip vs. ~100 sequential per filing
  // (which dominated the per-issuer wall time at concurrency=8).
  // The PK is (cik, accession_number, concept, context_ref) -- but the
  // generic iXBRL parser may emit multiple facts for the same (concept,
  // context) when a value is tagged in a header AND a table cell. Dedupe
  // in JS rather than rely on ON CONFLICT, since DB-side ON CONFLICT can
  // return only the first row of duplicates for the same upsert batch.
  type Row = {
    cik: string;
    accn: string;
    concept: string;
    contextRef: string;
    periodStart: string | null;
    periodEnd: string | null;
    dimMembers: string | null;
    numericValue: number | null;
    textValue: string | null;
    unit: string | null;
  };
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const f of facts) {
    const key = `${f.concept}|${f.contextRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ctx = contexts.get(f.contextRef);
    rows.push({
      cik: target.cik,
      accn: target.accession_number,
      concept: f.concept,
      contextRef: f.contextRef,
      periodStart: ctx?.start || null,
      periodEnd: ctx?.end || null,
      dimMembers: ctx ? JSON.stringify(ctx.dimensionMembers) : null,
      numericValue: f.numericValue,
      textValue: f.textValue,
      unit: f.unit,
    });
  }

  await pool.query(
    `insert into ixbrl_facts (
       cik, accession_number, concept, context_ref,
       period_start, period_end, dimension_members,
       numeric_value, text_value, unit
     )
     select * from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[],
       $5::date[], $6::date[], $7::jsonb[],
       $8::float8[], $9::text[], $10::text[]
     )
     on conflict (cik, accession_number, concept, context_ref) do nothing`,
    [
      rows.map((r) => r.cik),
      rows.map((r) => r.accn),
      rows.map((r) => r.concept),
      rows.map((r) => r.contextRef),
      rows.map((r) => r.periodStart),
      rows.map((r) => r.periodEnd),
      rows.map((r) => r.dimMembers),
      rows.map((r) => r.numericValue),
      rows.map((r) => r.textValue),
      rows.map((r) => r.unit),
    ],
  );
  return { persisted: rows.length };
}

async function pullOne(target: ProxyTarget): Promise<{ persisted: number }> {
  const html = await fetchText(target.primary_doc_url);
  const contexts = parseContexts(html);
  const facts = parseFacts(html);
  if (facts.length === 0) return { persisted: 0 };
  return persist(target, contexts, facts);
}

async function targetsFor(issuers: IssuerSeed[], force: boolean): Promise<ProxyTarget[]> {
  // Single bulk query: most-recent DEF 14A per CIK in our issuer set, plus
  // an antijoin against ixbrl_facts so we only return ones that haven't been
  // parsed yet (unless --force).
  if (issuers.length === 0) return [];
  const ciks = issuers.map((i) => i.cik);
  const tickerByCik = new Map(issuers.map((i) => [i.cik, i.ticker]));

  const sql = `
    with latest as (
      select distinct on (f.cik)
        f.cik, f.accession_number, f.primary_doc_url
      from filings f
      where f.cik = any($1::text[])
        and f.form = 'DEF 14A'
        and f.primary_doc_url is not null
      order by f.cik, f.filing_date desc
    )
    select l.cik, l.accession_number, l.primary_doc_url
    from latest l
    ${force ? "" : "where not exists (select 1 from ixbrl_facts x where x.accession_number = l.accession_number)"}
  `;
  const r = await pool.query<{ cik: string; accession_number: string; primary_doc_url: string }>(sql, [ciks]);
  return r.rows.map((row) => ({
    cik: row.cik,
    ticker: tickerByCik.get(row.cik) ?? row.cik,
    accession_number: row.accession_number,
    primary_doc_url: row.primary_doc_url,
  }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const concurrency = parseInt(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "4", 10);
  const tickers = argv.filter((a) => !a.startsWith("--"));
  const issuers = await resolveTargets(tickers);
  const targets = await targetsFor(issuers, force);
  console.log(`pull-ixbrl: ${targets.length}/${issuers.length} issuer(s) need extraction (force=${force}, concurrency=${concurrency})`);

  if (targets.length === 0) {
    await pool.end();
    return;
  }

  let cursor = 0;
  let totalFacts = 0;
  let failures = 0;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const t = targets[idx]!;
      try {
        const { persisted } = await pullOne(t);
        totalFacts += persisted;
        if (persisted === 0) {
          // Many proxies have no iXBRL tagging at all (smaller filers).
          console.log(`  [${t.ticker}] no iXBRL facts in ${t.accession_number}`);
        } else {
          console.log(`  [${t.ticker}] ${persisted} facts persisted`);
        }
      } catch (e) {
        failures++;
        console.error(`  [${t.ticker}] FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`done: ${totalFacts} facts across ${targets.length - failures} filings in ${elapsed.toFixed(0)}s (${failures} failures)`);
  await pool.end();
}

await main();
