// Rollup news tracker, meant to run daily. Most AI-rollup acquisitions are
// private companies that never file with the SEC; buyers announce them in
// press releases that Google News indexes within hours. This reads Google
// News RSS searches and turns headlines into deals.
//
//   1. Feeds: one search per rollup_buyers entry (its name and aliases),
//      plus discovery searches for rollup language.
//   2. rollup_news keeps every new headline: title, outlet, link, date.
//      No article text is stored.
//   3. The LLM reads new headlines in batches and extracts acquisitions
//      (buyer, target, sector, type) with a confidence score. Deals are
//      deduplicated on buyer + target into rollup_deals, each with all of
//      its source links. Buyers not in the registry go to
//      rollup_buyer_candidates for review instead of onto the site.
//
// CLI:
//   tsx src/track-news.ts              # last 3 days
//   tsx src/track-news.ts --backfill   # each feed's full window (~100 items)

import { z } from "zod";
import { pool } from "./db.js";
import { callLLM } from "./llm.js";

const MODEL = "anthropic/claude-haiku-5.5";
const DISCOVERY = [
  `"AI roll-up" acquires`, `"AI rollup" acquires`, `"AI holding company" acquires`,
  `"AI-native" acquires accounting firm`, `"AI-native" acquires managed service provider`,
  `"AI-enabled" roll-up acquisition`,
];

interface Item { guid: string; title: string; source: string; url: string; published: string; query: string; buyer_slug: string | null }

const decode = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
const tag = (xml: string, t: string) => decode(xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? "");

async function feed(query: string, days: number | null, buyer_slug: string | null): Promise<Item[]> {
  const q = days ? `${query} when:${days}d` : query;
  const url = `https://news.google.com/rss/search?${new URLSearchParams({ q, hl: "en-US", gl: "US", ceid: "US:en" })}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; TakeoverBot/1.0)" }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.ok) {
      const xml = await res.text();
      return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
        const it = m[1]!;
        const source = tag(it, "source");
        // Google appends " - Outlet" to titles.
        const title = tag(it, "title").replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
        return { guid: tag(it, "guid") || tag(it, "link"), title, source, url: tag(it, "link"), published: new Date(tag(it, "pubDate")).toISOString(), query, buyer_slug };
      });
    }
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
  }
  console.error(`  feed failed: ${query}`);
  return [];
}

const Extract = z.object({
  deals: z.array(z.object({
    item: z.coerce.number(),
    buyer: z.string(),
    target: z.string(),
    target_sector: z.string().catch(""),
    deal_type: z.enum(["acquisition", "merger", "investment", "partnership", "other"]).catch("other"),
    ai_rollup: z.boolean().catch(false),
    confidence: z.coerce.number().min(0).max(1).catch(0.5),
  })).catch([]),
});

const PROMPT = `You read news headlines and extract acquisitions made by AI rollups and holding companies: buyers that acquire services businesses (accounting, IT services, HOA management, insurance, healthcare services, business travel, etc.) and run them with AI.

Input: numbered headlines, each with its outlet. Return JSON only:
{"deals": [{"item": number, "buyer": string, "target": string, "target_sector": string, "deal_type": "acquisition"|"merger"|"investment"|"partnership"|"other", "ai_rollup": boolean, "confidence": number}]}

- One entry per headline that announces a specific deal; skip commentary, opinion, funding rounds of the buyer itself, hires and product news.
- buyer: the acquiring rollup or holdco (e.g. "Long Lake", "Thrive Holdings", "Crete Professionals Alliance"), not its lawyers or bankers.
- target: the company acquired or joining. "X joins Crete" means Crete acquired or partnered with X.
- ai_rollup: true if the buyer is an AI rollup / AI holding company or a platform backed by one.
- confidence: 0-1 that the headline really announces this deal.`;

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9 ]/g, " ")
  .replace(/\b(inc|llc|ltd|corp|corporation|company|co|group|holdings|the|cpas?|pllc|pc|llp)\b/g, " ").replace(/\s+/g, " ").trim();

async function main(): Promise<void> {
  await pool.query(`create table if not exists rollup_news (
    guid text primary key, title text not null, source text, url text not null, published timestamptz,
    query text, buyer_slug text, extracted boolean not null default false, seen_at timestamptz not null default now())`);
  await pool.query(`create table if not exists rollup_deals (
    id text primary key, buyer text not null, buyer_slug text, target text not null, target_sector text, deal_type text,
    ai_rollup boolean, confidence real, announced date, sources jsonb not null default '[]', created_at timestamptz not null default now())`);
  await pool.query(`alter table rollup_deals add column if not exists duplicate_of text`);
  await pool.query(`create table if not exists rollup_buyer_candidates (
    name text primary key, mentions int not null default 1, example text, first_seen timestamptz not null default now())`);

  const days = process.argv.includes("--backfill") ? null : 3;
  const buyers = (await pool.query<{ slug: string; name: string; aliases: string[]; queries: string[] | null }>(
    `select slug, name, aliases, queries from rollup_buyers`)).rows;
  const items: Item[] = [];
  for (const b of buyers) {
    const qs = b.queries?.length ? b.queries : [[...new Set([b.name, ...b.aliases])].map((a) => `"${a}"`).join(" OR ")];
    for (const q of qs) items.push(...(await feed(q, days, b.slug)));
  }
  for (const q of DISCOVERY) items.push(...(await feed(q, days, null)));
  let fresh = 0;
  for (const it of items) {
    const r = await pool.query(
      `insert into rollup_news (guid, title, source, url, published, query, buyer_slug) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (guid) do nothing`, [it.guid, it.title, it.source, it.url, it.published, it.query, it.buyer_slug]);
    fresh += r.rowCount ?? 0;
  }
  console.log(`feeds: ${items.length} items, ${fresh} new`);

  // Extract in batches of 25 headlines.
  if (process.argv.includes("--reextract")) await pool.query(`update rollup_news set extracted = false`);
  const todo = (await pool.query<{ guid: string; title: string; source: string; url: string; published: string; buyer_slug: string | null }>(
    `select guid, title, source, url, published::text, buyer_slug from rollup_news where not extracted order by published`)).rows;
  // A registry alias in the extracted buyer name, or -- for a headline from
  // that buyer's own search -- the buyer's display name ("Titan").
  const slugOf = (name: string, feedSlug: string | null) =>
    buyers.find((b) => [b.name, ...b.aliases].some((a) => norm(name).includes(norm(a))))?.slug
    ?? (feedSlug && norm(name).length >= 4 && norm(buyers.find((b) => b.slug === feedSlug)?.name ?? "").startsWith(norm(name)) ? feedSlug : null);
  let deals = 0;
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    try {
      const { json } = await callLLM({
        model: MODEL, systemPrompt: PROMPT, maxTokens: 6000,
        userPrompt: batch.map((b, j) => `${j + 1}. ${b.title} (${b.source}, ${b.published.slice(0, 10)})`).join("\n"),
      });
      for (const d of Extract.parse(json).deals) {
        const src = batch[d.item - 1];
        if (!src || d.confidence < 0.5 || !["acquisition", "merger"].includes(d.deal_type)) continue;
        const slug = slugOf(d.buyer, src.buyer_slug);
        if (!slug) {
          if (d.ai_rollup) await pool.query(
            `insert into rollup_buyer_candidates (name, example) values ($1, $2)
             on conflict (name) do update set mentions = rollup_buyer_candidates.mentions + 1`, [d.buyer, src.title]);
          continue;
        }
        const id = `${slug}:${norm(d.target)}`;
        const source = { title: src.title, outlet: src.source, url: src.url, published: src.published };
        await pool.query(
          `insert into rollup_deals (id, buyer, buyer_slug, target, target_sector, deal_type, ai_rollup, confidence, announced, sources)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10)
           on conflict (id) do update set
             sources = case when rollup_deals.sources @> jsonb_build_array(jsonb_build_object('url', $11::text)) then rollup_deals.sources
                            else rollup_deals.sources || $10::jsonb end,
             announced = least(rollup_deals.announced, excluded.announced),
             confidence = greatest(rollup_deals.confidence, excluded.confidence)`,
          [id, buyers.find((b) => b.slug === slug)!.name, slug, d.target, d.target_sector, d.deal_type, d.ai_rollup, d.confidence,
            src.published.slice(0, 10), JSON.stringify([source]), src.url]);
        deals++;
      }
      await pool.query(`update rollup_news set extracted = true where guid = any($1)`, [batch.map((b) => b.guid)]);
    } catch (e) {
      console.error(`  batch ${i / 25} FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }
  await dedupe();
  // Candidates that have since joined the registry.
  for (const b of buyers) await pool.query(`delete from rollup_buyer_candidates where lower(name) = lower($1) or lower(name) = any($2)`,
    [b.name, b.aliases.map((a) => a.toLowerCase())]);
  const s = await pool.query(`select buyer, count(*)::int deals, max(announced)::text latest from rollup_deals group by 1 order by 2 desc`);
  console.log(`extracted ${deals} deal mentions from ${todo.length} headlines`);
  console.table(s.rows);
  const c = await pool.query(`select name, mentions, example from rollup_buyer_candidates order by mentions desc limit 15`);
  if (c.rows.length) { console.log("buyer candidates for review:"); console.table(c.rows); }
  await pool.end();
}

// The same transaction is reported at announcement and at closing, under
// different names ("Amex GBT", "American Express Global Business Travel"),
// and public deals are also covered by SEC filings. Per buyer, the LLM
// groups headlines-derived deals that are one transaction; each group keeps
// its earliest row, the rest point at it (or at "public:<cik>").
const Groups = z.object({ groups: z.array(z.object({ ids: z.array(z.string()), public_cik: z.string().nullable().catch(null) })).catch([]) });
async function dedupe(): Promise<void> {
  const buyers = (await pool.query<{ buyer_slug: string }>(`select distinct buyer_slug from rollup_deals where buyer_slug is not null`)).rows;
  let merged = 0;
  for (const { buyer_slug } of buyers) {
    const deals = (await pool.query<{ id: string; target: string; announced: string }>(
      `select id, target, announced::text from rollup_deals where buyer_slug = $1 order by announced, id`, [buyer_slug])).rows;
    const pub = (await pool.query<{ cik: string; name: string; filing_date: string }>(
      `select distinct on (d.cik) d.cik, c.name, d.filing_date::text from deal_filings d join companies c using (cik)
        where d.rollup_buyer = $1 order by d.cik, d.filing_date`, [buyer_slug])).rows;
    if (deals.length < 2 && !pub.length) continue;
    const { json } = await callLLM({
      model: MODEL, maxTokens: 2000,
      systemPrompt: `Group acquisition records that describe the same transaction (same target company, e.g. announcement and completion, or a nickname vs the full name). Return JSON only: {"groups": [{"ids": [string], "public_cik": string|null}]} listing only groups with 2+ records, or 1+ record that matches a public deal (then give its cik). Different targets are never grouped.`,
      userPrompt: [
        "Records:", ...deals.map((d) => `${d.id} | ${d.target} | ${d.announced}`),
        "", "Public deals (SEC):", ...(pub.length ? pub.map((p) => `${p.cik} | ${p.name} | ${p.filing_date}`) : ["none"]),
      ].join("\n"),
    });
    await pool.query(`update rollup_deals set duplicate_of = null where buyer_slug = $1`, [buyer_slug]);
    for (const g of Groups.parse(json).groups) {
      const ids = g.ids.filter((id) => deals.some((d) => d.id === id));
      const keep = g.public_cik && pub.some((p) => p.cik === g.public_cik) ? `public:${g.public_cik}` : ids[0];
      const drop = keep?.startsWith("public:") ? ids : ids.slice(1);
      if (!keep || !drop.length) continue;
      await pool.query(`update rollup_deals set duplicate_of = $2 where id = any($1)`, [drop, keep]);
      merged += drop.length;
    }
  }
  console.log(`dedupe: ${merged} duplicate deal rows folded`);
}

await main();
