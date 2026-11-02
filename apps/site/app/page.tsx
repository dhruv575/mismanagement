import Link from "next/link";
import { api } from "@/lib/api";
import { TickerName } from "@/lib/ticker";
import { fmtDate, fmtUsd } from "@/lib/format";
import { FLAG_LABELS } from "@/lib/flags";

// Scores refresh at most daily; serve a cached render.
export const revalidate = 21600;

interface Row {
  cik: string;
  ticker: string;
  name: string;
  sic_description?: string;
  market_cap?: number;
  [flag: `flag_${string}`]: boolean | undefined;
}
interface Board {
  total: number;
  flags: string[];
  distribution: { flags_fired: number; count: number }[];
  refreshed_at: string | null;
  rows: Row[];
}
interface Deal {
  accession_number: string; ticker: string; name: string; form: string; filing_date: string;
  acquirer: string | null; matched_buyer: string | null; price_per_share: number | null; premium_pct: number | null;
}

const CONFIRMED = new Set(["DEFM14A", "PREM14A", "SC 13E3", "SC TO-T"]);
const HEAVY = 3;

export default async function Leaderboard() {
  const [data, deals] = await Promise.all([
    api<Board>("/mismanagement?limit=100"),
    api<{ rows: Deal[] }>("/deals"),
  ]);
  const heavy = data.distribution.filter((d) => d.flags_fired >= HEAVY).reduce((a, d) => a + d.count, 0);
  const latestDeals = dedupeByCompany(deals.rows.filter((d) => CONFIRMED.has(d.form))).slice(0, 4);

  return (
    <main className="page">
      {data.rows.length === 0 ? (
        <>
          <h1>Leaderboard</h1>
          <p className="empty table-wrap">Scores haven’t been computed yet.</p>
        </>
      ) : (
        <>
          <section className="summary" aria-label="Summary">
            <div className="hero">
              <div className="hero-value">{heavy.toLocaleString("en-US")}</div>
              <div className="hero-label">
                of {data.total.toLocaleString("en-US")} Russell 3000 companies fire {HEAVY} or more red flags
              </div>
              {data.refreshed_at && <div className="muted fresh">Updated {updatedAt(data.refreshed_at)}</div>}
            </div>
            <Distribution dist={data.distribution} max={data.flags.length} />
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
                        {d.premium_pct != null && <span className="deal-premium">{` +${d.premium_pct}%`}</span>}
                      </span>
                      <span className="muted deal-card-by">
                        {d.acquirer ?? d.matched_buyer ?? "Acquirer not parsed"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="home-section" aria-labelledby="board-h">
            <h2 id="board-h">Most flagged</h2>
            <div className="table-wrap">
              <table className="data rows-hover">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Company</th>
                    <th className="hide-narrow">Industry</th>
                    <th className="num hide-narrow">Market cap</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => {
                    const fired = data.flags.filter((f) => r[`flag_${f}`]);
                    return (
                      <tr key={r.cik}>
                        <td className="num muted">{i + 1}</td>
                        <td>
                          <TickerName ticker={r.ticker} name={r.name} />
                        </td>
                        <td className="hide-narrow muted">{r.sic_description ?? "—"}</td>
                        <td className="num hide-narrow">{fmtUsd(r.market_cap)}</td>
                        <td>
                          <span className="flags hide-narrow" aria-hidden="true">
                            {data.flags.map((f) => (
                              <span key={f} className="flag" data-fired={fired.includes(f)} title={FLAG_LABELS[f]} />
                            ))}
                          </span>{" "}
                          <span className="num flag-count" data-n={fired.length}>{fired.length}</span>
                          <span className="sr-only">: {fired.map((f) => FLAG_LABELS[f]).join(", ")}</span>
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

// Companies by number of flags fired. Single series; bars past the "heavy"
// line carry the negative tone, and every bar has a hover title + SR table.
function Distribution({ dist, max }: { dist: Board["distribution"]; max: number }) {
  const counts = Array.from({ length: max + 1 }, (_, k) => dist.find((d) => d.flags_fired === k)?.count ?? 0);
  const top = Math.max(...counts, 1);
  return (
    <figure className="dist">
      <div className="dist-bars" aria-hidden="true">
        {counts.map((c, k) => (
          <div key={k} className="dist-col" title={`${k} flag${k === 1 ? "" : "s"}: ${c.toLocaleString("en-US")} companies`}>
            <span className="dist-count">{c > 0 ? c.toLocaleString("en-US") : ""}</span>
            <div className="dist-bar" data-heavy={k >= HEAVY} style={{ height: `${Math.max((c / top) * 100, c ? 2 : 0)}%` }} />
            <span className="dist-k">{k}</span>
          </div>
        ))}
      </div>
      <figcaption className="muted">Companies by number of flags fired</figcaption>
      <table className="sr-only">
        <thead><tr><th>Flags fired</th><th>Companies</th></tr></thead>
        <tbody>{counts.map((c, k) => <tr key={k}><td>{k}</td><td>{c}</td></tr>)}</tbody>
      </table>
    </figure>
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
