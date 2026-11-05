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

// When the 10-K scores a factor low (under 3), how to say it.
const LOW_LABEL: Record<string, string> = {
  services_share: "Mostly products, not services", labor_intensity: "Not labor-intensive", ai_automatable: "Little AI-automatable work",
  fragmented_market: "Concentrated market", recurring_revenue: "Little recurring revenue", rollup_fit: "Poor AI-rollup fit",
  office_work: "Office work isn't the product", people_services: "Not people-delivered services", payroll_heavy: "Payroll isn't the main cost",
  many_small_rivals: "Few small rivals", contracted: "Little contracted revenue", rollup_target: "Not an AI-rollup target",
  software_platform: "Not software or a platform", b2b: "Sells to consumers", asset_light: "Asset-heavy", physical_ops: "No physical operations",
  regulated: "Lightly regulated", gov_customers: "No government customers", customer_concentration: "Diversified customers",
  acquisitive: "Not an acquirer", niche_leader: "Not a niche leader", us_focused: "Mostly outside the U.S.", growth_stage: "Mature business",
  disruption_risk: "Not threatened by technology", pricing_power: "Little pricing power", portfolio_change: "No portfolio changes",
  restructuring: "No restructuring",
};
const LOW = 3, HIGH = 7;

interface Chip { key: string; label: string; lift: number; tip: string }

// A company's factors with a clear record: scored high on a factor that moves the
// odds, or low on one whose absence does. Strongest first, ups and downs apart.
export function FactorChips({ factors, meta, side, exclude = [] }: { factors: Record<string, number> | null | undefined; meta: ModelMeta | null | undefined; side: "angel" | "devil"; exclude?: string[] }) {
  if (!factors || !meta?.factors) return null;
  const base = meta.positives / meta.rows;
  const what = side === "angel" ? "a sponsor buyout of a services business" : "a take-private";
  const n = (x: number) => x.toLocaleString("en-US");
  const chips: Chip[] = [];
  for (const f of meta.factors) {
    const v = factors[f.name];
    if (exclude.includes(f.name) || v == null) continue;
    if (v >= HIGH && solid(f, base) && (f.lift_high! >= UP || f.lift_high! <= DOWN))
      chips.push({ key: f.name, label: f.label, lift: f.lift_high!, tip: `${f.deals_high} of ${n(f.n_high)} companies whose 10-K read like this saw ${what} within a year (${f.lift_high!.toFixed(1)}× average)` });
    else if (v < LOW && f.lift_low != null && f.n_low >= 100 && f.n_low * base >= 2.5 && f.lift_low <= DOWN)
      chips.push({ key: f.name, label: LOW_LABEL[f.name] ?? `Low: ${f.label.toLowerCase()}`, lift: f.lift_low, tip: `Of ${n(f.n_low)} companies scoring low on "${f.label.toLowerCase()}", ${what} came ${f.lift_low.toFixed(1)}× as often as average` });
  }
  const strength = (c: Chip) => Math.abs(Math.log(Math.max(c.lift, 0.05)));
  // Only the patterns strong enough to be worth a reader's attention.
  const ups = chips.filter((c) => c.lift >= 2).sort((a, b) => strength(b) - strength(a)).slice(0, 3);
  const downs = chips.filter((c) => c.lift <= 0.5).sort((a, b) => strength(b) - strength(a)).slice(0, 3);
  if (!ups.length && !downs.length) return null;
  const col = (cs: Chip[], up: boolean, head: string) => (
    <div className="pattern-col" data-up={up}>
      <h4>{head}</h4>
      {cs.length ? (
        <ul>
          {cs.map((c) => (
            <li key={c.key} title={c.tip}>
              <span>{c.label}</span>
              <span className="pattern-lift">{c.lift < 0.1 ? "almost never" : `${c.lift.toFixed(1)}× as often`}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
  return (
    <div className="patterns">
      <h3>Other things in the 10-K that mattered in past deals</h3>
      <p className="muted">Not part of the score above. How often companies whose 10-K read the same way went on to {what}, compared with the average company.</p>
      <div className="pattern-cols">{ups.length > 0 && col(ups, true, "Pointing toward a deal")}{downs.length > 0 && col(downs, false, "Pointing away from one")}</div>
    </div>
  );
}
