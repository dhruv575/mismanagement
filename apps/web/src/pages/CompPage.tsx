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
  return (
    <div className="comp-page">
      <header className="activity-head">
        <h1 className="activity-title">Compensation outliers</h1>
        <p className="activity-sub">
          Three views over the corpus. Pay-vs-Performance gap shows where
          equity vesting moved CEO realized pay materially above or below
          the reported summary number.
        </p>
      </header>

      <HighestBoard />
      <PayGapBoard />
      <PayRatioBoard />
    </div>
  );
}

function HighestBoard() {
  const [rows, setRows] = useState<CompHighestRow[] | null>(null);
  useEffect(() => {
    fetchCompHighest(25).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, []);
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
              <th>Company</th>
              <th>Executive</th>
              <th>Title</th>
              <th className="numeric">FY</th>
              <th className="numeric">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.ticker}-${i}`}>
                <td className="screen-sector">{i + 1}</td>
                <td><Link to={`/company/${r.ticker}`} className="screen-ticker">{r.ticker}</Link></td>
                <td>{r.company_name}</td>
                <td><strong>{r.executive_name}</strong></td>
                <td className="screen-sector">{r.title}</td>
                <td className="numeric">{r.fiscal_year}</td>
                <td className="numeric"><strong>{fmtUsd(r.total)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PayGapBoard() {
  const [rows, setRows] = useState<CompPayGapRow[] | null>(null);
  useEffect(() => {
    fetchCompPayGap(25).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, []);
  return (
    <section className="section">
      <h2 className="section-title">Biggest pay-vs-paid gap</h2>
      <p className="screen-sub" style={{ marginBottom: 14 }}>
        Difference between "comp actually paid" (PvP, equity marked-to-market) and "total comp" (Summary Compensation Table).
      </p>
      <SparseHint when={rows?.length === 0} />
      {rows == null ? <div className="loading-state">Loading…</div> : rows.length === 0 ? null : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Company</th>
              <th className="numeric">FY</th>
              <th className="numeric">Total comp</th>
              <th className="numeric">Comp paid</th>
              <th className="numeric">Gap</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ticker}>
                <td><Link to={`/company/${r.ticker}`} className="screen-ticker">{r.ticker}</Link></td>
                <td>{r.company_name}</td>
                <td className="numeric">{r.fiscal_year}</td>
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

function PayRatioBoard() {
  const [rows, setRows] = useState<CompPayRatioRow[] | null>(null);
  useEffect(() => {
    fetchCompPayRatio(25).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, []);
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
              <th>Company</th>
              <th className="numeric">FY</th>
              <th className="numeric">Ratio</th>
              <th className="numeric">CEO total</th>
              <th className="numeric">Median employee</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.ticker}>
                <td className="screen-sector">{i + 1}</td>
                <td><Link to={`/company/${r.ticker}`} className="screen-ticker">{r.ticker}</Link></td>
                <td>{r.company_name}</td>
                <td className="numeric">{r.fiscal_year_covered}</td>
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
