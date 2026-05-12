// Computes the Stage 1 quant screen against persisted financial_metrics +
// price_history, prints a per-issuer report.
//
// The computations here are deliberately neutral facts: revenue CAGR, opex
// ratio, TSR, etc. Comparisons (peer percentile, vs index) are also fine --
// the line is between presenting a delta and characterizing it. There are
// no "red flag" tags or activist verdicts.
//
// Run after `pnpm migrate && pnpm pull-edgar && pnpm pull-prices`.
//
// CLI:
//   tsx src/screen.ts                # all issuers
//   tsx src/screen.ts ETSY EBAY      # subset

import { pool } from "./db.js";
import { resolveTargets, type IssuerSeed } from "./issuers.js";

interface MetricRow {
  fiscal_year: number;
  concept: string;
  value: number;
  unit: string;
}

async function pullMetrics(cik: string): Promise<Map<string, Map<number, number>>> {
  const r = await pool.query<MetricRow>(
    `select fiscal_year, concept, value, unit
     from financial_metrics
     where cik = $1
     order by concept, fiscal_year`,
    [cik],
  );
  const out = new Map<string, Map<number, number>>();
  for (const row of r.rows) {
    let series = out.get(row.concept);
    if (!series) {
      series = new Map();
      out.set(row.concept, series);
    }
    series.set(row.fiscal_year, row.value);
  }
  return out;
}

async function pullPrices(ticker: string): Promise<{ date: string; close: number }[]> {
  const r = await pool.query<{ trading_date: string; adj_close: number }>(
    `select trading_date::text, adj_close from price_history
     where ticker = $1 order by trading_date`,
    [ticker],
  );
  return r.rows.map((row) => ({ date: row.trading_date, close: row.adj_close }));
}

function tsr(series: { date: string; close: number }[], years: number): number | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1]!;
  const targetIso = new Date(last.date);
  targetIso.setFullYear(targetIso.getFullYear() - years);
  const target = targetIso.toISOString().slice(0, 10);
  const start = series.find((p) => p.date >= target);
  if (!start) return null;
  return last.close / start.close - 1;
}

function cagr(series: Map<number, number>, years: number): number | null {
  const yrs = [...series.keys()].sort((a, b) => a - b);
  if (yrs.length === 0) return null;
  const endY = yrs[yrs.length - 1]!;
  const startY = endY - years;
  const start = series.get(startY);
  const end = series.get(endY);
  if (start == null || end == null || start <= 0) return null;
  return Math.pow(end / start, 1 / years) - 1;
}

function fmt(x: number | null | undefined, kind: "money" | "pct" | "ratio"): string {
  if (x == null) return "—";
  if (kind === "pct") return `${(x * 100).toFixed(1)}%`;
  if (kind === "ratio") return x.toFixed(2);
  if (Math.abs(x) >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (Math.abs(x) >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  return `$${x.toLocaleString()}`;
}

async function screenOne(issuer: IssuerSeed): Promise<void> {
  const metrics = await pullMetrics(issuer.cik);
  const prices = await pullPrices(issuer.ticker);

  const rev = metrics.get("revenue") ?? new Map();
  const opEx = (year: number): number | null => {
    const sm = metrics.get("selling_marketing")?.get(year);
    const rd = metrics.get("research_development")?.get(year);
    const ga = metrics.get("general_administrative")?.get(year);
    if (sm == null && rd == null && ga == null) return null;
    return (sm ?? 0) + (rd ?? 0) + (ga ?? 0);
  };

  const sh = metrics.get("shares_outstanding_latest")?.get(-1) ?? null;
  const cash = metrics.get("cash_latest")?.get(-1) ?? null;
  const debt = metrics.get("long_term_debt_latest")?.get(-1) ?? null;
  const lastPrice = prices[prices.length - 1];
  const mcap = sh != null && lastPrice ? sh * lastPrice.close : null;

  const years = [...rev.keys()].sort((a, b) => a - b).slice(-4);

  console.log("=".repeat(70));
  console.log(`${issuer.ticker} -- CIK ${issuer.cik}`);
  console.log("=".repeat(70));

  console.log("Revenue (last 4 FY):");
  for (const y of years) {
    console.log(`  FY${y}: ${fmt(rev.get(y) ?? null, "money")}`);
  }
  console.log(`  3y CAGR: ${fmt(cagr(rev, 3), "pct")}   5y CAGR: ${fmt(cagr(rev, 5), "pct")}`);

  console.log("\nOpex / revenue (last 4 FY):");
  for (const y of years) {
    const total = opEx(y);
    const r = rev.get(y);
    const ratio = total != null && r != null && r > 0 ? total / r : null;
    console.log(`  FY${y}: opex ${fmt(total, "money")}  rev ${fmt(r ?? null, "money")}  ratio ${fmt(ratio, "pct")}`);
  }

  console.log("\nProfitability (last 4 FY):");
  for (const y of years) {
    const ni = metrics.get("net_income")?.get(y) ?? null;
    const op = metrics.get("operating_income")?.get(y) ?? null;
    const r = rev.get(y);
    const margin = op != null && r != null && r > 0 ? op / r : null;
    console.log(`  FY${y}: NI ${fmt(ni, "money")}  OpInc ${fmt(op, "money")}  OpMargin ${fmt(margin, "pct")}`);
  }

  const sbcSeries = metrics.get("sbc") ?? new Map();
  if (sbcSeries.size > 0) {
    console.log("\nStock-based compensation (last 4 FY):");
    for (const y of years) {
      const v = sbcSeries.get(y);
      const r = rev.get(y);
      const pct = v != null && r != null && r > 0 ? v / r : null;
      console.log(`  FY${y}: ${fmt(v ?? null, "money")}  ${fmt(pct, "pct")} of revenue`);
    }
  }

  const bb = metrics.get("buybacks") ?? new Map();
  if (bb.size > 0) {
    console.log("\nBuybacks (last 4 FY):");
    for (const y of years) console.log(`  FY${y}: ${fmt(bb.get(y) ?? null, "money")}`);
  }

  console.log("\nBalance sheet & market cap:");
  console.log(`  Cash: ${fmt(cash, "money")}   LT debt: ${fmt(debt, "money")}`);
  if (sh) console.log(`  Shares: ${(sh / 1e6).toFixed(1)}M`);
  if (lastPrice) {
    console.log(`  Price ${lastPrice.date}: $${lastPrice.close.toFixed(2)}   Market cap: ${fmt(mcap, "money")}`);
  }

  console.log("\nTSR (price + dividends, via adj close):");
  console.log(`  1y: ${fmt(tsr(prices, 1), "pct")}   3y: ${fmt(tsr(prices, 3), "pct")}   5y: ${fmt(tsr(prices, 5), "pct")}`);
  console.log("");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targets = await resolveTargets(argv);
  for (const issuer of targets) {
    try {
      await screenOne(issuer);
    } catch (e) {
      console.error(`[${issuer.ticker}] FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }
  await pool.end();
}

await main();
