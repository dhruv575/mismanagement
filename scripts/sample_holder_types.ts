import { pool } from "../packages/ingest/src/db.js";
async function main(): Promise<void> {
  const r = await pool.query(
    `select holder_type, count(*)::int as n
     from equity_ownership
     group by holder_type
     order by n desc
     limit 30`,
  );
  for (const row of r.rows) console.log(row);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
