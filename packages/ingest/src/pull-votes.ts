// Pulls shareholder vote results from 8-K Item 5.07 filings into the
// shareholder_votes table via an LLM (Vercel AI Gateway).
//
// Item 5.07 8-Ks are short (typically <30KB of HTML text) and list each
// proposal voted on at the annual meeting with For / Against / Abstain /
// Broker Non-Vote tallies. Director elections use For / Withheld instead
// of For / Against. The schema is not standardized -- some filers use
// tables, some prose -- so we extract via LLM.
//
// We compute two denormalized signals from the proposal list:
//   - sop_support_pct  = For / (For + Against) * 100   on the Say-on-Pay
//                        proposal (Item 5.07 row labeled "advisory vote
//                        on executive compensation" or similar)
//   - min_director_support_pct = min over directors of
//                                For / (For + Withheld) * 100
// The full proposal list is preserved as raw_proposals jsonb.
//
// CLI:
//   tsx src/pull-votes.ts                       # all R3K, latest meeting/issuer
//   tsx src/pull-votes.ts ETSY EBAY             # subset by ticker
//   tsx src/pull-votes.ts --since=2024-01-01    # filing date floor
//   tsx src/pull-votes.ts --limit=1             # cap per issuer (default 1)
//   tsx src/pull-votes.ts --force               # re-extract even if cached

import { z } from "zod";
import { pool } from "./db.js";
import { EDGAR_USER_AGENT, LLM_MODEL } from "./env.js";
import { resolveTargets, type IssuerSeed } from "./issuers.js";
import { callLLM } from "./llm.js";

interface Filing {
  accession_number: string;
  cik: string;
  filing_date: string;
  primary_doc_url: string | null;
}

// .default(null): smaller models omit keys they have no value for instead of
// writing null; treat an omitted key as null.
const NullableNumber = z.number().nullable().default(null);
const NullableString = z.string().nullable().default(null);

const Proposal = z.object({
  proposal_type: z.enum([
    "say_on_pay",
    "say_on_pay_frequency",
    "director_election",
    "auditor_ratification",
    "other",
  ]),
  description: NullableString,
  director_name: NullableString,
  votes_for: NullableNumber,
  votes_against: NullableNumber,
  votes_withheld: NullableNumber,
  votes_abstain: NullableNumber,
  broker_non_votes: NullableNumber,
  frequency_chosen: NullableString,
});
type Proposal = z.infer<typeof Proposal>;

const VoteExtraction = z.object({
  meeting_date: NullableString,
  proposals: z.array(Proposal).default([]),
});
type VoteExtraction = z.infer<typeof VoteExtraction>;

const SCHEMA_DESC = {
  type: "object",
  properties: {
    meeting_date: {
      type: ["string", "null"],
      description: "ISO date (YYYY-MM-DD) the meeting was held; null if absent",
    },
    proposals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          proposal_type: {
            type: "string",
            enum: [
              "say_on_pay",
              "say_on_pay_frequency",
              "director_election",
              "auditor_ratification",
              "other",
            ],
            description:
              "say_on_pay = advisory vote to approve executive compensation. " +
              "say_on_pay_frequency = advisory vote on frequency (1/2/3 yrs). " +
              "director_election = election of a single director (one row per " +
              "nominee). auditor_ratification = ratification of independent " +
              "registered public accounting firm. other = anything else " +
              "(amendments, plan approvals, shareholder proposals).",
          },
          description: { type: ["string", "null"], description: "Brief proposal description" },
          director_name: {
            type: ["string", "null"],
            description: "Required when proposal_type=director_election; null otherwise",
          },
          votes_for: { type: ["number", "null"], description: "Raw share count, not %" },
          votes_against: { type: ["number", "null"] },
          votes_withheld: {
            type: ["number", "null"],
            description: "Director elections only; null for For/Against proposals",
          },
          votes_abstain: { type: ["number", "null"] },
          broker_non_votes: { type: ["number", "null"] },
          frequency_chosen: {
            type: ["string", "null"],
            description:
              "For proposal_type=say_on_pay_frequency only: one of '1y', '2y', '3y' " +
              "depending on which option received the most votes. Null otherwise.",
          },
        },
        required: ["proposal_type"],
      },
    },
  },
  required: ["proposals"],
} as const;

const SYSTEM_PROMPT =
  "You extract structured shareholder-vote results from US SEC 8-K Item 5.07 " +
  "filings. All vote counts are raw share counts (not percentages, not " +
  "thousands). One row per director nominee for director elections. Say-on-Pay " +
  "is the advisory vote on executive compensation (usually labeled 'advisory " +
  "vote to approve executive compensation' or similar). Frequency votes are " +
  "the separate advisory vote on whether SoP should occur every 1, 2, or 3 " +
  "years. Do not editorialize. Return only a single JSON object.";

async function fetchHtml(url: string): Promise<string> {
  const maxAttempts = 5;
  let delay = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
    });
    if (res.ok) return await res.text();
    const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retriable || attempt === maxAttempts) throw new Error(`${url}: ${res.status}`);
    const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay + Math.floor(Math.random() * 500);
    await new Promise((r) => setTimeout(r, wait));
    delay = Math.min(delay * 2, 15_000);
  }
  throw new Error(`${url}: unreachable`);
}

function htmlToText(html: string): string {
  // Vote tables come in two shapes:
  //   - Compact: one <tr> per director with For/Against/Abstain in <td>s.
  //   - Stacked: each value in its own paragraph or <br>-separated line.
  // Preserving <td>/<th> as " | " keeps the row structure readable so the
  // model can map columns to header labels. Numeric entities (e.g. &#160;
  // for nbsp, &#8217; for curly apostrophes) get decoded explicitly --
  // otherwise the model sees literal "&#160;" tokens between cells and the
  // table boundaries blur.
  return html
    .replace(/<\/(td|th)\s*>/gi, " | ")
    .replace(/<(br|\/p|\/tr|\/table|\/div)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractOne(filing: Filing, issuerName: string): Promise<VoteExtraction | null> {
  if (!filing.primary_doc_url) return null;
  const html = await fetchHtml(filing.primary_doc_url);
  const text = htmlToText(html);

  const userPrompt =
    `This is an 8-K Item 5.07 filing for ${issuerName} filed ${filing.filing_date}. ` +
    `Extract the meeting date and one entry per proposal voted on (one row per ` +
    `director nominee). Return a single JSON object matching this schema:\n\n` +
    JSON.stringify(SCHEMA_DESC, null, 2) +
    `\n\n=== FILING TEXT ===\n` +
    text;

  const { json } = await callLLM({ systemPrompt: SYSTEM_PROMPT, userPrompt });
  return VoteExtraction.parse(json);
}

interface Derived {
  sop_present: boolean;
  sop_for: number | null;
  sop_against: number | null;
  sop_abstain: number | null;
  sop_support_pct: number | null;
  director_vote_present: boolean;
  director_count: number | null;
  min_director_support_pct: number | null;
  worst_director_name: string | null;
  sop_frequency_chosen: string | null;
}

function derive(ext: VoteExtraction): Derived {
  const sop = ext.proposals.find((p) => p.proposal_type === "say_on_pay");
  let sop_support_pct: number | null = null;
  if (sop && sop.votes_for != null && sop.votes_against != null) {
    const denom = sop.votes_for + sop.votes_against;
    if (denom > 0) sop_support_pct = (sop.votes_for / denom) * 100;
  }

  // Director elections come in two flavors:
  //   - Plurality voting: For / Withheld (typical for non-binding elections)
  //   - Majority voting: For / Against (most large-cap issuers post-Dodd-Frank)
  // Filers tag one or the other, never both. Pick whichever dissent column is
  // present, fall back to skipping the director if both are null.
  const directors = ext.proposals.filter((p) => p.proposal_type === "director_election");
  let min_director_support_pct: number | null = null;
  let worst_director_name: string | null = null;
  for (const d of directors) {
    if (d.votes_for == null) continue;
    const dissent = d.votes_withheld ?? d.votes_against;
    if (dissent == null) continue;
    const denom = d.votes_for + dissent;
    if (denom <= 0) continue;
    const pct = (d.votes_for / denom) * 100;
    if (min_director_support_pct == null || pct < min_director_support_pct) {
      min_director_support_pct = pct;
      worst_director_name = d.director_name ?? null;
    }
  }

  const freq = ext.proposals.find((p) => p.proposal_type === "say_on_pay_frequency");

  return {
    sop_present: !!sop,
    sop_for: sop?.votes_for ?? null,
    sop_against: sop?.votes_against ?? null,
    sop_abstain: sop?.votes_abstain ?? null,
    sop_support_pct,
    director_vote_present: directors.length > 0,
    director_count: directors.length || null,
    min_director_support_pct,
    worst_director_name,
    sop_frequency_chosen: freq?.frequency_chosen ?? null,
  };
}

async function persist(filing: Filing, ext: VoteExtraction, d: Derived): Promise<void> {
  await pool.query(
    `insert into shareholder_votes (
       accession_number, cik, filing_date, meeting_date,
       sop_present, sop_for, sop_against, sop_abstain, sop_support_pct,
       director_vote_present, director_count, min_director_support_pct, worst_director_name,
       sop_frequency_chosen, raw_proposals, model, extracted_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
     on conflict (accession_number) do update set
       meeting_date = excluded.meeting_date,
       sop_present = excluded.sop_present,
       sop_for = excluded.sop_for,
       sop_against = excluded.sop_against,
       sop_abstain = excluded.sop_abstain,
       sop_support_pct = excluded.sop_support_pct,
       director_vote_present = excluded.director_vote_present,
       director_count = excluded.director_count,
       min_director_support_pct = excluded.min_director_support_pct,
       worst_director_name = excluded.worst_director_name,
       sop_frequency_chosen = excluded.sop_frequency_chosen,
       raw_proposals = excluded.raw_proposals,
       model = excluded.model,
       extracted_at = now()`,
    [
      filing.accession_number,
      filing.cik,
      filing.filing_date,
      ext.meeting_date,
      d.sop_present,
      d.sop_for,
      d.sop_against,
      d.sop_abstain,
      d.sop_support_pct,
      d.director_vote_present,
      d.director_count,
      d.min_director_support_pct,
      d.worst_director_name,
      d.sop_frequency_chosen,
      JSON.stringify(ext.proposals),
      LLM_MODEL,
    ],
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const since = argv.find((a) => a.startsWith("--since="))?.split("=")[1];
  const limit = parseInt(argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "1", 10);
  const concurrency = parseInt(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "4", 10);
  const force = argv.includes("--force");
  const tickers = argv.filter((a) => !a.startsWith("--"));
  const targets = await resolveTargets(tickers);

  const ciks = targets.map((t) => t.cik);
  const nameByCik = new Map(targets.map((t) => [t.cik, t.name]));
  const tickerByCik = new Map(targets.map((t) => [t.cik, t.ticker]));

  // Select 8-Ks containing Item 5.07. We use the items array if populated
  // (post pull-edgar items backfill); we fall back to ILIKE on the form
  // text when items is empty so this script remains usable on legacy rows.
  const params: unknown[] = [ciks, limit];
  let where =
    "f.cik = any($1::text[]) and f.form = '8-K' " +
    "and ('5.07' = any(f.items) or coalesce(array_length(f.items, 1), 0) = 0)";
  if (since) {
    params.push(since);
    where += ` and f.filing_date >= $${params.length}::date`;
  }
  const cacheJoin = force
    ? ""
    : `and not exists (select 1 from shareholder_votes sv where sv.accession_number = f.accession_number)`;

  const filingsRes = await pool.query<Filing>(
    `select accession_number, cik, filing_date, primary_doc_url
     from (
       select f.accession_number, f.cik, f.form, f.filing_date::text, f.primary_doc_url,
              row_number() over (partition by f.cik order by f.filing_date desc) as rn
       from filings f
       where ${where}
         ${cacheJoin}
     ) t
     where rn <= $2`,
    params,
  );
  const filings = filingsRes.rows;
  console.log(
    `pull-votes: ${filings.length} candidate 8-K(s) across ${targets.length} issuer(s)` +
      `${since ? ` since=${since}` : ""} limit=${limit}/issuer concurrency=${concurrency}`,
  );
  if (filings.length === 0) {
    await pool.end();
    return;
  }

  let cursor = 0;
  let pulled = 0;
  let skipped = 0;
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
        const ext = await extractOne(filing, issuerName);
        if (!ext) {
          failures++;
        } else if (!ext.proposals.find((p) => p.proposal_type === "say_on_pay") &&
                   !ext.proposals.find((p) => p.proposal_type === "director_election")) {
          // 8-K tagged 5.07 but the LLM found no SoP and no director election --
          // probably a special-meeting 8-K (merger vote, plan amendment only).
          // Persist anyway so we don't re-call next run.
          const d = derive(ext);
          await persist(filing, ext, d);
          skipped++;
        } else {
          const d = derive(ext);
          await persist(filing, ext, d);
          console.log(
            `  [${ticker}] ${filing.accession_number} ` +
              `SoP=${d.sop_support_pct?.toFixed(1) ?? "  -  "}%  ` +
              `minDir=${d.min_director_support_pct?.toFixed(1) ?? "  -  "}% ` +
              `(${d.director_count ?? 0} directors)`,
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
        console.log(
          `--- progress: ${done}/${filings.length} (${pulled} extracted, ${skipped} empty, ${failures} failed) ${rate.toFixed(1)} f/s, ETA ${(eta / 60).toFixed(1)} min ---`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, filings.length) }, () => worker()));
  console.log(`done: ${pulled} extracted, ${skipped} empty, ${failures} failures`);
  await pool.end();
}

await main();
