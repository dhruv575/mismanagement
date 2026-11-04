import Link from "next/link";
import { api } from "@/lib/api";
import { TickerName } from "@/lib/ticker";
import { fmtDate, fmtMultiple, fmtUsd, likelihoodPhrase } from "@/lib/format";

// Scores refresh at most daily; serve a cached render.
export const revalidate = 21600;

interface Row {
  cik: string;
  ticker: string;
  name: string;
  market_cap?: number;
  sponsor_multiple?: number;
  deal_pending?: boolean;
}
interface Band { label: string; min: number; count: number }
interface Board {
  total: number;
  refreshed_at: string | null;
  sponsor_3x: number;
  likelihood: Band[];
  rows: Row[];
}
interface RollupDeal { buyer: string; buyer_slug: string; target: string; announced: string; ticker?: string }

// Bands at or above this multiple carry the accent color.
const HIGH = 3;

export default async function Home() {
  const [data, rollups] = await Promise.all([
    api<Board>("/leaderboard?limit=50"),
    api<{ deals: RollupDeal[] }>("/rollups"),
  ]);
  const latest = rollups.deals.slice(0, 5);

  return (
    <main className="page">
      {data.rows.length === 0 ? (
        <>
          <h1>Takeover</h1>
          <p className="empty table-wrap">Scores haven’t been computed yet.</p>
        </>
      ) : (
        <>
          <h1 className="sr-only">Which public companies AI rollups are most likely to buy</h1>
          <section className="summary" aria-label="Summary">
            <div className="hero">
              <div className="hero-value">{data.sponsor_3x.toLocaleString("en-US")}</div>
              <div className="hero-label">
                Russell 3000 companies are 3× or more likely than average to be bought by an AI rollup, holdco or private-equity firm
              </div>
              {data.refreshed_at && <div className="muted fresh">Updated {updatedAt(data.refreshed_at)}</div>}
            </div>
            <Bands bands={data.likelihood} />
          </section>

          {latest.length > 0 && (
            <section className="home-section" aria-labelledby="rollups-h">
              <div className="section-head">
                <h2 id="rollups-h">Latest AI-rollup deals</h2>
                <Link href="/rollups">All deals</Link>
              </div>
              <ul className="rollup-feed">
                {latest.map((d) => (
                  <li key={`${d.buyer_slug}:${d.target}`}>
                    <span className="date muted">{fmtDate(d.announced)}</span>
                    <span><Link href={`/rollups?buyer=${d.buyer_slug}`}>{d.buyer}</Link>
                      <span className="muted"> bought </span>
                      {d.ticker ? <Link href={`/company/${d.ticker}`}>{d.target}</Link> : d.target}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="home-section" aria-labelledby="board-h">
            <h2 id="board-h">Most likely to be bought next</h2>
            <div className="table-wrap">
              <table className="data rows-hover">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Company</th>
                    <th className="num hide-narrow">Market cap</th>
                    <th className="num" title="How much more likely than the average company to be bought by an AI rollup, holdco or private-equity firm">Likelihood</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={r.cik}>
                      <td className="num muted">{i + 1}</td>
                      <td>
                        <TickerName ticker={r.ticker} name={r.name} />
                        {r.deal_pending && <> <span className="tag" title="Agreed to be acquired in the last 12 months">Deal pending</span></>}
                      </td>
                      <td className="num hide-narrow muted">{fmtUsd(r.market_cap)}</td>
                      <td className="num odds" data-high={(r.sponsor_multiple ?? 0) >= HIGH}
                        title={r.sponsor_multiple != null ? likelihoodPhrase(r.sponsor_multiple) : undefined}>
                        {fmtMultiple(r.sponsor_multiple)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

// Companies by likelihood band. One series; bands at 3× and up carry the
// accent color. Every bar has a hover title, and a table carries the values
// for screen readers.
function Bands({ bands: all }: { bands: Band[] }) {
  // Most companies sit below average; charting them would flatten the tail
  // that matters, so they get a number in the caption instead.
  const below = all.filter((b) => b.min < 1).reduce((a, b) => a + b.count, 0);
  const bands = all.filter((b) => b.min >= 1);
  const top = Math.max(...bands.map((b) => b.count), 1);
  return (
    <figure className="dist">
      <div className="dist-bars" aria-hidden="true">
        {bands.map((b) => (
          <div key={b.label} className="dist-col" title={`${b.label} as likely as average: ${b.count.toLocaleString("en-US")} companies`}>
            <span className="dist-count">{b.count > 0 ? b.count.toLocaleString("en-US") : ""}</span>
            <div className="dist-bar" data-heavy={b.min >= HIGH} style={{ height: `${Math.max((b.count / top) * 100, b.count ? 2 : 0)}%` }} />
            <span className="dist-k">{b.label}</span>
          </div>
        ))}
      </div>
      <figcaption className="muted">Above-average companies by how much more likely they are to be bought by an AI rollup. {below.toLocaleString("en-US")} more are below average.</figcaption>
      <table className="sr-only">
        <thead><tr><th>Likelihood vs. average</th><th>Companies</th></tr></thead>
        <tbody>{bands.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td></tr>)}<tr><td>Below 1×</td><td>{below}</td></tr></tbody>
      </table>
    </figure>
  );
}

// Absolute, not "5 min ago": the page itself is cached for hours.
function updatedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short",
  });
}
