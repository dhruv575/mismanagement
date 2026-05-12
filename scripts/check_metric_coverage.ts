import { pool } from "../packages/ingest/src/db.js";

async function main(): Promise<void> {
  const universe = await pool.query<{ n: number }>(
    `select count(*)::int as n from companies where is_russell_3000`,
  );
  const totalR3K = universe.rows[0]!.n;
  console.log(`R3K universe: ${totalR3K} issuers\n`);

  const concepts = [
    "revenue", "net_income", "operating_income", "sbc", "buybacks",
    "cost_of_revenue", "operating_expenses_total", "gross_profit",
    "capex", "depreciation_amortization", "operating_cash_flow",
    "dividends_paid", "interest_expense", "income_tax_expense",
    "cash_latest", "long_term_debt_latest", "shares_outstanding_latest",
    "total_assets_latest", "total_equity_latest",
    "accounts_receivable_latest", "inventory_latest",
    "total_debt_latest", "short_term_debt_latest", "goodwill_latest",
  ];

  const r = await pool.query<{ concept: string; ciks_with_data: number }>(
    `select fm.concept, count(distinct fm.cik)::int as ciks_with_data
     from financial_metrics fm
     join companies c on c.cik = fm.cik
     where c.is_russell_3000 and fm.concept = any($1::text[])
     group by fm.concept`,
    [concepts],
  );
  const byConcept = new Map(r.rows.map((row) => [row.concept, row.ciks_with_data]));

  console.log("R3K coverage by concept:");
  console.log("concept                                ciks    pct");
  for (const c of concepts) {
    const n = byConcept.get(c) ?? 0;
    const pct = ((n / totalR3K) * 100).toFixed(1);
    console.log(`  ${c.padEnd(36)} ${String(n).padStart(5)}  ${pct.padStart(5)}%`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
