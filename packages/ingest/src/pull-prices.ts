// Pulls daily adjusted close from Yahoo Finance into price_history.
// Adjusted close folds dividends + splits, so this column is the right input
// for total-shareholder-return computations.
//
// Stooq used to be the obvious free source but now requires a captcha-gated
// API key. Yahoo's chart API is unauthenticated and stable.
//
// CLI:
//   tsx src/pull-prices.ts                 # all issuers
//   tsx src/pull-prices.ts ETSY EBAY       # subset
//   tsx src/pull-prices.ts --range=5y      # default 10y

import { pool } from "./db.js";
import { resolveTargets, type IssuerSeed } from "./issuers.js";

interface YahooChartResponse {
  chart: {
    result: {
      timestamp: number[];
      indicators: { adjclose: { adjclose: (number | null)[] }[] };
    }[];
  };
}

async function pullOne(issuer: IssuerSeed, range: string): Promise<void> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${issuer.ticker}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${issuer.ticker}`);
  const data = (await res.json()) as YahooChartResponse;
  const r = data.chart.result[0];
  if (!r) throw new Error(`Yahoo returned no result for ${issuer.ticker}`);
  const ts = r.timestamp;
  const adj = r.indicators.adjclose[0]!.adjclose;

  // Bulk upsert via UNNEST -- much cheaper than 2500 individual inserts.
  const dates: string[] = [];
  const closes: number[] = [];
  for (let i = 0; i < ts.length; i++) {
    const a = adj[i];
    if (a == null) continue;
    dates.push(new Date(ts[i]! * 1000).toISOString().slice(0, 10));
    closes.push(a);
  }

  await pool.query(
    `insert into price_history (ticker, trading_date, adj_close)
     select $1, d::date, c
     from unnest($2::text[], $3::float8[]) as t(d, c)
     on conflict (ticker, trading_date) do update set adj_close = excluded.adj_close`,
    [issuer.ticker, dates, closes],
  );

  console.log(`[${issuer.ticker}] ${dates.length} rows (${dates[0]} -> ${dates[dates.length - 1]})`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const range = argv.find((a) => a.startsWith("--range="))?.split("=")[1] ?? "10y";
  const concurrency = parseInt(argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "1", 10);
  const skipExisting = argv.includes("--skip-existing");
  const tickers = argv.filter((a) => !a.startsWith("--"));
  const all = await resolveTargets(tickers);
  // Single bulk query for skip-existing -- avoids 2.5K+ roundtrips at start.
  let existing = new Set<string>();
  if (skipExisting) {
    const r = await pool.query<{ ticker: string }>(
      `select distinct ticker from price_history`,
    );
    existing = new Set(r.rows.map((row) => row.ticker));
  }
  const targets = all.filter((i) => !existing.has(i.ticker));
  console.log(`pull-prices: ${targets.length} issuer(s), range=${range} concurrency=${concurrency}`);

  let cursor = 0;
  let done = 0;
  let failures = 0;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const issuer = targets[idx]!;
      try {
        await pullOne(issuer, range);
      } catch (e) {
        failures++;
        console.error(`[${issuer.ticker}] FAILED: ${e instanceof Error ? e.message : e}`);
      }
      done++;
      if (done % 50 === 0 || done === targets.length) {
        const secs = (Date.now() - startedAt) / 1000;
        const eta = ((targets.length - done) / done) * secs;
        console.log(`--- progress: ${done}/${targets.length} (${failures} failed) ETA ${(eta/60).toFixed(1)} min ---`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  await pool.end();
}

await main();
