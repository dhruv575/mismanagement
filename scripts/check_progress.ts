import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const t = (q: string, label: string) => pool.query<{ count: number }>(q).then((r) => `${label}: ${r.rows[0]?.count}`);
  const [a, b, c, d, e, f] = await Promise.all([
    t("select count(*)::int as count from companies where is_russell_3000", "R3K companies"),
    t("select count(distinct ticker)::int as count from price_history", "tickers w/ prices"),
    t("select count(distinct cik)::int as count from financial_metrics", "ciks w/ financials"),
    t("select count(distinct cik)::int as count from xbrl_pay_vs_performance", "ciks w/ PvP"),
    t("select count(*)::int as count from filings", "filings rows"),
    t("select count(*)::int as count from xbrl_pay_vs_performance", "PvP fact rows"),
  ]);
  console.log([a, b, c, d, e, f].join("\n"));
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
