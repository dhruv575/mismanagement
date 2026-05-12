// Issuer lookups. Source-of-truth is the `companies` table, populated by
// pull-universe.ts from SEC company_tickers + iShares IWV holdings. The
// hand-curated SEED_ISSUERS list below is just for first-run smoke tests
// before pull-universe.ts has been run -- prefer DB queries elsewhere.

import { pool } from "./db.js";

export interface IssuerSeed {
  ticker: string;
  cik: string;
  name: string;
}

export const SEED_ISSUERS: IssuerSeed[] = [
  { ticker: "ETSY", cik: "0001370637", name: "Etsy, Inc." },
  { ticker: "EBAY", cik: "0001065088", name: "eBay Inc." },
  { ticker: "PINS", cik: "0001506293", name: "Pinterest, Inc." },
  { ticker: "W", cik: "0001616707", name: "Wayfair Inc." },
  { ticker: "YELP", cik: "0001345016", name: "Yelp Inc." },
  { ticker: "TRIP", cik: "0001526520", name: "Tripadvisor, Inc." },
  { ticker: "MTCH", cik: "0000891103", name: "Match Group, Inc." },
];

/** Looks up tickers from the `companies` table. Falls back to SEED_ISSUERS
 *  if the table is empty (first-run case before pull-universe.ts).         */
export async function findIssuers(tickers: string[]): Promise<IssuerSeed[]> {
  const upper = tickers.map((t) => t.toUpperCase());
  const r = await pool.query<{ ticker: string; cik: string; name: string }>(
    `select ticker, cik, name from companies where ticker = any($1)`,
    [upper],
  );
  if (r.rows.length === upper.length) return r.rows;

  // Some tickers weren't in the table -- fall back to seed for those.
  const found = new Set(r.rows.map((row) => row.ticker));
  const fallback = upper
    .filter((t) => !found.has(t))
    .map((t) => SEED_ISSUERS.find((s) => s.ticker === t))
    .filter((s): s is IssuerSeed => s !== undefined);
  if (r.rows.length + fallback.length !== upper.length) {
    const missing = upper.filter(
      (t) => !found.has(t) && !SEED_ISSUERS.some((s) => s.ticker === t),
    );
    throw new Error(`Unknown ticker(s): ${missing.join(", ")}. Run pull-universe first?`);
  }
  return [...r.rows, ...fallback];
}

/** All R3K issuers, in ticker order. Used as the default scope for ingest
 *  scripts that didn't get explicit ticker args.                            */
export async function allR3kIssuers(): Promise<IssuerSeed[]> {
  const r = await pool.query<{ ticker: string; cik: string; name: string }>(
    `select ticker, cik, name from companies where is_russell_3000 = true order by ticker`,
  );
  if (r.rows.length === 0) {
    console.warn("No R3K issuers in companies table -- falling back to SEED_ISSUERS. Run pull-universe.ts first.");
    return SEED_ISSUERS;
  }
  return r.rows;
}

/** Resolves a CLI ticker list (or empty -> R3K default). */
export async function resolveTargets(argvTickers: string[]): Promise<IssuerSeed[]> {
  if (argvTickers.length > 0) return findIssuers(argvTickers);
  return allR3kIssuers();
}
