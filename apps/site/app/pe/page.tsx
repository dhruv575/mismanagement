import Link from "next/link";
import type { Metadata } from "next";
import { api } from "@/lib/api";
import { TickerName } from "@/lib/ticker";
import { fmtDate, fmtMultiple, fmtUsd, likelihoodPhrase } from "@/lib/format";

// Scores refresh at most daily; serve a cached render.
export const revalidate = 21600;

export const metadata: Metadata = {
  title: "PE & activist takeover targets",
  description: "Russell 3000 companies ranked by how likely a private-equity firm is to buy them, with the takeover signals an activist would look for. From SEC filings, updated daily.",
  alternates: { canonical: "/pe" },
};

interface Row { cik: string; ticker: string; name: string; market_cap?: number; takeover_score?: number; pe_multiple?: number; deal_pending?: boolean }
interface Band { label: string; min: number; count: number }
interface Board {
  refreshed_at: string | null;
  max_score: number;
  distribution: { score: number; count: number }[];
  pe_likelihood: Band[];
  rows: Row[];
}
interface ThirteenD { accession_number: string; filing_date: string; filer_name: string; ticker: string | null; company_name: string }

export default async function DevilHome() {
  const [data, feed] = await Promise.all([
    api<Board>("/leaderboard?limit=50&sort=pe"),
    api<{ filings: ThirteenD[] }>("/feeds/13d-recent?limit=5&active_only=1"),
  ]);
  const high = data.pe_likelihood.filter((b) => b.min >= 3).reduce((a, b) => a + b.count, 0);

  return (
    <main className="page">
      <h1 className="sr-only">Which public companies PE buyers and activists are most likely to target</h1>
      <section className="summary" aria-label="Summary">
        <div className="hero">
          <div className="hero-value">{high.toLocaleString("en-US")}</div>
          <div className="hero-label">
            Russell 3000 companies are 3× or more likely than average to be bought by a private-equity firm
          </div>
          {data.refreshed_at && <div className="muted fresh">Updated {fmtDate(data.refreshed_at)}</div>}
        </div>
        <Bands bands={data.pe_likelihood} />
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
        <h2 id="board-h">Most likely to be taken private</h2>
        <div className="table-wrap">
          <table className="data rows-hover">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Company</th>
                <th className="num hide-narrow">Market cap</th>
                <th className="num hide-narrow" title={`Takeover signals fired, out of ${data.max_score}`}>Signals</th>
                <th className="num" title="How much more likely than the average company to be bought by a private-equity firm">Likelihood</th>
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
                  <td className="num hide-narrow muted">{r.takeover_score ?? 0} / {data.max_score}</td>
                  <td className="num odds" data-high={(r.pe_multiple ?? 0) >= 3}
                    title={r.pe_multiple != null ? likelihoodPhrase(r.pe_multiple) : undefined}>{fmtMultiple(r.pe_multiple)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

// Companies by PE-buyout likelihood band; only above-average bands are
// drawn so the tail stays visible, 3x and up carry the accent color.
function Bands({ bands: all }: { bands: Band[] }) {
  const below = all.filter((b) => b.min < 1).reduce((a, b) => a + b.count, 0);
  const bands = all.filter((b) => b.min >= 1);
  const top = Math.max(...bands.map((b) => b.count), 1);
  return (
    <figure className="dist">
      <div className="dist-bars" aria-hidden="true">
        {bands.map((b) => (
          <div key={b.label} className="dist-col" title={`${b.label} as likely as average: ${b.count.toLocaleString("en-US")} companies`}>
            <span className="dist-count">{b.count > 0 ? b.count.toLocaleString("en-US") : ""}</span>
            <div className="dist-bar" data-heavy={b.min >= 3} style={{ height: `${Math.max((b.count / top) * 100, b.count ? 2 : 0)}%` }} />
            <span className="dist-k">{b.label}</span>
          </div>
        ))}
      </div>
      <figcaption className="muted">Above-average companies by how much more likely they are to be taken private. {below.toLocaleString("en-US")} more are below average.</figcaption>
      <table className="sr-only">
        <thead><tr><th>Likelihood vs. average</th><th>Companies</th></tr></thead>
        <tbody>{bands.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td></tr>)}<tr><td>Below 1×</td><td>{below}</td></tr></tbody>
      </table>
    </figure>
  );
}
