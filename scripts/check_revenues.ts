import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  const r = await pool.query(
    `select cik, fiscal_year, value from financial_metrics
     where concept='revenue' and fiscal_year between 2018 and 2025
       and cik in ('0001065088','0001370637')
     order by cik, fiscal_year`,
  );
  console.log("ticker  fy    revenue");
  for (const row of r.rows) {
    const ticker = row.cik === "0001065088" ? "EBAY" : "ETSY";
    const v = (row.value / 1e9).toFixed(2);
    console.log(`${ticker}   ${row.fiscal_year}  $${v}B`);
  }
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
