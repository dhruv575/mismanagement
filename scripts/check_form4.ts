import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  const r = await pool.query(
    `select c.ticker, it.transaction_date, it.insider_name, it.officer_title,
            it.transaction_code, it.shares, it.price_per_share,
            it.transaction_value, it.ten_b_5_one_plan
     from insider_transactions it join companies c on c.cik = it.cik
     order by it.transaction_date desc, c.ticker, it.insider_name
     limit 20`,
  );
  console.log("ticker date        insider                  code  shares      price    value          10b5-1");
  for (const row of r.rows) {
    const v = row.transaction_value ? `$${(row.transaction_value/1e6).toFixed(2)}M` : "—";
    console.log(
      `${row.ticker.padEnd(7)}${row.transaction_date}  ` +
        `${(row.insider_name || "").padEnd(24)}  ${(row.transaction_code || "").padEnd(4)}  ` +
        `${(row.shares || 0).toLocaleString().padStart(10)}  ` +
        `$${(row.price_per_share || 0).toFixed(2).padStart(7)}  ${v.padEnd(13)}  ` +
        `${row.ten_b_5_one_plan ? "yes" : "no"}`,
    );
  }
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
