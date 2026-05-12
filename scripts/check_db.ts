// Sanity-check what landed in Postgres after the ingest run. Throwaway -- just
// pokes at counts so we can see we're not missing tables.
import { pool } from "../packages/ingest/src/db.js";

async function dump(label: string, q: string, args: unknown[] = []): Promise<void> {
  const r = await pool.query(q, args);
  console.log(`\n--- ${label} (${r.rows.length}) ---`);
  for (const row of r.rows) console.log(row);
}

async function main(): Promise<void> {
  await dump("companies", "select cik, ticker, name from companies order by ticker");
await dump("filings count by form", "select form, count(*)::int from filings group by form order by 2 desc limit 8");
await dump("ETSY revenue", "select fiscal_year, value from financial_metrics where cik='0001370637' and concept='revenue' order by fiscal_year desc limit 5");
await dump("proxy_extractions", "select id, cik, fiscal_year_covered, prompt_tokens, completion_tokens from proxy_extractions order by cik");
await dump("summary_compensation per ticker", "select c.ticker, count(*)::int from summary_compensation sc join proxy_extractions pe on pe.id=sc.extraction_id join companies c on c.cik=pe.cik group by c.ticker");
await dump("CEO total perks (all_other_compensation sum)", `
  select c.ticker, sc.name, sc.title, round(coalesce(sum(aoc.amount), 0))::bigint as perks_total
  from summary_compensation sc
  join proxy_extractions pe on pe.id=sc.extraction_id
  join companies c on c.cik=pe.cik
  left join all_other_compensation aoc on aoc.extraction_id=sc.extraction_id and aoc.name=sc.name and aoc.fiscal_year=sc.fiscal_year
  where sc.title ilike '%chief executive%'
  group by c.ticker, sc.name, sc.title`);
await dump("Pay-vs-Performance latest year", "select c.ticker, pvp.year, pvp.company_tsr_indexed, pvp.peer_group_tsr_indexed, round(pvp.ceo_compensation_actually_paid)::bigint as ceo_cap from pay_vs_performance pvp join proxy_extractions pe on pe.id=pvp.extraction_id join companies c on c.cik=pe.cik where pvp.year = pe.fiscal_year_covered order by c.ticker");
  await dump("equity_ownership 5pct holders", "select c.ticker, eo.name, eo.holder_type, round(eo.shares)::bigint as shares, eo.percent_class from equity_ownership eo join proxy_extractions pe on pe.id=eo.extraction_id join companies c on c.cik=pe.cik where eo.holder_type='5pct_holder' order by c.ticker, eo.percent_class desc nulls last");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
