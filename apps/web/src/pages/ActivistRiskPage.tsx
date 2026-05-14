import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetch13DFeed, type ThirteenDFeedRow } from "../api.js";
import { fmtUsdCompact } from "../lib/format.js";

// "At risk of activist takeover" = active-intent Schedule 13D filings.
// An active 13D means an outside party crossed 5% beneficial ownership AND
// disclosed intent to influence control, management, or strategy. That's
// the filing every activist campaign starts with.
//
// We list one row per filing, grouped under the issuer; an issuer with
// multiple recent filings is a stronger signal (sustained pressure).

const WINDOWS = [
  { label: "Last 6 months", days: 183 },
  { label: "Last 12 months", days: 365 },
  { label: "Last 24 months", days: 730 },
] as const;

export function ActivistRiskPage() {
  const [rows, setRows] = useState<ThirteenDFeedRow[] | null>(null);
  const [days, setDays] = useState<number>(365);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    fetch13DFeed({ limit: 200, activeOnly: true, sinceDays: days })
      .then((r) => setRows(r.filings))
      .catch((e: Error) => setError(e.message));
  }, [days]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) =>
        r.ticker.toLowerCase().includes(needle) ||
        r.company_name.toLowerCase().includes(needle) ||
        r.filer_name.toLowerCase().includes(needle),
    );
  }, [rows, q]);

  // Count filings per issuer so the table can flag sustained-pressure cases.
  const filingsByTicker = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(r.ticker, (m.get(r.ticker) ?? 0) + 1);
    return m;
  }, [rows]);

  return (
    <div className="ar-page">
      <header className="screen-head">
        <h1 className="screen-title">Most at risk of activist takeover</h1>
        <p className="screen-sub" style={{ maxWidth: 720 }}>
          Every name below has an outside party that just crossed 5%
          beneficial ownership and disclosed intent to influence control,
          management, or strategy. That's a Schedule 13D filing — the legal
          trigger every activist campaign begins with. Companies with more
          than one recent filing are facing sustained pressure.
        </p>
      </header>

      <div className="mm-filters">
        <div className="mm-filter-group">
          <div className="mm-filter-label">Window</div>
          <div className="mm-filter-pills">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                type="button"
                className={`mm-pill ${days === w.days ? "on" : ""}`}
                onClick={() => setDays(w.days)}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mm-filter-group mm-filter-grow">
          <div className="mm-filter-label">Search</div>
          <input
            type="search"
            className="mm-sector-select"
            placeholder="Ticker, company, or filer…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="mm-summary">
          {filtered == null
            ? "Loading…"
            : `${filtered.length.toLocaleString()} active 13D filings`}
        </div>
      </div>

      {error ? (
        <div className="error-state">Error: {error}</div>
      ) : filtered == null ? (
        <div className="loading-state">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">No active 13D filings in this window.</div>
      ) : (
        <div className="mm-table-wrap">
          <table className="mm-table">
            <thead>
              <tr>
                <th>Target</th>
                <th>Market cap</th>
                <th>Filer</th>
                <th className="numeric">% owned</th>
                <th className="numeric">Filed</th>
                <th>Stated purpose</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const repeat = (filingsByTicker.get(r.ticker) ?? 0) > 1;
                return (
                  <tr key={r.accession_number} className="mm-row">
                    <td>
                      <Link to={`/company/${r.ticker}`} className="screen-ticker mm-ticker">
                        {r.ticker}
                      </Link>
                      <div className="mm-name">{r.company_name}</div>
                      <div className="mm-sector">
                        {r.sic_description ?? "—"}
                        {repeat ? (
                          <span className="ar-repeat" title="Multiple recent active-intent 13Ds against this issuer">
                            {" "}· sustained pressure
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="numeric">{fmtUsdCompact(r.market_cap)}</td>
                    <td>
                      <strong>{r.filer_name}</strong>
                      {r.cooperation_agreement_present ? (
                        <div className="ar-tag">cooperation agreement</div>
                      ) : null}
                      {r.standstill_present ? (
                        <div className="ar-tag">standstill</div>
                      ) : null}
                    </td>
                    <td className="numeric">
                      {r.aggregate_percent != null ? `${r.aggregate_percent.toFixed(1)}%` : "—"}
                    </td>
                    <td className="numeric">{r.filing_date}</td>
                    <td className="ar-purpose">{r.purpose_summary ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
