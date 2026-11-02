// Builds the screening universe in the `companies` table:
//
//   1. Fetches SEC EDGAR's company_tickers.json -- the canonical
//      ticker->CIK->name map for every SEC-registered filer (~10K entries).
//   2. Fetches iShares' IWV ETF holdings CSV -- the public source-of-truth
//      for current Russell 3000 constituents (~2600 equity holdings).
//   3. Joins the two on ticker, upserts companies with is_russell_3000=true
//      for the R3K subset and is_russell_3000=false (default) otherwise.
//
// We persist *every* SEC ticker, not just R3K, so the table can support
// non-screen workflows later (e.g. tracking a non-R3K name an activist files
// a 13D on). The R3K flag is the screening default.
//
// CLI:
//   tsx src/pull-universe.ts            # full refresh
//   tsx src/pull-universe.ts --r3k-only # only persist R3K tickers (smaller)

import { pool } from "./db.js";
import { EDGAR_USER_AGENT } from "./env.js";

interface SecTicker {
  cik_str: number;
  ticker: string;
  title: string;
}

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

// iShares' link to the IWV holdings CSV (the "holdings-csv-link" anchor on
// https://www.ishares.com/us/products/239714/ishares-russell-3000-etf).
// The older `<token>.ajax?fileType=csv` URL now returns the HTML page.
const IWV_HOLDINGS_URL =
  "https://www.ishares.com/us/products/239714/ishares-russell-3000-etf/latest-holdings.csv";

async function fetchSecTickers(): Promise<Map<string, SecTicker>> {
  const res = await fetch(SEC_TICKERS_URL, {
    headers: { "User-Agent": EDGAR_USER_AGENT, "Accept-Encoding": "identity" },
  });
  if (!res.ok) throw new Error(`company_tickers.json: ${res.status}`);
  const data = (await res.json()) as Record<string, SecTicker>;
  // Index by uppercase ticker; SEC tickers can have classes like "BRK.B"
  // or share-class suffixes that iShares writes as "BRK B" -- we normalize
  // both sides during the join.
  const out = new Map<string, SecTicker>();
  for (const v of Object.values(data)) out.set(normalizeTicker(v.ticker), v);
  return out;
}

function normalizeTicker(t: string): string {
  return t.toUpperCase().replace(/[\s.\-]/g, "");
}

async function fetchIwvHoldings(): Promise<{ ticker: string; name: string; weight: number; price: number; quantity: number }[]> {
  const res = await fetch(IWV_HOLDINGS_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`IWV holdings: ${res.status}`);
  const text = (await res.text()).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);

  // The CSV has a 9-line preamble (fund metadata, blank line, then header).
  // We locate the actual header row by scanning for "Ticker,Name,Sector,...".
  const headerIdx = lines.findIndex((l) => l.startsWith("Ticker,Name,"));
  if (headerIdx < 0) throw new Error("IWV CSV header row not found");

  const out: { ticker: string; name: string; weight: number; price: number; quantity: number }[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i]!);
    if (cells.length < 4) continue;
    const [ticker, name, , assetClass, , weightStr, , quantityStr, priceStr] = cells;
    if (assetClass !== "Equity") continue;
    if (!ticker || ticker === "-") continue;
    out.push({
      ticker: ticker.trim(),
      name: (name ?? "").trim(),
      weight: parseFloat((weightStr ?? "0").replace(/,/g, "")) || 0,
      price: parseFloat((priceStr ?? "0").replace(/,/g, "")) || 0,
      quantity: parseFloat((quantityStr ?? "0").replace(/,/g, "")) || 0,
    });
  }
  return out;
}

// Minimal CSV row parser -- handles quoted fields with embedded commas. The
// iShares format uses RFC 4180-style quoting (double-quote to escape inner
// quotes). We don't need a general CSV library for two-character escapes.
function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const r3kOnly = argv.includes("--r3k-only");

  console.log("Fetching SEC company_tickers.json…");
  const secByTicker = await fetchSecTickers();
  console.log(`  ${secByTicker.size} SEC-registered tickers`);

  console.log("Fetching iShares IWV holdings…");
  const iwv = await fetchIwvHoldings();
  console.log(`  ${iwv.length} equity holdings in IWV`);

  // Normalize iShares tickers and look up CIKs. iShares uses spaces/hyphens
  // for share classes ("BRK B"); SEC normalizes to dots ("BRK.B"). Both
  // collapse to the same key after normalizeTicker().
  let matched = 0;
  let missing: string[] = [];
  const r3kCiks = new Set<string>();
  const r3kMeta = new Map<string, { ticker: string; name: string; price: number; quantity: number }>();

  for (const h of iwv) {
    const sec = secByTicker.get(normalizeTicker(h.ticker));
    if (!sec) {
      missing.push(h.ticker);
      continue;
    }
    const cik = String(sec.cik_str).padStart(10, "0");
    r3kCiks.add(cik);
    r3kMeta.set(cik, { ticker: sec.ticker, name: sec.title, price: h.price, quantity: h.quantity });
    matched++;
  }
  console.log(`  matched ${matched} R3K -> CIK; ${missing.length} unmatched (foreign / share-class quirks)`);
  if (missing.length > 0 && missing.length < 30) {
    console.log(`  unmatched tickers: ${missing.slice(0, 30).join(", ")}`);
  }

  // Upsert. Three modes per row:
  //   - In R3K: is_russell_3000 = true, market_cap_at_universe_pull = price * quantity * issuer-IWV-share, universe_pulled_at = now
  //   - Outside R3K but in SEC: is_russell_3000 = false (only insert if --r3k-only is off)
  // For market cap we use price * (issuer total shares outstanding), but the
  // CSV gives us price * quantity which is the IWV's *holding* not the
  // company's full market cap. We persist the indicative value and let the
  // screen.ts layer compute proper market cap from price_history * shares
  // outstanding pulled separately.
  let inserted = 0;
  for (const [cik, meta] of r3kMeta) {
    await pool.query(
      `insert into companies (cik, ticker, name, is_russell_3000, universe_pulled_at, updated_at)
       values ($1, $2, $3, true, now(), now())
       on conflict (cik) do update set
         ticker = excluded.ticker,
         name = excluded.name,
         is_russell_3000 = true,
         universe_pulled_at = now(),
         updated_at = now()`,
      [cik, meta.ticker.toUpperCase(), meta.name],
    );
    inserted++;
  }
  console.log(`Upserted ${inserted} R3K companies`);

  if (!r3kOnly) {
    let nonR3kInserted = 0;
    for (const sec of secByTicker.values()) {
      const cik = String(sec.cik_str).padStart(10, "0");
      if (r3kCiks.has(cik)) continue;
      await pool.query(
        `insert into companies (cik, ticker, name, is_russell_3000, updated_at)
         values ($1, $2, $3, false, now())
         on conflict (cik) do update set
           ticker = excluded.ticker,
           name = excluded.name,
           updated_at = now()`,
        [cik, sec.ticker.toUpperCase(), sec.title],
      );
      nonR3kInserted++;
    }
    console.log(`Upserted ${nonR3kInserted} non-R3K SEC-registered companies`);
  }

  await pool.end();
}

await main();
