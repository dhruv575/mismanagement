import Link from "next/link";
import { api } from "@/lib/api";
import { TickerName } from "@/lib/ticker";
import { fmtDate, fmtMultiple, fmtUsd, likelihoodPhrase } from "@/lib/format";
import type { SignalGroup } from "@/lib/signals";

// Scores refresh at most daily; serve a cached render.
export const revalidate = 21600;

interface Row {
  cik: string;
  ticker: string;
  name: string;
  sic_description?: string;
  market_cap?: number;
  takeover_score?: number;
  sponsor_prob?: number;
  sponsor_multiple?: number;
  deal_pending?: boolean;
  [signal: string]: unknown;
}
interface Board {
  total: number;
  groups: SignalGroup[];
  max_score: number;
  distribution: { score: number; count: number }[];
  refreshed_at: string | null;
  sponsor_3x: number;
  sponsor: { base_rate: number } | null;
  rows: Row[];
}
interface Deal {
  accession_number: string; ticker: string; name: string; form: string; filing_date: string;
  acquirer: string | null; matched_buyer: string | null; price_per_share: number | null; premium_pct: number | null;
}

const CONFIRMED = new Set(["DEFM14A", "PREM14A", "SC 13E3", "SC TO-T"]);

export default async function Home() {
  const [data, deals] = await Promise.all([
    api<Board>("/leaderboard?limit=100"),
    api<{ rows: Deal[] }>("/deals"),
  ]);
  const latestDeals = dedupeByCompany(deals.rows.filter((d) => CONFIRMED.has(d.form))).slice(0, 4);

  return (
    <main className="page">
      {data.rows.length === 0 ? (
        <>
          <h1>Takeover</h1>
          <p className="empty table-wrap">Scores haven’t been computed yet.</p>
        </>
      ) : (
        <>
          <h1 className="sr-only">Takeover attractiveness for every Russell 3000 company</h1>
          <section className="summary" aria-label="Summary">
            <div className="hero">
              <div className="hero-value">{data.sponsor_3x.toLocaleString("en-US")}</div>
              <div className="hero-label">
                Russell 3000 companies are 3× or more likely than average to be bought by an AI rollup, holdco or private-equity firm
              </div>
              {data.refreshed_at && <div className="muted fresh">Updated {updatedAt(data.refreshed_at)}</div>}
            </div>
          </section>

          {latestDeals.length > 0 && (
            <section className="home-section" aria-labelledby="deals-h">
              <div className="section-head">
                <h2 id="deals-h">Latest deals</h2>
                <Link href="/deals">All deals</Link>
              </div>
              <ul className="deal-cards">
                {latestDeals.map((d) => (
                  <li key={d.accession_number}>
                    <Link href={`/company/${d.ticker}`} className="deal-card">
                      <span className="deal-card-top">
                        <span className="ticker">{d.ticker}</span>
                        <span className="muted">{fmtDate(d.filing_date)}</span>
                      </span>
                      <span className="deal-card-name">{d.name}</span>
                      <span className="deal-card-terms">
                        {d.price_per_share != null ? `$${d.price_per_share.toFixed(2)}` : d.form}
                        {d.premium_pct != null && <span className="deal-premium">{` +${Math.round(d.premium_pct)}%`}</span>}
                      </span>
                      <span className="muted deal-card-by">
                        {d.acquirer ?? d.matched_buyer ?? "Acquirer not named"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="home-section" aria-labelledby="board-h">
            <h2 id="board-h">Most likely AI-rollup targets</h2>
            <div className="table-wrap">
              <table className="data rows-hover">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Company</th>
                    <th className="hide-narrow">Industry</th>
                    <th className="num hide-narrow">Market cap</th>
                    <th className="num" title="How much more likely than the average company to be bought by an AI rollup, holdco or private-equity firm">Likelihood</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => {
                    return (
                      <tr key={r.cik}>
                        <td className="num muted">{i + 1}</td>
                        <td>
                          <TickerName ticker={r.ticker} name={r.name} />
                          {r.deal_pending && <> <span className="tag" title="Agreed to be acquired in the last 12 months">Deal pending</span></>}
                        </td>
                        <td className="hide-narrow muted">{r.sic_description ?? "—"}</td>
                        <td className="num hide-narrow">{fmtUsd(r.market_cap)}</td>
                        <td className="num odds" data-high={(r.sponsor_multiple ?? 0) >= 3}
                          title={r.sponsor_multiple != null ? likelihoodPhrase(r.sponsor_multiple) : undefined}>
                          {fmtMultiple(r.sponsor_multiple)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function dedupeByCompany(rows: Deal[]): Deal[] {
  const seen = new Set<string>();
  return rows.filter((d) => (seen.has(d.ticker) ? false : (seen.add(d.ticker), true)));
}

// Absolute, not "5 min ago": the page itself is cached for hours.
function updatedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short",
  });
}
