import { useEffect, useMemo, useState } from "react";
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

const MCAP_BUCKETS: { label: string; value: number }[] = [
  { label: "All", value: 0 },
  { label: "$100M+", value: 100e6 },
  { label: "$500M+", value: 500e6 },
  { label: "$2B+", value: 2e9 },
  { label: "$10B+", value: 10e9 },
  { label: "$50B+", value: 50e9 },
];

type SortDir = "desc" | "asc";

export function MismanagementPage() {
  const [rows, setRows] = useState<MismanagementRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [minMcap, setMinMcap] = useState(500e6);
  const [sector, setSector] = useState<string>("");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    fetchMismanagement({ minMcap, limit: 500 })
      .then((r) => {
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch((e: Error) => setError(e.message));
  }, [minMcap]);

  // Sectors derive from whichever rows the API returned for the current
  // market-cap bucket. Counts give the user a sense of how many companies
  // live behind each option before they pick one.
  const sectors = useMemo(() => {
    if (!rows) return [] as { name: string; count: number }[];
    const counts = new Map<string, number>();
    for (const r of rows) {
      const s = (r.sic_description ?? "Other").trim();
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [rows]);

  // Sorting is client-side -- the API returns flags_fired-desc already, so
  // "Most red flags" is a no-op; "Fewest" reverses. Sector filtering is also
  // client-side: at 500-row depth it's instant and avoids round-tripping.
  const visible = useMemo(() => {
    if (!rows) return null;
    let v = sector ? rows.filter((r) => (r.sic_description ?? "Other").trim() === sector) : rows;
    if (sortDir === "asc") {
      v = [...v].sort((a, b) => {
        const af = countFlags(a);
        const bf = countFlags(b);
        if (af !== bf) return af - bf;
        return a.ticker.localeCompare(b.ticker);
      });
    }
    return v;
  }, [rows, sector, sortDir]);

  return (
    <div className="mismanagement">
      <header className="screen-head">
        <h1 className="screen-title">Mismanagement</h1>
        <p className="screen-sub">
          Nine quantitative red flags, each binary, each backed by a number you can audit.
          Ranking is the number of flags fired. The reader decides what counts as failure.
        </p>
      </header>

      <div className="mm-filters">
        <div className="mm-filter-group">
          <div className="mm-filter-label">Market cap</div>
          <div className="mm-filter-pills">
            {MCAP_BUCKETS.map((b) => (
              <button
                key={b.value}
                type="button"
                className={`mm-pill ${minMcap === b.value ? "on" : ""}`}
                onClick={() => setMinMcap(b.value)}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mm-filter-row">
          <div className="mm-filter-group mm-filter-grow">
            <div className="mm-filter-label">Sector</div>
            <select
              className="mm-sector-select"
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              disabled={!rows}
            >
              <option value="">All sectors{rows ? ` (${rows.length})` : ""}</option>
              {sectors.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.count})
                </option>
              ))}
            </select>
          </div>

          <div className="mm-filter-group">
            <div className="mm-filter-label">Sort</div>
            <div className="mm-filter-pills">
              <button
                type="button"
                className={`mm-pill ${sortDir === "desc" ? "on" : ""}`}
                onClick={() => setSortDir("desc")}
              >
                Most red flags
              </button>
              <button
                type="button"
                className={`mm-pill ${sortDir === "asc" ? "on" : ""}`}
                onClick={() => setSortDir("asc")}
              >
                Fewest red flags
              </button>
            </div>
          </div>
        </div>

        <div className="mm-summary">
          {visible == null
            ? "Loading…"
            : `${visible.length.toLocaleString()} of ${total.toLocaleString()} qualifying companies`}
        </div>
      </div>

      {error ? (
        <div className="error-state">Error: {error}</div>
      ) : visible == null ? (
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
              {visible.map((row, i) => <Row key={row.cik} row={row} rank={i + 1} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function countFlags(row: MismanagementRow): number {
  return FLAGS.reduce((n, f) => n + (f.fired(row) ? 1 : 0), 0);
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
        <div className="mm-flagcount">{count}/9</div>
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
