import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchCompHighest, fetchCompPayGap, fetchCompPayRatio,
  type CompHighestRow, type CompPayGapRow, type CompPayRatioRow,
} from "../api.js";
import { fmtUsd, fmtUsdCompact } from "../lib/format.js";

// Three leaderboards over the (extracted) DEF 14A corpus:
//
//  1. Highest named-executive total comp (latest fiscal year per issuer)
//  2. Biggest gap between PEO "comp actually paid" (Dodd-Frank PvP) and
//     PEO "total comp" (Summary Compensation Table). Both directions are
//     interesting — paid > total means PvP markups (equity vesting up);
//     paid < total means markdowns (equity vesting down).
//  3. Highest CEO/median-employee pay ratio (Dodd-Frank §953(b))
//
// All three are sparse until extract-proxy has run universe-wide.

export function CompPage() {
  const [q, setQ] = useState("");
  return (
    <div className="comp-page">
      <header className="activity-head">
        <h1 className="activity-title">Compensation outliers</h1>
        <p className="activity-sub">
          Three views over the corpus, all from DEF 14A proxy statements.
          Search filters every table below by ticker or company name.
        </p>
        <input
          type="search"
          className="comp-search"
          placeholder="Search ticker or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
      </header>

      <HighestBoard q={q} />
      <PayGapBoard q={q} />
      <PayRatioBoard q={q} />
    </div>
  );
}

function matches(q: string, ticker: string, name: string): boolean {
  if (!q.trim()) return true;
  const needle = q.trim().toLowerCase();
  return ticker.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
}

function HighestBoard({ q }: { q: string }) {
  const [rows, setRows] = useState<(CompHighestRow & { _rank: number })[] | null>(null);
  useEffect(() => {
    // Pull a deeper slice so client-side search has something to filter
    // through. Each row carries its canonical universe rank (position in
    // the unfiltered list) so search doesn't renumber the leaderboard.
    fetchCompHighest(3000)
      .then((r) => setRows(r.rows.map((row, i) => ({ ...row, _rank: i + 1 }))))
      .catch(() => setRows([]));
  }, []);
  const filtered = (rows ?? []).filter((r) => matches(q, r.ticker, r.company_name)).slice(0, 10);
  return (
    <section className="section">
      <h2 className="section-title">Highest named-executive total comp</h2>
      <SparseHint when={rows?.length === 0} />
      {rows == null ? <div className="loading-state">Loading…</div> : rows.length === 0 ? null : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Ticker</th>
              <th className="comp-col-mobile-hide">Company</th>
              <th>Executive</th>
              <th className="comp-col-mobile-hide">Title</th>
              <th className="numeric comp-col-mobile-hide">FY</th>
              <th className="numeric">Total</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={`${r.ticker}-${r._rank}`}>
                <td className="screen-sector">{r._rank}</td>
                <td><Link to={`/company/${r.ticker}`} className="screen-ticker">{r.ticker}</Link></td>
                <td className="comp-col-mobile-hide">{r.company_name}</td>
                <td><strong>{r.executive_name}</strong></td>
                <td className="screen-sector comp-col-mobile-hide">{r.title}</td>
                <td className="numeric comp-col-mobile-hide">{r.fiscal_year}</td>
                <td className="numeric">{fmtUsd(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PayGapBoard({ q }: { q: string }) {
  const [rows, setRows] = useState<(CompPayGapRow & { _rank: number })[] | null>(null);
  useEffect(() => {
    fetchCompPayGap(3000)
      .then((r) => setRows(r.rows.map((row, i) => ({ ...row, _rank: i + 1 }))))
      .catch(() => setRows([]));
  }, []);
  const filtered = (rows ?? []).filter((r) => matches(q, r.ticker, r.company_name)).slice(0, 10);
  return (
    <section className="section">
      <h2 className="section-title">Reported vs realized CEO pay</h2>
      <p className="screen-sub" style={{ marginBottom: 14, maxWidth: 720 }}>
        The Summary Compensation Table reports the value of stock and option
        grants on the day they were awarded. The Pay-vs-Performance table
        (mandatory since 2022) re-values those same grants based on what the
        stock actually did over the year. A positive gap means the CEO's
        equity rode the stock up after the grant; a negative gap means the
        stock fell and the CEO took the loss too.
      </p>
      <SparseHint when={rows?.length === 0} />
      {rows == null ? <div className="loading-state">Loading…</div> : rows.length === 0 ? null : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th className="comp-col-mobile-hide">Company</th>
              <th className="numeric comp-col-mobile-hide">FY</th>
              <th className="numeric">Total comp</th>
              <th className="numeric">Comp paid</th>
              <th className="numeric">Gap</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.ticker}>
                <td><Link to={`/company/${r.ticker}`} className="screen-ticker">{r.ticker}</Link></td>
                <td className="comp-col-mobile-hide">{r.company_name}</td>
                <td className="numeric comp-col-mobile-hide">{r.fiscal_year}</td>
                <td className="numeric">{fmtUsdCompact(r.peo_total_comp)}</td>
                <td className="numeric">{fmtUsdCompact(r.peo_compensation_actually_paid)}</td>
                <td className="numeric">
                  <span className={r.gap >= 0 ? "pos" : "neg"}>
                    {r.gap >= 0 ? "+" : "−"}{fmtUsdCompact(Math.abs(r.gap))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PayRatioBoard({ q }: { q: string }) {
  const [rows, setRows] = useState<(CompPayRatioRow & { _rank: number })[] | null>(null);
  useEffect(() => {
    fetchCompPayRatio(3000)
      .then((r) => setRows(r.rows.map((row, i) => ({ ...row, _rank: i + 1 }))))
      .catch(() => setRows([]));
  }, []);
  const filtered = (rows ?? []).filter((r) => matches(q, r.ticker, r.company_name)).slice(0, 10);
  return (
    <section className="section">
      <h2 className="section-title">Highest CEO / median-employee pay ratio</h2>
      <SparseHint when={rows?.length === 0} />
      {rows == null ? <div className="loading-state">Loading…</div> : rows.length === 0 ? null : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Ticker</th>
              <th className="comp-col-mobile-hide">Company</th>
              <th className="numeric comp-col-mobile-hide">FY</th>
              <th className="numeric">Ratio</th>
              <th className="numeric">CEO total</th>
              <th className="numeric">Median employee</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.ticker}>
                <td className="screen-sector">{r._rank}</td>
                <td><Link to={`/company/${r.ticker}`} className="screen-ticker">{r.ticker}</Link></td>
                <td className="comp-col-mobile-hide">{r.company_name}</td>
                <td className="numeric comp-col-mobile-hide">{r.fiscal_year_covered}</td>
                <td className="numeric"><strong>{r.ratio_x_to_1.toFixed(0)}:1</strong></td>
                <td className="numeric">{fmtUsd(r.ceo_total)}</td>
                <td className="numeric">{fmtUsd(r.median_employee)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SparseHint({ when }: { when: boolean | undefined }) {
  if (!when) return null;
  return (
    <div className="empty-state" style={{ minHeight: 100 }}>
      No data yet — run extract-proxy across the universe to populate
    </div>
  );
}
