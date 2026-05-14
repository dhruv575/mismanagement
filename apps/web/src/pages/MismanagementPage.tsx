import { memo, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchMismanagementUniverse,
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
    fired: (r) => !!r.flag_tsr_under,
    evidence: (r) => (r.years_under != null ? `Trailed peers ${r.years_under}/${r.years_tracked}y` : null),
  },
  {
    id: "pay_through_it",
    short: "Pay",
    long: "Median CEO total compensation ≥ $15M while underperforming peers",
    fired: (r) => !!r.flag_pay_through_it,
    evidence: (r) =>
      r.peo_median != null ? `$${(r.peo_median / 1e6).toFixed(0)}M median CEO comp` : null,
  },
  {
    id: "active_13d",
    short: "13D",
    long: "Active-intent 13D filed against issuer in last 18 months",
    fired: (r) => !!r.flag_active_13d,
    evidence: (r) => (r.active_13d_count > 0 ? `${r.active_13d_count} active 13D` : null),
  },
  {
    id: "insider_selling",
    short: "Insid",
    long: "Net insider P − S < −$10M over last 12 months",
    fired: (r) => !!r.flag_insider_selling,
    evidence: (r) =>
      r.insider_net_365d < 0 ? `Insiders net sold ${fmtUsdCompact(Math.abs(r.insider_net_365d))}` : null,
  },
  {
    id: "earnings_cash",
    short: "Cash",
    long: "Operating cash flow < 80% of net income (latest FY)",
    fired: (r) => !!r.flag_earnings_cash,
    evidence: (r) =>
      r.ocf != null && r.net_income != null && r.net_income > 0
        ? `OCF ${((r.ocf / r.net_income) * 100).toFixed(0)}% of NI`
        : null,
  },
  {
    id: "dilutive_sbc",
    short: "SBC",
    long: "Stock-based comp > 10% of revenue (latest FY)",
    fired: (r) => !!r.flag_dilutive_sbc,
    evidence: (r) =>
      r.sbc != null && r.revenue != null && r.revenue > 0
        ? `SBC ${((r.sbc / r.revenue) * 100).toFixed(0)}% of revenue`
        : null,
  },
  {
    id: "returns_over_fcf",
    short: "Cap",
    long: "Buybacks + dividends exceed operating cash flow (latest FY)",
    fired: (r) => !!r.flag_returns_over_fcf,
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
    fired: (r) => !!r.flag_goodwill_heavy,
    evidence: (r) =>
      r.goodwill != null && r.total_assets != null && r.total_assets > 0
        ? `Goodwill ${((r.goodwill / r.total_assets) * 100).toFixed(0)}% of assets`
        : null,
  },
  {
    id: "governance_dissent",
    short: "Vote",
    long: "Last say-on-pay <80% support OR any director <80% support",
    fired: (r) => !!r.flag_governance_dissent,
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

// Cap on rendered table rows. With 2.5K candidates, rendering all of them
// turns each keystroke into a multi-second re-reconcile. Showing the top
// VISIBLE_CAP after sorting/filtering covers the use case (the user
// looking for specific names searches first; the bottom of the list is
// generally clean issuers no one is scrolling to).
const VISIBLE_CAP = 250;

export function MismanagementPage() {
  const [allRows, setAllRows] = useState<MismanagementRow[] | null>(null);
  const [minMcap, setMinMcap] = useState(500e6);
  const [sector, setSector] = useState<string>("");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  // qInput updates on every keystroke (controlled input); q is debounced
  // and is what actually drives the filter chain. Without this, typing
  // into the search box re-filters + re-renders 2.5K rows per character.
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 150);
    return () => clearTimeout(t);
  }, [qInput]);
  const [flagFilter, setFlagFilter] = useState<Set<MismanagementFlagId>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // One fetch for the whole session: the materialized scoreboard refreshes
  // out of band (daily cron) so within a page lifetime the data is fixed.
  // All filters (market cap included) run client-side. We tag each row
  // with its canonical universe rank (position in the unfiltered list) so
  // the visible table always shows "rank in the whole universe" instead of
  // "row index in the current filter", which would change every keystroke.
  useEffect(() => {
    fetchMismanagementUniverse()
      .then((r) =>
        setAllRows(
          r.rows.map((row, i) => ({ ...row, _rank: i + 1 } as MismanagementRow & { _rank: number })),
        ),
      )
      .catch((e: Error) => setError(e.message));
  }, []);

  // Apply the market-cap floor first so the "qualifying at this market
  // cap" count below matches what the user picked.
  const mcapFiltered = useMemo(() => {
    if (!allRows) return null;
    return minMcap > 0
      ? allRows.filter((r) => r.market_cap != null && r.market_cap >= minMcap)
      : allRows;
  }, [allRows, minMcap]);
  const total = mcapFiltered?.length ?? 0;

  // Sector counts derive from rows that pass *every other filter*
  // (search + flag filter), so the count next to each sector name is the
  // number you'd actually see if you picked it.
  const sectorBase = useMemo(() => {
    if (!mcapFiltered) return null;
    const needle = q.trim().toLowerCase();
    return mcapFiltered.filter((r) => {
      if (needle && !(r.ticker.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle))) return false;
      if (flagFilter.size > 0) {
        for (const id of flagFilter) {
          const def = FLAGS_BY_ID[id];
          if (def && !def.fired(r)) return false;
        }
      }
      return true;
    });
  }, [mcapFiltered, q, flagFilter]);

  const sectors = useMemo(() => {
    if (!sectorBase) return [] as { name: string; count: number }[];
    const counts = new Map<string, number>();
    for (const r of sectorBase) {
      const s = (r.sic_description ?? "Other").trim();
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [sectorBase]);

  const visible = useMemo(() => {
    if (!sectorBase) return null;
    let v = sector
      ? sectorBase.filter((r) => (r.sic_description ?? "Other").trim() === sector)
      : sectorBase;
    if (sortDir === "asc") {
      v = [...v].sort((a, b) => {
        const af = countFlags(a);
        const bf = countFlags(b);
        if (af !== bf) return af - bf;
        return a.ticker.localeCompare(b.ticker);
      });
    }
    return v;
  }, [sectorBase, sector, sortDir]);

  function toggleFlag(id: MismanagementFlagId) {
    setFlagFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="mismanagement">
      <header className="screen-head">
        <h1 className="screen-title">Mismanagement</h1>
        <p className="screen-sub">
          Nine quantitative red flags, each binary, each backed by a number you can audit.
          Ranking is the number of flags fired. The reader decides what counts as failure.
        </p>
      </header>

      <input
        type="search"
        className="mm-search"
        placeholder="Search ticker or company name…"
        value={qInput}
        onChange={(e) => setQInput(e.target.value)}
        autoComplete="off"
      />

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

        <div className="mm-filter-group">
          <div className="mm-filter-label">
            Must have these flags fired (multi-select)
          </div>
          <div className="mm-filter-pills">
            {FLAGS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`mm-pill ${flagFilter.has(f.id) ? "on" : ""}`}
                onClick={() => toggleFlag(f.id)}
                title={f.long}
              >
                {f.short}
              </button>
            ))}
            {flagFilter.size > 0 ? (
              <button
                type="button"
                className="mm-pill mm-pill-clear"
                onClick={() => setFlagFilter(new Set())}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        <div className="mm-filter-row">
          <div className="mm-filter-group mm-filter-grow">
            <div className="mm-filter-label">Sector</div>
            <select
              className="mm-sector-select"
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              disabled={!sectorBase}
            >
              <option value="">All sectors{sectorBase ? ` (${sectorBase.length.toLocaleString()})` : ""}</option>
              {sectors.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.count.toLocaleString()})
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
            : visible.length > VISIBLE_CAP
            ? `Showing top ${VISIBLE_CAP.toLocaleString()} of ${visible.length.toLocaleString()} matches · ${total.toLocaleString()} qualifying at this market cap`
            : `${visible.length.toLocaleString()} matching · ${total.toLocaleString()} qualifying at this market cap`}
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
                <th className="mm-col-flags">Flags</th>
                <th className="mm-col-evidence">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, VISIBLE_CAP).map((row) => (
                <Row
                  key={row.cik}
                  row={row}
                  rank={(row as MismanagementRow & { _rank?: number })._rank ?? 0}
                />
              ))}
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

const FLAGS_BY_ID: Record<MismanagementFlagId, FlagDef> = FLAGS.reduce(
  (acc, f) => {
    acc[f.id] = f;
    return acc;
  },
  {} as Record<MismanagementFlagId, FlagDef>,
);

const Row = memo(function Row({ row, rank }: { row: MismanagementRow; rank: number }) {
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
      <td className="mm-col-flags">
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
      <td className="mm-evidence mm-col-evidence">
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
});
