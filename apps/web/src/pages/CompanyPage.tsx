import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  fetchCompany, fetchPrices, fetchCompensation, fetchBoard,
  fetchInsider, fetch13D, fetchFinancials, fetchMismanagementScorecard,
  fetchMismanagementRank,
  type CompanyDetail, type PricePoint, type CompensationResponse,
  type BoardResponse, type InsiderTx, type ThirteenDFiling, type FinancialMetric,
  type MismanagementScorecard,
} from "../api.js";
import { MTSLogo } from "../components/MTSLogo.js";
import { FactSheet } from "../components/FactSheet.js";
import { PeerComparison } from "../components/PeerComparison.js";
import { fmtUsdCompact, fmtUsd, fmtCompact, fmtDate, fmtPctRaw } from "../lib/format.js";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

interface State {
  company: CompanyDetail | null;
  prices: PricePoint[] | null;
  comp: CompensationResponse | null;
  board: BoardResponse | null;
  insider: InsiderTx[] | null;
  thirteenD: ThirteenDFiling[] | null;
  financials: FinancialMetric[] | null;
  scorecard: MismanagementScorecard | null;
}

export function CompanyPage() {
  const { ticker = "" } = useParams<{ ticker: string }>();
  const [s, setS] = useState<State>({
    company: null, prices: null, comp: null, board: null,
    insider: null, thirteenD: null, financials: null, scorecard: null,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticker) return;
    setError(null);
    setS({ company: null, prices: null, comp: null, board: null, insider: null, thirteenD: null, financials: null, scorecard: null });

    fetchCompany(ticker)
      .then((company) => setS((prev) => ({ ...prev, company })))
      .catch((e: Error) => setError(e.message));

    // Fire the rest in parallel; null on failure so partial views work.
    Promise.allSettled([
      fetchPrices(ticker, 1300),
      fetchCompensation(ticker),
      fetchBoard(ticker),
      fetchInsider(ticker, 365),
      fetch13D(ticker),
      fetchFinancials(ticker),
      fetchMismanagementScorecard(ticker),
    ]).then(([p, c, b, i, t, f, sc]) => {
      setS((prev) => ({
        ...prev,
        prices: p.status === "fulfilled" ? p.value.prices : [],
        comp: c.status === "fulfilled" ? c.value : null,
        board: b.status === "fulfilled" ? b.value : null,
        insider: i.status === "fulfilled" ? i.value.transactions : [],
        thirteenD: t.status === "fulfilled" ? t.value.filings : [],
        financials: f.status === "fulfilled" ? f.value.metrics : [],
        scorecard: sc.status === "fulfilled" ? sc.value : null,
      }));
    });
  }, [ticker]);

  if (error) {
    return (
      <div className="company">
        <div className="error-state">Couldn't load {ticker}: {error}</div>
        <p style={{ marginTop: 24 }}>
          <Link to="/screen" className="nav-link" style={{ display: "inline-block" }}>Back to screen</Link>
        </p>
      </div>
    );
  }
  if (!s.company) return <div className="loading-state">Loading {ticker}…</div>;

  return (
    <div className="company">
      <ScorecardHero company={s.company} scorecard={s.scorecard} ticker={ticker} prices={s.prices} />
      <FactSheet ticker={ticker} />
      <PeerComparison ticker={ticker} />
      <FinancialsSection metrics={s.financials} />
      <BalanceSheetSection metrics={s.financials} />
      <CompSection comp={s.comp} />
      <BoardSection board={s.board} />
      <RelatedPartySection board={s.board} />
      <InsiderSection txs={s.insider} />
      <ThirteenDSection filings={s.thirteenD} />
    </div>
  );
}

// ── Scorecard hero (top-of-page) ────────────────────────────────────────
//
// Renders the 8-section share-card layout in document order:
//   1. brand bar — MTS glyph + eyebrow + filed-as-of date
//   2. company header — rank → ticker → italic name → meta
//   3. hero verdict — red N/8 + "flags fired" italic + source line
//   4. 8-flag grid — 4×2 tiles, fired = red dot + red wash
//   5. key numerics — market cap · TSR gap · insider TTM (3 cols)
//   6. evidence chips — one row per fired flag (letter · title · value)
//   7. mini sparkline — 5y adjusted close, yellow, with peak→latest
//   8. footer — canonical URL + CIK
// CSS locks mobile to the phone-card spec; desktop scales the same
// components up via media query (no separate desktop variant).

interface ScorecardCheck {
  short: string;
  letter: string;
  name: string;
  rule: string;
  fired: boolean;
  value: string;
}

function buildChecks(scorecard: MismanagementScorecard | null): ScorecardCheck[] | null {
  const r = scorecard?.row;
  if (!r) return null;
  const pct = (n: number) => `${n.toFixed(0)}%`;
  return [
    {
      short: "TSR", letter: "T", name: "Trailed peers",
      rule: "If you invested $100 in this company or invested $100 across its peers, which would give you a higher return?",
      fired: !!r.flag_tsr_under,
      value: r.years_tracked != null ? `${r.years_under ?? 0}/${r.years_tracked} yrs` : "—",
    },
    {
      short: "Pay", letter: "P", name: "Paid through it",
      rule: "Was the CEO still getting paid over $15 million while the company underperformed its peers?",
      fired: !!r.flag_pay_through_it,
      value: r.peo_median != null ? `${fmtUsdCompact(r.peo_median)} median` : "—",
    },
    {
      short: "13D", letter: "D", name: "Active 13D",
      rule: "Have any outside entities accumulated over 5% of the company in the past 18 months?",
      fired: !!r.flag_active_13d,
      value: r.active_13d_count > 0 ? `${r.active_13d_count} filing` : "none",
    },
    {
      short: "Insid", letter: "I", name: "Insider selling",
      rule: "Have the company's executives and insiders been buying or selling the company's equity?",
      fired: !!r.flag_insider_selling,
      value:
        r.insider_net_365d === 0
          ? "—"
          : `${r.insider_net_365d < 0 ? "−" : "+"}${fmtUsdCompact(Math.abs(r.insider_net_365d))}`,
    },
    {
      short: "Cash", letter: "C", name: "Earnings ≠ cash",
      rule: "Is the profit the company reports actually showing up as cash in the bank?",
      fired: !!r.flag_earnings_cash,
      value:
        r.ocf != null && r.net_income != null && r.net_income > 0
          ? `OCF ${pct((r.ocf / r.net_income) * 100)}`
          : "—",
    },
    {
      short: "SBC", letter: "S", name: "Dilutive SBC",
      rule: "Is the company giving away an unusually large slice of itself each year as employee stock compensation?",
      fired: !!r.flag_dilutive_sbc,
      value:
        r.sbc != null && r.revenue != null && r.revenue > 0
          ? `${pct((r.sbc / r.revenue) * 100)} of rev`
          : "—",
    },
    {
      short: "Cap", letter: "R", name: "Returns over OCF",
      rule: "Is the company spending more on buybacks and dividends than the cash it actually generates from operations?",
      fired: !!r.flag_returns_over_fcf,
      value:
        r.ocf != null
          ? `${fmtUsdCompact((r.buybacks ?? 0) + (r.dividends_paid ?? 0))} vs OCF`
          : "—",
    },
    {
      short: "GW", letter: "G", name: "Goodwill heavy",
      rule: "Has the company spent so much buying other businesses that the premium it paid for them now dominates its balance sheet?",
      fired: !!r.flag_goodwill_heavy,
      value:
        r.goodwill != null && r.total_assets != null && r.total_assets > 0
          ? `${pct((r.goodwill / r.total_assets) * 100)} of assets`
          : "—",
    },
    {
      short: "Vote", letter: "V", name: "Vote dissent",
      rule: "At the last annual meeting, did shareholders meaningfully push back against executive pay or any specific director?",
      fired: !!r.flag_governance_dissent,
      value:
        r.latest_sop_support_pct != null || r.latest_min_director_support_pct != null
          ? `SoP ${r.latest_sop_support_pct != null ? pct(r.latest_sop_support_pct) : "—"} / dir ${r.latest_min_director_support_pct != null ? pct(r.latest_min_director_support_pct) : "—"}`
          : "—",
    },
  ];
}

function ScorecardHero({
  company,
  scorecard,
  ticker,
  prices,
}: {
  company: CompanyDetail;
  scorecard: MismanagementScorecard | null;
  ticker: string;
  prices: PricePoint[] | null;
}) {
  const [rank, setRank] = useState<number | null>(null);
  const [universe, setUniverse] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  // Hidden render target for the downloadable share image. Lives outside
  // the live page layout (positioned off-screen) so the live card can have
  // one design and the downloaded PNG can have a different one.
  const shareImageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchMismanagementRank(ticker)
      .then((r) => { setRank(r.rank); setUniverse(r.total); })
      .catch(() => {});
  }, [ticker]);

  const checks = buildChecks(scorecard);
  const fired = checks ? checks.filter((c) => c.fired).length : 0;
  const r = scorecard?.row;
  const tsrGap =
    r?.latest_peer_tsr != null && r?.latest_company_tsr != null
      ? r.latest_peer_tsr - r.latest_company_tsr
      : null;

  const today = new Date()
    .toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    .toUpperCase();

  async function downloadCard() {
    const node = shareImageRef.current;
    if (!node) return;
    setDownloading(true);
    try {
      // Wait two frames for any pending layout/font load, then capture the
      // hidden share-image node directly (it's already off-screen at the
      // intended share dimensions). No clone needed since the source isn't
      // visible to the user — we can capture it in place.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (document.fonts?.ready) await document.fonts.ready;
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(node, {
        pixelRatio: 2,
        backgroundColor: "#0e0e10",
        cacheBust: true,
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${ticker}-mismanagement.png`;
      a.click();
    } catch (e) {
      console.error("download failed", e);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="ch-wrap">
      {/* Hidden share-image render target. The OFF-SCREENING lives on the
          wrapper, not on .share-card itself — html-to-image carries any
          inline positioning on the captured node into the resulting SVG's
          foreignObject, so a `left: -100000px` on the node would render
          the content outside the SVG viewport (resulting in an entirely
          black PNG). The wrapper handles invisibility; the card stays at
          natural 0,0 coordinates for capture. */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          left: "-100000px",
          top: 0,
          width: 0,
          height: 0,
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
      <div ref={shareImageRef} className="share-card">
        <header className="share-brand">
          <div className="share-brand-left">
            <MTSLogo size={22} />
          </div>
          <span className="share-brand-date">{today}</span>
        </header>
        <section className="share-hero">
          <div className="share-eyebrow">
            {rank != null ? <span className="share-rank">Rank #{rank}</span> : null}
            {universe ? <span>of {universe.toLocaleString()} R3K</span> : null}
            {company.sic_description ? <span>{company.sic_description}</span> : null}
          </div>
          <h1 className="share-ticker">{company.ticker}</h1>
          <div className="share-chips">
            {company.is_russell_3000 ? <span className="share-chip">Russell 3000</span> : null}
            {company.fiscal_year_end ? <span className="share-chip">FY end {company.fiscal_year_end}</span> : null}
            <span className="share-chip">{fmtUsdCompact(company.market_cap_at_universe_pull)} mkt cap</span>
          </div>
          <div className="share-kpis">
            <div className="share-kpi">
              <span className={`share-kpi-n ${fired >= 5 ? "hot" : ""}`}>
                {fired}<span className="share-kpi-of">/{checks?.length ?? 9}</span>
              </span>
              <span className="share-kpi-l">flags fired</span>
            </div>
            <div className="share-kpi">
              <span className={`share-kpi-n ${tsrGap != null && tsrGap > 0 ? "neg" : ""}`}>
                {tsrGap == null ? "—" : tsrGap > 0 ? `−$${tsrGap.toFixed(0)}` : `+$${(-tsrGap).toFixed(0)}`}
              </span>
              <span className="share-kpi-l">TSR gap / $100</span>
            </div>
            <div className="share-kpi">
              <span className={`share-kpi-n ${r && r.insider_net_365d < 0 ? "neg" : ""}`}>
                {!r || r.insider_net_365d === 0
                  ? "—"
                  : `${r.insider_net_365d < 0 ? "−" : "+"}${fmtUsdCompact(Math.abs(r.insider_net_365d))}`}
              </span>
              <span className="share-kpi-l">insider 12-mo</span>
            </div>
          </div>
        </section>
        {checks ? (
          <section className="share-flags">
            <h2 className="share-section-h">What fired</h2>
            <div className="share-flag-list">
              {checks.filter((c) => c.fired).length === 0 ? (
                <div className="share-flag-clean">No red flags fired — clean scorecard.</div>
              ) : (
                checks
                  .filter((c) => c.fired)
                  .map((c) => (
                    <div key={c.short} className="share-flag-row">
                      <span className="share-flag-dot" />
                      <span className="share-flag-name">{c.name}</span>
                      <span className="share-flag-value">{c.value}</span>
                    </div>
                  ))
              )}
            </div>
          </section>
        ) : null}
        <footer className="share-foot">
          <span>mts.report/mismanagement/{ticker.toLowerCase()}</span>
          <span>CIK {company.cik}</span>
        </footer>
      </div>
      </div>

      <div className="ch-actions">
        <button
          type="button"
          className="ch-download"
          onClick={downloadCard}
          disabled={downloading || !checks}
          aria-label="Download scorecard as PNG"
        >
          {downloading ? "Rendering…" : "Download card"}
        </button>
      </div>
      <article className="ch" ref={cardRef}>
      {/* 1 — brand bar */}
      <header className="ch-brand">
        <div className="ch-brand-left">
          <MTSLogo size={18} />
        </div>
        <span className="ch-brand-date">{today}</span>
      </header>

      {/* 2 — company header */}
      <section className="ch-company">
        <div className="ch-rank">
          {rank != null ? (
            <>
              Rank #{rank}
              {universe ? <span className="ch-rank-of"> of {universe.toLocaleString()} tracked</span> : null}
            </>
          ) : (
            <span className="ch-rank-of">Mismanagement scorecard</span>
          )}
        </div>
        <h1 className="ch-ticker">{company.ticker}</h1>
      </section>

      {checks ? (
        <>
          {/* 3 — hero verdict */}
          <section className={`ch-verdict ${fired >= 5 ? "ch-verdict--hot" : ""}`}>
            <div className="ch-verdict-num">
              <strong>{fired}</strong>
              <span>/{checks.length}</span>
            </div>
            <div className="ch-verdict-right">
              <span className="ch-verdict-text">flags fired</span>
            </div>
          </section>

          {/* 4 — 3x3 scorecard grid (desktop view + downloaded card).
                  Each tile renders both the curt name (for the card) and
                  the full question (for the live desktop page); CSS picks
                  which one is visible based on .ch-card-mode. */}
          <section className="ch-grid-section">
            <h2 className="ch-eyebrow">THE SCORECARD</h2>
            <div className="ch-grid">
              {checks.map((c) => (
                <div key={c.short} className={`ch-tile ${c.fired ? "ch-tile--fired" : ""}`}>
                  <span className="ch-tile-row">
                    <span className="ch-tile-dot" />
                    <span className="ch-tile-label">{c.short}</span>
                  </span>
                  <span className="ch-tile-name">{c.name}</span>
                  <p className="ch-tile-rule">{c.rule}</p>
                  <span className="ch-tile-value">{c.value}</span>
                </div>
              ))}
            </div>
          </section>

          {/* 5 — key numerics */}
          <section className="ch-numerics">
            <div className="ch-numeric">
              <span className="ch-numeric-label">MARKET CAP</span>
              <span className="ch-numeric-value">
                {fmtUsdCompact(company.market_cap_at_universe_pull)}
              </span>
            </div>
            <div className="ch-numeric">
              <span className="ch-numeric-label">TSR GAP</span>
              <span className={`ch-numeric-value ${tsrGap != null && tsrGap > 0 ? "neg" : ""}`}>
                {tsrGap == null
                  ? "—"
                  : tsrGap > 0
                  ? `−$${tsrGap.toFixed(0)}`
                  : `+$${(-tsrGap).toFixed(0)}`}
              </span>
            </div>
            <div className="ch-numeric">
              <span className="ch-numeric-label">INSIDER 12-MO</span>
              <span className={`ch-numeric-value ${r && r.insider_net_365d < 0 ? "neg" : ""}`}>
                {!r || r.insider_net_365d === 0
                  ? "—"
                  : `${r.insider_net_365d < 0 ? "−" : "+"}${fmtUsdCompact(Math.abs(r.insider_net_365d))}`}
              </span>
            </div>
          </section>

          {/* 6 — plain-English row explainers, collapsable on mobile */}
          <details className="ch-checks-details" open>
            <summary className="ch-checks-summary">
              <span className="ch-checks-summary-label">What each flag means</span>
              <span className="ch-checks-summary-caret">▾</span>
            </summary>
            <section className="ch-checks">
              {checks.map((c) => (
                <div
                  key={c.short}
                  className={`ch-check ${c.fired ? "ch-check--fired" : ""}`}
                >
                  <span className="ch-check-dot" />
                  <div className="ch-check-body">
                    <p className="ch-check-rule">{c.rule}</p>
                    <span className="ch-check-value">{c.value}</span>
                  </div>
                </div>
              ))}
            </section>
          </details>
        </>
      ) : null}

      {/* 7 — mini sparkline */}
      <section className="ch-spark">
        <div className="ch-spark-head">
          <span className="ch-eyebrow">5Y ADJUSTED CLOSE</span>
          <ChSparkDelta prices={prices ?? []} />
        </div>
        <ChSpark prices={prices ?? []} />
      </section>

      {/* 8 — footer */}
      <footer className="ch-foot">
        <span>mts.report/mismanagement/{ticker.toLowerCase()}</span>
        <span>CIK {company.cik}</span>
      </footer>
      </article>
    </div>
  );
}

function ChSparkDelta({ prices }: { prices: PricePoint[] }) {
  if (prices.length < 2) return <span className="ch-spark-pl">—</span>;
  const closes = prices.map((p) => p.adj_close);
  const peak = Math.max(...closes);
  const latest = closes[closes.length - 1]!;
  return (
    <span className="ch-spark-pl">
      Peak ${peak.toFixed(0)}, now ${latest.toFixed(0)}
    </span>
  );
}

function ChSpark({ prices }: { prices: PricePoint[] }) {
  if (prices.length < 2)
    return <div className="ch-spark-empty">No price history</div>;

  // Down-sample to ~260 points so 1300-point datasets don't bog the chart.
  const data = sample(prices, 260).map((p) => ({
    date: p.trading_date,
    close: p.adj_close,
  }));
  const ys = data.map((d) => d.close);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pad = (maxY - minY) * 0.05 || 1;

  return (
    <div className="ch-spark-chart">
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="ch-spark-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "var(--ink-mute)", fontSize: 10 }}
            tickFormatter={(d: string) => d.slice(0, 7)}
            minTickGap={60}
            stroke="var(--rule)"
          />
          <YAxis
            domain={[minY - pad, maxY + pad]}
            tick={{ fill: "var(--ink-mute)", fontSize: 10 }}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
            width={48}
            stroke="var(--rule)"
          />
          <Tooltip
            contentStyle={{
              background: "var(--bg-1)",
              border: "1px solid var(--rule)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--ink)",
            }}
            labelStyle={{ color: "var(--ink-mute)" }}
            formatter={(v) => [`$${Number(v).toFixed(2)}`, "Adj close"]}
            labelFormatter={(d) => String(d)}
          />
          <Area
            type="monotone"
            dataKey="close"
            stroke="var(--accent)"
            strokeWidth={2}
            fill="url(#ch-spark-grad)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]!);
  out.push(arr[arr.length - 1]!);
  return out;
}

function RelatedPartySection({ board }: { board: BoardResponse | null }) {
  if (!board || board.related_party.length === 0) return null;
  return (
    <section className="section">
      <h2 className="section-title">Related-party transactions</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Counterparties</th>
            <th>Description</th>
            <th>Amount / terms</th>
          </tr>
        </thead>
        <tbody>
          {board.related_party.map((r, i) => (
            <tr key={`${r.description.slice(0, 40)}-${i}`}>
              <td><strong>{(r.parties ?? []).join(", ") || "—"}</strong></td>
              <td style={{ color: "var(--ink-dim)" }}>{r.description}</td>
              <td className="numeric">{r.amount_or_terms || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ── Balance sheet snapshot (point-in-time, fiscal_year = -1) ─────────────

const BALANCE_SHEET_CONCEPTS: { key: string; label: string }[] = [
  { key: "total_assets_latest", label: "Total assets" },
  { key: "total_equity_latest", label: "Total equity" },
  { key: "cash_latest", label: "Cash & equivalents" },
  { key: "long_term_debt_latest", label: "Long-term debt" },
  { key: "short_term_debt_latest", label: "Short-term debt" },
  { key: "goodwill_latest", label: "Goodwill" },
  { key: "accounts_receivable_latest", label: "Accounts receivable" },
  { key: "inventory_latest", label: "Inventory" },
];

function BalanceSheetSection({ metrics }: { metrics: FinancialMetric[] | null }) {
  if (metrics == null) return null;
  const pit = new Map<string, number>();
  for (const m of metrics) {
    if (m.fiscal_year === -1) pit.set(m.concept, m.value);
  }
  const rows = BALANCE_SHEET_CONCEPTS.filter((c) => pit.has(c.key));
  if (rows.length === 0) return null;
  return (
    <section className="section">
      <h2 className="section-title">Balance sheet — most recent quarter</h2>
      <table className="data-table">
        <tbody>
          {rows.map((c) => (
            <tr key={c.key}>
              <td>{c.label}</td>
              <td className="numeric">{fmtUsdCompact(pit.get(c.key)!)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ── Financials ───────────────────────────────────────────────────────────

// financial_metrics.concept stores LOGICAL names (see pull-edgar.ts
// annualConcepts). Headline rows for the per-company financials grid:
const HEADLINE_CONCEPTS: { key: string; label: string }[] = [
  { key: "revenue", label: "Revenue" },
  { key: "gross_profit", label: "Gross profit" },
  { key: "operating_income", label: "Operating income" },
  { key: "net_income", label: "Net income" },
  { key: "operating_cash_flow", label: "Operating cash flow" },
  { key: "capex", label: "Capex" },
  { key: "sbc", label: "Stock-based comp" },
  { key: "buybacks", label: "Buybacks" },
  { key: "dividends_paid", label: "Dividends paid" },
];

function FinancialsSection({ metrics }: { metrics: FinancialMetric[] | null }) {
  if (metrics == null) {
    return (
      <section className="section">
        <h2 className="section-title">Financials</h2>
        <div className="loading-state">Loading…</div>
      </section>
    );
  }
  if (metrics.length === 0) {
    return (
      <section className="section">
        <h2 className="section-title">Financials</h2>
        <div className="empty-state">No financial metrics — run pull-edgar</div>
      </section>
    );
  }
  // Annual rows only (fiscal_year > 0). The latest-balance-sheet point-in-
  // time rows use fiscal_year = -1 as a sentinel and shouldn't appear in
  // an annual grid.
  const annual = metrics.filter((m) => m.fiscal_year > 0);
  const present = new Set(annual.map((m) => m.concept));
  const visibleConcepts = HEADLINE_CONCEPTS.filter((c) => present.has(c.key));
  const years = Array.from(new Set(annual.map((m) => m.fiscal_year)))
    .sort((a, b) => b - a)
    .slice(0, 5);

  if (visibleConcepts.length === 0 || years.length === 0) {
    return (
      <section className="section">
        <h2 className="section-title">Financials</h2>
        <div className="empty-state">
          No annual financial metrics for the canonical concept set — issuer may be a foreign filer or recent IPO.
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      <h2 className="section-title">Financials — latest fiscal years</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Line item</th>
            {years.map((y) => <th key={y} className="numeric">FY {y}</th>)}
          </tr>
        </thead>
        <tbody>
          {visibleConcepts.map((c) => (
            <tr key={c.key}>
              <td>{c.label}</td>
              {years.map((y) => {
                const m = annual.find((x) => x.concept === c.key && x.fiscal_year === y);
                return (
                  <td key={y} className="numeric">
                    {m == null ? "—" : fmtUsdCompact(m.value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ── Compensation ─────────────────────────────────────────────────────────

function CompSection({ comp }: { comp: CompensationResponse | null }) {
  if (comp == null) {
    return (
      <section className="section">
        <h2 className="section-title">NEO compensation</h2>
        <div className="loading-state">Loading…</div>
      </section>
    );
  }
  if (comp.summary_compensation.length === 0) {
    return (
      <section className="section">
        <h2 className="section-title">NEO compensation</h2>
        <div className="empty-state">No DEF 14A extracted yet — run extract-proxy</div>
      </section>
    );
  }

  return (
    <>
      <section className="section">
        <h2 className="section-title">
          NEO compensation
          {comp.source.fiscal_year_covered ? ` — proxy covered FY ${comp.source.fiscal_year_covered}` : ""}
        </h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Title</th>
              <th className="numeric">Year</th>
              <th className="numeric">Salary</th>
              <th className="numeric">Bonus</th>
              <th className="numeric">Stock</th>
              <th className="numeric">Options</th>
              <th className="numeric">NEI</th>
              <th className="numeric">AOC</th>
              <th className="numeric">Total</th>
            </tr>
          </thead>
          <tbody>
            {comp.summary_compensation.map((row) => (
              <tr key={`${row.name}-${row.fiscal_year}`}>
                <td><strong>{row.name}</strong></td>
                <td>{row.title}</td>
                <td className="numeric">{row.fiscal_year}</td>
                <td className="numeric">{fmtUsd(row.salary)}</td>
                <td className="numeric">{fmtUsd(row.bonus)}</td>
                <td className="numeric">{fmtUsd(row.stock_awards)}</td>
                <td className="numeric">{fmtUsd(row.option_awards)}</td>
                <td className="numeric">{fmtUsd(row.non_equity_incentive)}</td>
                <td className="numeric">{fmtUsd(row.all_other_compensation)}</td>
                <td className="numeric"><strong>{fmtUsd(row.total)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {comp.pay_vs_performance.length > 0 ? (
        <section className="section">
          <h2 className="section-title">Pay vs. performance</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th className="numeric">FY</th>
                <th className="numeric">PEO comp paid</th>
                <th className="numeric">NEO avg paid</th>
                <th className="numeric">Co. TSR (indexed)</th>
                <th className="numeric">Peer TSR (indexed)</th>
                <th className="numeric">GAAP NI</th>
              </tr>
            </thead>
            <tbody>
              {comp.pay_vs_performance.map((row) => (
                <tr key={row.fiscal_year}>
                  <td className="numeric">{row.fiscal_year}</td>
                  <td className="numeric">{fmtUsd(row.peo_compensation_actually_paid)}</td>
                  <td className="numeric">{fmtUsd(row.non_peo_neo_avg_compensation_actually_paid)}</td>
                  <td className="numeric">
                    {row.company_tsr_indexed == null ? "—" : `$${row.company_tsr_indexed.toFixed(0)}`}
                  </td>
                  <td className="numeric">
                    {row.peer_group_tsr_indexed == null ? "—" : `$${row.peer_group_tsr_indexed.toFixed(0)}`}
                  </td>
                  <td className="numeric">{fmtUsdCompact(row.gaap_net_income)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}

// ── Board ────────────────────────────────────────────────────────────────

function BoardSection({ board }: { board: BoardResponse | null }) {
  if (board == null) {
    return (
      <section className="section">
        <h2 className="section-title">Board</h2>
        <div className="loading-state">Loading…</div>
      </section>
    );
  }
  if (board.directors.length === 0) {
    return (
      <section className="section">
        <h2 className="section-title">Board</h2>
        <div className="empty-state">No directors extracted yet</div>
      </section>
    );
  }

  return (
    <>
      <section className="section">
        <h2 className="section-title">Board</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="numeric">Age</th>
              <th className="numeric">Since</th>
              <th>Role</th>
              <th>Committees</th>
              <th>Other boards</th>
              <th className="numeric">Total comp</th>
            </tr>
          </thead>
          <tbody>
            {board.directors.map((d) => (
              <tr key={d.name}>
                <td>
                  <strong>{d.name}</strong>
                  {d.attendance_below_75pct ? <span className="tag neg" style={{ marginLeft: 8 }}>&lt;75% attend</span> : null}
                </td>
                <td className="numeric">{d.age ?? "—"}</td>
                <td className="numeric">{d.director_since_year ?? "—"}</td>
                <td>
                  {d.is_chair ? <span className="tag" style={{ marginRight: 4 }}>Chair</span> : null}
                  {d.is_lead_independent_director ? <span className="tag" style={{ marginRight: 4 }}>LID</span> : null}
                  {d.independent ? <span className="tag pos">Indep</span> : <span className="tag">—</span>}
                </td>
                <td>{(d.committees ?? []).join(", ") || "—"}</td>
                <td>{(d.other_public_boards ?? []).join(", ") || "—"}</td>
                <td className="numeric">{fmtUsd(d.total_compensation)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {board.ownership.length > 0 ? (
        <section className="section">
          <h2 className="section-title">Beneficial ownership</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Holder</th>
                <th>Type</th>
                <th className="numeric">Shares</th>
                <th className="numeric">% of class</th>
              </tr>
            </thead>
            <tbody>
              {board.ownership.map((o) => (
                <tr key={`${o.name}-${o.holder_type}`}>
                  <td><strong>{o.name}</strong></td>
                  <td>{o.holder_type}</td>
                  <td className="numeric">{fmtCompact(o.shares)}</td>
                  <td className="numeric">{fmtPctRaw(o.percent_class)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}

// ── Insider activity ─────────────────────────────────────────────────────

const TX_LABELS: Record<string, string> = {
  P: "Open-market buy", S: "Open-market sell", A: "Award", M: "Exercise",
  F: "Tax with shares", D: "Sale to issuer", G: "Gift", X: "ITM exercise", J: "Other",
};

function InsiderSection({ txs }: { txs: InsiderTx[] | null }) {
  if (txs == null) {
    return (
      <section className="section">
        <h2 className="section-title">Insider activity</h2>
        <div className="loading-state">Loading…</div>
      </section>
    );
  }
  if (txs.length === 0) {
    return (
      <section className="section">
        <h2 className="section-title">Insider activity</h2>
        <div className="empty-state">No Form 4 transactions in the last year</div>
      </section>
    );
  }

  return (
    <section className="section">
      <h2 className="section-title">Insider activity — last 365 days</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Insider</th>
            <th>Title</th>
            <th>Action</th>
            <th className="numeric">Shares</th>
            <th className="numeric">Price</th>
            <th className="numeric">Value</th>
            <th>Plan</th>
          </tr>
        </thead>
        <tbody>
          {txs.slice(0, 50).map((t, i) => {
            const isBuy = t.transaction_code === "P" || t.acquired_or_disposed === "A";
            return (
              <tr key={`${t.transaction_date}-${t.insider_name}-${i}`}>
                <td>{fmtDate(t.transaction_date)}</td>
                <td><strong>{t.insider_name}</strong></td>
                <td>{t.officer_title ?? (t.is_director ? "Director" : "")}</td>
                <td>
                  <span className={`tag ${isBuy ? "pos" : "neg"}`}>
                    {TX_LABELS[t.transaction_code] ?? t.transaction_code}
                    {t.derivative ? " (deriv)" : ""}
                  </span>
                </td>
                <td className="numeric">{fmtCompact(t.shares)}</td>
                <td className="numeric">
                  {t.price_per_share == null ? "—" : `$${t.price_per_share.toFixed(2)}`}
                </td>
                <td className="numeric">{fmtUsdCompact(t.transaction_value)}</td>
                <td>{t.ten_b_5_one_plan ? <span className="tag">10b5-1</span> : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {txs.length > 50 ? <p className="screen-sub" style={{ marginTop: 12 }}>… {txs.length - 50} more not shown</p> : null}
    </section>
  );
}

// ── 13D filings ─────────────────────────────────────────────────────────

function ThirteenDSection({ filings }: { filings: ThirteenDFiling[] | null }) {
  if (filings == null) {
    return (
      <section className="section">
        <h2 className="section-title">13D / 13G filings</h2>
        <div className="loading-state">Loading…</div>
      </section>
    );
  }
  if (filings.length === 0) {
    return (
      <section className="section">
        <h2 className="section-title">13D / 13G filings</h2>
        <div className="empty-state">No stake disclosures filed against this issuer</div>
      </section>
    );
  }

  return (
    <section className="section">
      <h2 className="section-title">13D / 13G filings</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>Filed</th>
            <th>Form</th>
            <th>Filer</th>
            <th className="numeric">% stake</th>
            <th>Intent</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {filings.map((f) => (
            <tr key={f.accession_number}>
              <td>{fmtDate(f.filing_date)}</td>
              <td>{f.form}</td>
              <td><strong>{f.filer_name}</strong></td>
              <td className="numeric">{fmtPctRaw(f.aggregate_percent)}</td>
              <td>
                {f.is_active_intent ? <span className="tag neg">Active</span> : <span className="tag">Passive</span>}
              </td>
              <td>
                {f.cooperation_agreement_present ? <span className="tag" style={{ marginRight: 4 }}>Coop agmt</span> : null}
                {f.standstill_present ? <span className="tag" style={{ marginRight: 4 }}>Standstill</span> : null}
                {f.purpose_summary
                  ? <span style={{ color: "var(--ink-dim)" }}>{f.purpose_summary.slice(0, 140)}{f.purpose_summary.length > 140 ? "…" : ""}</span>
                  : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
