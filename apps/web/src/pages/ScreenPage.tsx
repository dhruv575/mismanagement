import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchScreen, type ScreenRow, type ScreenSortExtended } from "../api.js";
import { fmtUsdCompact, fmtCompact } from "../lib/format.js";

// The default sort is `activist_signal` — a hidden composite (TSR gap,
// presence of recent 13D, insider activity intensity). The signal value
// itself is not displayed; only the ordering. Editorial premise:
// "facts, not characterization" — the ranking is the editorial gesture.
const COLUMNS: { key: ScreenSortExtended; label: string; numeric?: boolean }[] = [
  { key: "activist_signal", label: "Rank", numeric: true },
  { key: "ticker", label: "Ticker" },
  { key: "name", label: "Company" },
  { key: "market_cap", label: "Market cap", numeric: true },
  { key: "latest_revenue", label: "Latest revenue", numeric: true },
  { key: "tsr_gap", label: "TSR gap (peers − co)", numeric: true },
  { key: "insider_net_dollars_365d", label: "Insider net 12mo", numeric: true },
];

export function ScreenPage() {
  const [rows, setRows] = useState<ScreenRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<ScreenSortExtended>("activist_signal");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    fetchScreen({ sort, dir, limit: 200 })
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch((e: Error) => setError(e.message));
  }, [sort, dir]);

  function toggleSort(key: ScreenSortExtended) {
    if (key === sort) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setSort(key);
      setDir(key === "ticker" || key === "name" ? "asc" : "desc");
    }
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <h1 className="screen-title">Screen</h1>
        <p className="screen-sub">
          {rows == null
            ? "Loading universe…"
            : `${rows.length.toLocaleString()} of ${total.toLocaleString()} companies. Default rank is a composite of TSR underperformance, recent 13D presence, and insider activity. Click a column to re-sort.`}
        </p>
      </header>

      {error ? (
        <div className="error-state">Error: {error}</div>
      ) : (
        <table className="screen-table">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={`${col.numeric ? "numeric " : ""}${sort === col.key ? "active" : ""}`}
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}
                  {sort === col.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
                </th>
              ))}
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((row, i) => {
              const tsrGap =
                row.peer_group_tsr_indexed != null && row.company_tsr_indexed != null
                  ? row.peer_group_tsr_indexed - row.company_tsr_indexed
                  : null;
              // Rank position reflects current sort order. Only meaningful
              // when sorting by activist_signal; for other sorts it's just
              // a position in the current view.
              return (
                <tr key={row.cik}>
                  <td className="numeric screen-sector">{i + 1}</td>
                  <td>
                    <Link to={`/company/${row.ticker}`} className="screen-ticker">
                      {row.ticker}
                    </Link>
                  </td>
                  <td>
                    <div className="screen-name">{row.name}</div>
                    <div className="screen-sector">{row.sic_description ?? "—"}</div>
                  </td>
                  <td className="numeric">{fmtUsdCompact(row.market_cap)}</td>
                  <td className="numeric">
                    {row.latest_revenue == null
                      ? "—"
                      : fmtUsdCompact(row.latest_revenue)}
                    {row.latest_revenue_year ? (
                      <div className="screen-sector">FY {row.latest_revenue_year}</div>
                    ) : null}
                  </td>
                  <td className="numeric">
                    {tsrGap == null ? "—" : tsrGap > 0 ? `−$${tsrGap.toFixed(0)}` : `+$${(-tsrGap).toFixed(0)}`}
                  </td>
                  <td className={`numeric ${row.insider_net_dollars_365d < 0 ? "neg" : row.insider_net_dollars_365d > 0 ? "pos" : ""}`}>
                    {row.insider_net_dollars_365d === 0 ? "—" :
                      `${row.insider_net_dollars_365d < 0 ? "−" : "+"}${fmtUsdCompact(Math.abs(row.insider_net_dollars_365d))}`}
                  </td>
                  <td>
                    {row.has_active_13d ? <span className="screen-flag hot">Active 13D</span> : null}
                    {row.has_recent_13d && !row.has_active_13d ? <span className="screen-flag">13G 180d</span> : null}
                    {row.is_russell_3000 ? <span className="screen-flag" style={{ marginLeft: 6 }}>R3K</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
