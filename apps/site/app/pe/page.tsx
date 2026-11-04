import Link from "next/link";
import type { Metadata } from "next";
import { api } from "@/lib/api";
import { TickerName } from "@/lib/ticker";
import { fmtDate, fmtUsd } from "@/lib/format";

// Scores refresh at most daily; serve a cached render.
export const revalidate = 21600;

export const metadata: Metadata = {
  title: "PE & activist takeover targets",
  description: "Russell 3000 companies ranked by takeover signals a private-equity buyer or activist would look for: cheap, overpaid, diluted or under pressure. From SEC filings, updated daily.",
  alternates: { canonical: "/pe" },
};

interface Row { cik: string; ticker: string; name: string; market_cap?: number; takeover_score?: number; deal_pending?: boolean }
interface Board {
  refreshed_at: string | null;
  max_score: number;
  distribution: { score: number; count: number }[];
  rows: Row[];
}
interface ThirteenD { accession_number: string; filing_date: string; filer_name: string; ticker: string | null; company_name: string }

// Scores at or above this carry the accent color.
const HIGH = 5;

export default async function DevilHome() {
  const [data, feed] = await Promise.all([
    api<Board>("/leaderboard?limit=50&sort=score"),
    api<{ filings: ThirteenD[] }>("/feeds/13d-recent?limit=5&active_only=1"),
  ]);
  const high = data.distribution.filter((d) => d.score >= HIGH).reduce((a, d) => a + d.count, 0);

  return (
    <main className="page">
      <h1 className="sr-only">Which public companies PE buyers and activists are most likely to target</h1>
      <section className="summary" aria-label="Summary">
        <div className="hero">
          <div className="hero-value">{high.toLocaleString("en-US")}</div>
          <div className="hero-label">
            Russell 3000 companies show {HIGH} or more of the {data.max_score} signs a private-equity buyer or activist looks for
          </div>
          {data.refreshed_at && <div className="muted fresh">Updated {fmtDate(data.refreshed_at)}</div>}
        </div>
        <ScoreBars dist={data.distribution} />
      </section>

      {feed.filings.length > 0 && (
        <section className="home-section" aria-labelledby="13d-h">
          <div className="section-head">
            <h2 id="13d-h">Latest activist stakes</h2>
            <Link href="/pe/deals">All deals</Link>
          </div>
          <ul className="rollup-feed">
            {feed.filings.map((f) => (
              <li key={f.accession_number}>
                <span className="date muted">{fmtDate(f.filing_date)}</span>
                <span>{f.filer_name}<span className="muted"> filed a 13D on </span>
                  {f.ticker ? <Link href={`/pe/company/${f.ticker}`}>{f.company_name}</Link> : f.company_name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="home-section" aria-labelledby="board-h">
        <h2 id="board-h">Most takeover signals</h2>
        <div className="table-wrap">
          <table className="data rows-hover">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Company</th>
                <th className="num hide-narrow">Market cap</th>
                <th className="num" title={`Takeover signals fired, out of ${data.max_score}`}>Signals</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={r.cik}>
                  <td className="num muted">{i + 1}</td>
                  <td>
                    <TickerName ticker={r.ticker} name={r.name} base="/pe" />
                    {r.deal_pending && <> <span className="tag" title="Agreed to be acquired in the last 12 months">Deal pending</span></>}
                  </td>
                  <td className="num hide-narrow muted">{fmtUsd(r.market_cap)}</td>
                  <td className="num odds" data-high={(r.takeover_score ?? 0) >= HIGH}>
                    {r.takeover_score ?? 0}<span className="muted"> / {data.max_score}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

// Companies by number of signals fired; HIGH and up carry the accent color.
function ScoreBars({ dist }: { dist: { score: number; count: number }[] }) {
  const top = Math.max(...dist.map((d) => d.count), 1);
  return (
    <figure className="dist">
      <div className="dist-bars" aria-hidden="true">
        {dist.map((d) => (
          <div key={d.score} className="dist-col" title={`${d.score} signals: ${d.count.toLocaleString("en-US")} companies`}>
            <span className="dist-count">{d.count > 0 ? d.count.toLocaleString("en-US") : ""}</span>
            <div className="dist-bar" data-heavy={d.score >= HIGH} style={{ height: `${Math.max((d.count / top) * 100, d.count ? 2 : 0)}%` }} />
            <span className="dist-k">{d.score}</span>
          </div>
        ))}
      </div>
      <figcaption className="muted">Companies by number of takeover signals fired.</figcaption>
      <table className="sr-only">
        <thead><tr><th>Signals</th><th>Companies</th></tr></thead>
        <tbody>{dist.map((d) => <tr key={d.score}><td>{d.score}</td><td>{d.count}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}
