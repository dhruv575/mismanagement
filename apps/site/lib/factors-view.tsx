// What Jev read in the 10-K, and how often that preceded a deal.
// FactorEvidence: the model pages' table (every factor, with its record).
// FactorChips: a company page's notable factors, pointing up or down.

export interface FactorEvidenceRow {
  name: string; label: string; group: string; in_model: boolean;
  n_high: number; deals_high: number; lift_high: number | null; n_low: number; lift_low: number | null;
}
export interface ModelMeta {
  rows: number; positives: number; base_rate: number; model?: string;
  backtest?: { auc: number; top_decile: number; test_positives: number; auc_2024?: number; first: number; last: number;
    strict?: { auc: number; top_decile: number; test_positives: number; positives: number } };
  factors?: FactorEvidenceRow[];
}

// Enough companies, and enough deals expected among them, for the rate to mean something.
const solid = (f: FactorEvidenceRow, base: number) => f.lift_high != null && f.n_high >= 100 && f.n_high * base >= 2.5;
export const UP = 1.4, DOWN = 0.7;

export function FactorEvidence({ meta, outcome }: { meta: ModelMeta; outcome: string }) {
  const base = meta.positives / meta.rows;
  const rows = (meta.factors ?? []).filter((f) => solid(f, base)).sort((a, b) => b.lift_high! - a.lift_high!);
  if (!rows.length) return null;
  // The ones that clearly move the odds lead; the rest fold away.
  const clear = rows.filter((f) => f.lift_high! >= UP || f.lift_high! <= DOWN), rest = rows.filter((f) => !clear.includes(f));
  return (
    <>
      <EvidenceTable rows={clear} outcome={outcome} />
      {rest.length > 0 && (
        <details className="other-signals">
          <summary>{rest.length} factors that made little difference</summary>
          <EvidenceTable rows={rest} outcome={outcome} />
        </details>
      )}
    </>
  );
}

function EvidenceTable({ rows, outcome }: { rows: FactorEvidenceRow[]; outcome: string }) {
  // Diverging bars on a log scale: 1x in the middle, 4x and 1/4x at the ends.
  const pos = (l: number) => Math.max(-1, Math.min(1, Math.log(Math.max(l, 0.01)) / Math.log(4)));
  return (
    <div className="table-wrap">
      <table className="data factor-table">
        <thead>
          <tr>
            <th>When the 10-K says…</th>
            <th className="num">Companies</th>
            <th className="num">Then {outcome}</th>
            <th className="lift-col">Likelihood vs. average</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            const x = pos(f.lift_high!);
            return (
              <tr key={f.name}>
                <td>{f.label}{f.in_model && <span className="in-model" title="Used by the model">model</span>}</td>
                <td className="num">{f.n_high.toLocaleString("en-US")}</td>
                <td className="num">{f.deals_high}</td>
                <td className="lift-col">
                  <div className="lift-cell">
                    <span className="lift-bar" aria-hidden="true">
                      <span className="lift-fill" data-up={x > 0} style={x > 0 ? { left: "50%", width: `${x * 50}%` } : { right: "50%", width: `${-x * 50}%` }} />
                    </span>
                    <span className="lift-v" data-up={f.lift_high! >= UP} data-down={f.lift_high! <= DOWN}>{f.lift_high!.toFixed(1)}×</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// A company's factors that both scored high (7+) and carry a clear record.
export function FactorChips({ factors, meta, side, exclude = [] }: { factors: Record<string, number> | null | undefined; meta: ModelMeta | null | undefined; side: "angel" | "devil"; exclude?: string[] }) {
  if (!factors || !meta?.factors) return null;
  const base = meta.positives / meta.rows;
  const hits = meta.factors
    .filter((f) => !exclude.includes(f.name) && solid(f, base) && (factors[f.name] ?? 0) >= 7 && (f.lift_high! >= UP || f.lift_high! <= DOWN))
    .sort((a, b) => Math.abs(Math.log(Math.max(b.lift_high!, 0.05))) - Math.abs(Math.log(Math.max(a.lift_high!, 0.05))))
    .slice(0, 6);
  if (!hits.length) return null;
  const what = side === "angel" ? "a sponsor buyout of a services business" : "a take-private";
  return (
    <div className="factor-chips">
      <span className="muted">From the 10-K:</span>
      <ul>
        {hits.map((f) => {
          const up = f.lift_high! >= UP;
          return (
            <li key={f.name} data-up={up} title={`${f.deals_high} of ${f.n_high.toLocaleString("en-US")} companies like this saw ${what} within a year (${f.lift_high!.toFixed(1)}× average)`}>
              <span aria-hidden="true">{up ? "↑" : "↓"}</span>{f.label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
