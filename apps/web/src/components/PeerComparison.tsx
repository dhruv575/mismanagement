import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPeers, type PeerRow, type PeersResponse } from "../api.js";
import { fmtUsd, fmtPctRaw } from "../lib/format.js";

interface Props { ticker: string }

// Side-by-side comparison of the subject company and its self-stated
// peer group on TSR, CEO comp, and board independence. Peer group comes
// straight from the proxy filing — nothing editorial about the cohort
// choice. Unresolvable peers (not in our universe) are listed verbatim
// at the bottom so the reader sees the full filed cohort.

export function PeerComparison({ ticker }: Props) {
  const [data, setData] = useState<PeersResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setData(null);
    setLoaded(false);
    fetchPeers(ticker)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoaded(true));
  }, [ticker]);

  if (!loaded) return null;
  if (!data || (!data.subject && data.peers.length === 0 && data.unresolved.length === 0)) {
    return null; // proxy not extracted yet; skip silently
  }

  return (
    <section className="section">
      <h2 className="section-title">Peer group — as filed</h2>
      {data.subject || data.peers.length > 0 ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>CEO</th>
              <th className="numeric">CEO total comp</th>
              <th className="numeric">TSR (latest)</th>
              <th className="numeric">Peer TSR</th>
              <th className="numeric">Board</th>
              <th className="numeric">% indep</th>
            </tr>
          </thead>
          <tbody>
            {data.subject ? <PeerRowEl row={data.subject} isSubject /> : null}
            {data.peers.map((p) => <PeerRowEl key={p.cik} row={p} />)}
          </tbody>
        </table>
      ) : null}
      {data.unresolved.length > 0 ? (
        <p className="peers-unresolved">
          <strong>Filed peer group also includes (not in our coverage):</strong>{" "}
          {data.unresolved.join(", ")}.
        </p>
      ) : null}
    </section>
  );
}

function PeerRowEl({ row, isSubject = false }: { row: PeerRow; isSubject?: boolean }) {
  return (
    <tr style={isSubject ? { background: "rgba(255, 214, 10, 0.04)" } : undefined}>
      <td>
        {isSubject ? (
          <strong>{row.ticker}</strong>
        ) : (
          <Link to={`/company/${row.ticker}`} className="screen-ticker">
            {row.ticker}
          </Link>
        )}
        <div className="screen-sector">{row.name}</div>
      </td>
      <td>{row.ceo_name ?? "—"}</td>
      <td className="numeric">{fmtUsd(row.ceo_total_comp)}</td>
      <td className="numeric">
        {row.company_tsr_indexed == null
          ? "—"
          : `$${row.company_tsr_indexed.toFixed(0)}`}
      </td>
      <td className="numeric">
        {row.peer_group_tsr_indexed == null
          ? "—"
          : `$${row.peer_group_tsr_indexed.toFixed(0)}`}
      </td>
      <td className="numeric">{row.director_count ?? "—"}</td>
      <td className="numeric">
        {row.independent_pct == null ? "—" : fmtPctRaw(row.independent_pct, 0)}
      </td>
    </tr>
  );
}
