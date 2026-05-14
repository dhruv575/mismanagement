import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchMismanagement, fetchSearch,
  type MismanagementRow, type SearchHit,
} from "../api.js";
import { fmtUsdCompact } from "../lib/format.js";

// Home is: title + dek → search → 10 sector-diverse mismanagement cards.
// The leaderboard at /mismanagement is the full list; this page is just
// the editorial entry point.

export function HomePage() {
  const [hot, setHot] = useState<MismanagementRow[] | null>(null);

  useEffect(() => {
    fetchMismanagement({ minMcap: 1e9, limit: 300 })
      .then((r) => setHot(diversify(r.rows, 10)))
      .catch(() => setHot([]));
  }, []);

  return (
    <div className="home">
      <section className="home-hero">
        <p className="hero-eyebrow">MTS · ACTIVIST</p>
        <h1 className="hero-title">Mismanagement, in numbers.</h1>
        <p className="hero-dek">
          An activist-style screen built from filings every public US company is
          already required to publish — SEC EDGAR XBRL, DEF 14A proxy
          statements, Form 4 insider transactions, Schedule 13D blocks. The
          schema captures facts; characterization is the reader's job.
        </p>
        <SearchBar />
      </section>

      <section className="home-grid-section">
        <header className="home-grid-head">
          <h2 className="home-grid-title">A few candidates</h2>
          <Link to="/mismanagement" className="home-grid-more">View the full leaderboard →</Link>
        </header>
        {hot == null ? (
          <div className="loading-state">Loading…</div>
        ) : hot.length === 0 ? (
          <div className="empty-state">No mismanagement data yet</div>
        ) : (
          <div className="home-grid">
            {hot.map((row) => <Candidate key={row.cik} row={row} />)}
          </div>
        )}
      </section>
    </div>
  );
}

/** Walk the mismanagement leaderboard top-down and pick one company per
 *  sector until `count` is reached. Sector-diverse list, still ranked. */
function diversify(rows: MismanagementRow[], count: number): MismanagementRow[] {
  const seen = new Set<string>();
  const out: MismanagementRow[] = [];
  for (const r of rows) {
    const key = (r.sic_description ?? "other").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length === count) break;
  }
  return out;
}

const FLAG_KEYS = [
  "flag_tsr_under", "flag_pay_through_it", "flag_active_13d",
  "flag_insider_selling", "flag_earnings_cash", "flag_dilutive_sbc",
  "flag_returns_over_fcf", "flag_goodwill_heavy", "flag_governance_dissent",
] as const;

function Candidate({ row }: { row: MismanagementRow }) {
  const fired = FLAG_KEYS.filter((k) => row[k]).length;
  return (
    <Link to={`/company/${row.ticker}`} className="cand">
      <div className="cand-top">
        <span className="cand-ticker">{row.ticker}</span>
        <span className="cand-count">
          <strong>{fired}</strong>/8
        </span>
      </div>
      <p className="cand-name">{row.name}</p>
      <p className="cand-sector">{row.sic_description ?? "—"}</p>
      <div className="cand-strip">
        {FLAG_KEYS.map((k) => (
          <span key={k} className={`cand-dot ${row[k] ? "on" : ""}`} />
        ))}
      </div>
      <p className="cand-meta">{fmtUsdCompact(row.market_cap)} mkt cap</p>
    </Link>
  );
}

function SearchBar() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits([]); return; }
    const t = setTimeout(() => {
      fetchSearch(term).then((r) => setHits(r.rows)).catch(() => setHits([]));
    }, 120);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    function onClickAway(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, []);

  // Always open /company/<ticker> in a new tab — explicit in the user's brief.
  function openTicker(ticker: string) {
    window.open(`/company/${ticker}`, "_blank", "noopener,noreferrer");
    setQ("");
    setHits([]);
    setOpen(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[active];
      if (hit) openTicker(hit.ticker);
      else if (q.trim()) openTicker(q.trim().toUpperCase());
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showDropdown = open && hits.length > 0;

  return (
    <div className="home-search" ref={wrapRef}>
      <input
        type="search"
        className="home-search-input"
        placeholder="Search any ticker or company — opens in a new tab"
        value={q}
        autoComplete="off"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {showDropdown ? (
        <ul className="home-search-list">
          {hits.map((h, i) => (
            <li
              key={h.cik}
              className={`home-search-row ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); openTicker(h.ticker); }}
            >
              <span className="home-search-ticker">{h.ticker}</span>
              <span className="home-search-name">{h.name}</span>
              <span className="home-search-sector">{h.sic_description ?? ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
