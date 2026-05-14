import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchMismanagement,
  type MismanagementRow,
  type MismanagementFlagId,
} from "../api.js";
import { fmtUsdCompact } from "../lib/format.js";

// Mismanagement is the editorial frame for this page: eight quantitative
// red flags, each binary, each backed by a number visible on the row.
// Ranking is # of flags fired. No opaque composite score — the reader can
// see which checks each company tripped and disagree with any individual
// one.
//
// The flag set is intentionally narrow. We chose checks where the data is
// hard to handwave away in a single year (e.g. "net insider selling >
// $10M over a year" is a deliberate decision by people closest to the
// books). Things we *could* compute but didn't (per-NEO golden parachutes,
// say-on-pay vote outcomes, classified-board status) live on the company
// page; they belong to a narrower governance story, not the headline.

interface FlagDef {
  id: MismanagementFlagId;
  short: string;
  long: string;
  /** Evidence string built from the row when this flag fires. */
  evidence: (row: MismanagementRow) => string | null;
  /** Pulls the boolean from the row. */
  fired: (row: MismanagementRow) => boolean;
}

const FLAGS: FlagDef[] = [
  {
    id: "tsr_under",
    short: "TSR",
    long: "Trailed peer-group TSR in 3+ of last 5 years",
    fired: (r) => r.flag_tsr_under,
    evidence: (r) => (r.years_under != null ? `Trailed peers ${r.years_under}/${r.years_tracked}y` : null),
  },
  {
    id: "pay_through_it",
    short: "Pay",
    long: "Median CEO total compensation ≥ $15M while underperforming peers",
    fired: (r) => r.flag_pay_through_it,
    evidence: (r) =>
      r.peo_median != null ? `$${(r.peo_median / 1e6).toFixed(0)}M median CEO comp` : null,
  },
  {
    id: "active_13d",
    short: "13D",
    long: "Active-intent 13D filed against issuer in last 18 months",
    fired: (r) => r.flag_active_13d,
    evidence: (r) => (r.active_13d_count > 0 ? `${r.active_13d_count} active 13D` : null),
  },
  {
    id: "insider_selling",
    short: "Insid",
    long: "Net insider P − S < −$10M over last 12 months",
    fired: (r) => r.flag_insider_selling,
    evidence: (r) =>
      r.insider_net_365d < 0 ? `Insiders net sold ${fmtUsdCompact(Math.abs(r.insider_net_365d))}` : null,
  },
  {
    id: "earnings_cash",
    short: "Cash",
    long: "Operating cash flow < 80% of net income (latest FY)",
    fired: (r) => r.flag_earnings_cash,
    evidence: (r) =>
      r.ocf != null && r.net_income != null && r.net_income > 0
        ? `OCF ${((r.ocf / r.net_income) * 100).toFixed(0)}% of NI`
        : null,
  },
  {
    id: "dilutive_sbc",
    short: "SBC",
    long: "Stock-based comp > 10% of revenue (latest FY)",
    fired: (r) => r.flag_dilutive_sbc,
    evidence: (r) =>
      r.sbc != null && r.revenue != null && r.revenue > 0
        ? `SBC ${((r.sbc / r.revenue) * 100).toFixed(0)}% of revenue`
        : null,
  },
  {
    id: "returns_over_fcf",
    short: "Cap",
    long: "Buybacks + dividends exceed operating cash flow (latest FY)",
    fired: (r) => r.flag_returns_over_fcf,
    evidence: (r) => {
      if (r.ocf == null) return null;
      const ret = (r.buybacks ?? 0) + (r.dividends_paid ?? 0);
      return `Payouts ${fmtUsdCompact(ret)} > OCF ${fmtUsdCompact(r.ocf)}`;
    },
  },
  {
    id: "goodwill_heavy",
    short: "GW",
    long: "Goodwill > 40% of total assets (impairment exposure)",
    fired: (r) => r.flag_goodwill_heavy,
    evidence: (r) =>
      r.goodwill != null && r.total_assets != null && r.total_assets > 0
        ? `Goodwill ${((r.goodwill / r.total_assets) * 100).toFixed(0)}% of assets`
        : null,
  },
  {
    id: "governance_dissent",
    short: "Vote",
    long: "Last say-on-pay <80% support OR any director <80% support",
    fired: (r) => r.flag_governance_dissent,
    evidence: (r) => {
      const sop = r.latest_sop_support_pct;
      const dir = r.latest_min_director_support_pct;
      if (sop == null && dir == null) return null;
      const parts: string[] = [];
      if (sop != null) parts.push(`SoP ${sop.toFixed(0)}%`);
      if (dir != null) parts.push(`min dir ${dir.toFixed(0)}%`);
      return parts.join(" · ");
    },
  },
];

export function MismanagementPage() {
  const [rows, setRows] = useState<MismanagementRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [minMcap, setMinMcap] = useState(500e6);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    fetchMismanagement({ minMcap, limit: 200 })
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch((e: Error) => setError(e.message));
  }, [minMcap]);

  return (
    <div className="mismanagement">
      <header className="screen-head">
        <h1 className="screen-title">Mismanagement</h1>
        <p className="screen-sub">
          Eight quantitative red flags, each binary, each backed by a number you can audit.
          Ranking is the number of flags fired. The reader decides what counts as failure.
        </p>
      </header>

      <FlagLegend />

      <div className="mm-controls">
        <label className="mm-control">
          <span>Min market cap</span>
          <select value={minMcap} onChange={(e) => setMinMcap(Number(e.target.value))}>
            <option value={0}>All</option>
            <option value={100e6}>$100M+</option>
            <option value={500e6}>$500M+</option>
            <option value={2e9}>$2B+</option>
            <option value={10e9}>$10B+</option>
            <option value={50e9}>$50B+</option>
          </select>
        </label>
        <span className="mm-summary">
          {rows == null
            ? "Loading…"
            : `${rows.length.toLocaleString()} of ${total.toLocaleString()} qualifying companies`}
        </span>
      </div>

      {error ? (
        <div className="error-state">Error: {error}</div>
      ) : rows == null ? (
        <div className="loading-state">Loading…</div>
      ) : (
        <div className="mm-table-wrap">
          <table className="mm-table">
            <thead>
              <tr>
                <th className="numeric">Rank</th>
                <th>Company</th>
                <th className="numeric">Market cap</th>
                <th className="numeric">TSR gap</th>
                <th>Flags</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => <Row key={row.cik} row={row} rank={i + 1} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FlagLegend() {
  return (
    <div className="mm-legend">
      {FLAGS.map((f) => (
        <span key={f.id} className="mm-legend-item" title={f.long}>
          <span className="mm-legend-dot" /> {f.short}
          <span className="mm-legend-long"> — {f.long}</span>
        </span>
      ))}
    </div>
  );
}

function Row({ row, rank }: { row: MismanagementRow; rank: number }) {
  const fired = FLAGS.filter((f) => f.fired(row));
  const count = fired.length;
  const tsrGap =
    row.latest_peer_tsr != null && row.latest_company_tsr != null
      ? row.latest_peer_tsr - row.latest_company_tsr
      : null;
  return (
    <tr className={count >= 5 ? "mm-row mm-hot" : "mm-row"}>
      <td className="numeric">
        <span className="mm-rank">{rank}</span>
        <div className="mm-flagcount">{count}/8</div>
      </td>
      <td>
        <Link to={`/company/${row.ticker}`} className="screen-ticker mm-ticker">
          {row.ticker}
        </Link>
        <div className="mm-name">{row.name}</div>
        <div className="mm-sector">{row.sic_description ?? "—"}</div>
      </td>
      <td className="numeric">{fmtUsdCompact(row.market_cap)}</td>
      <td className={`numeric ${tsrGap != null && tsrGap > 0 ? "neg" : ""}`}>
        {tsrGap == null
          ? "—"
          : tsrGap > 0
          ? `−$${tsrGap.toFixed(0)}`
          : `+$${(-tsrGap).toFixed(0)}`}
      </td>
      <td>
        <div className="mm-strip">
          {FLAGS.map((f) => (
            <span
              key={f.id}
              className={`mm-dot ${f.fired(row) ? "mm-dot-on" : ""}`}
              title={`${f.short} — ${f.long}: ${f.fired(row) ? "fired" : "passed"}`}
            />
          ))}
        </div>
      </td>
      <td className="mm-evidence">
        {fired.length === 0 ? (
          <span className="mm-clean">— no flags —</span>
        ) : (
          fired
            .map((f) => f.evidence(row))
            .filter((s): s is string => !!s)
            .map((s, i) => (
              <span key={i} className="mm-chip">
                {s}
              </span>
            ))
        )}
      </td>
    </tr>
  );
}
