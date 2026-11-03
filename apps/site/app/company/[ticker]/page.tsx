import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { app } from "@takeover/api";
import { fmtDate, fmtUsd } from "@/lib/format";
import { TickerName } from "@/lib/ticker";
import { SITE_URL } from "@/lib/site";
import { SIGNAL_LABELS, SIGNAL_RULES, signalEvidence, signalMeasure, type SignalGroup } from "@/lib/signals";
import { Delta, Meter, Sparkline } from "@/lib/charts";

export const revalidate = 21600;
// Render on first request, then cache; ~2.5K tickers is too many to prebuild.
export const dynamicParams = true;
export async function generateStaticParams() {
  return [];
}

type Num = number | null;
interface Profile {
  company: { ticker: string; name: string; sic: string | null; sic_description: string | null; market_cap: Num; is_russell_3000: boolean };
  groups: SignalGroup[];
  scores: (Record<string, unknown> & { takeover_score?: number }) | null;
  financials: { years: number[]; series: Record<string, Record<number, number>>; latest: Record<string, number> };
  derived: { fiscal_year: Num; ebitda: Num; net_debt: Num; net_debt_to_ebitda: Num; revenue_per_employee: Num; ai_mentions_per_10k_words: Num };
  headcount: { fiscal_year: number; employees: number; matched_text: string } | null;
  deals: { accession_number: string; form: string; filing_date: string; acquirer: string | null; matched_buyer: string | null; price_per_share: Num; premium_pct: Num; document_url: string }[];
  pay_vs_performance: { fiscal_year: number; peo_total_comp: Num; peo_compensation_actually_paid: Num; company_tsr_indexed: Num; peer_group_tsr_indexed: Num }[];
  insiders_365d: { buys: number; sells: number; buy_count: number; sell_count: number };
  thirteen_d: { accession_number: string; form: string; filing_date: string; filer_name: string; aggregate_percent: Num; is_active_intent: boolean | null }[];
}

// cache(): generateMetadata and the page share one read per request.
const getProfile = cache(async (ticker: string): Promise<Profile | null> => {
  const res = await app.request(`/api/companies/${encodeURIComponent(ticker)}/profile`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`profile ${ticker}: ${res.status}`);
  return (await res.json()) as Profile;
});

const FIN_ROWS: [string, string][] = [
  ["revenue", "Revenue"],
  ["operating_income", "Operating income"],
  ["net_income", "Net income"],
  ["operating_cash_flow", "Operating cash flow"],
  ["capex", "Capex"],
  ["sbc", "Stock-based comp"],
  ["buybacks", "Buybacks"],
  ["dividends_paid", "Dividends"],
];


export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }): Promise<Metadata> {
  const { ticker } = await params;
  const p = await getProfile(ticker);
  if (!p) return { title: ticker.toUpperCase(), robots: { index: false } };
  const { company: co } = p;
  const all = p.groups.flatMap((g) => g.signals);
  const fired = p.scores ? all.filter((k) => p.scores![k] === true) : [];
  const scoreText = p.scores
    ? fired.length
      ? `Takeover score ${fired.length} of ${all.length}: ${fired.map((k) => lowerFirst(SIGNAL_LABELS[k]!)).join(", ")}.`
      : `Takeover score 0 of ${all.length}.`
    : "";
  const fy = p.financials.years.at(-1);
  const rev = fy != null ? p.financials.series.revenue?.[fy] : undefined;
  const facts = [
    rev != null ? `FY${fy} revenue ${fmtUsd(rev)}` : null,
    p.headcount ? `${p.headcount.employees.toLocaleString("en-US")} employees` : null,
    p.deals.some((x) => x.form !== "8-K") ? "deal filings on record" : null,
  ].filter(Boolean).join(", ");
  const title = `${co.name} (${co.ticker}) takeover score`;
  const description = `${co.name} (${co.ticker}) takeover attractiveness from SEC filings. ${scoreText}${facts ? ` ${facts[0]!.toUpperCase()}${facts.slice(1)}.` : ""}`;
  const path = `/company/${co.ticker}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", url: path, title, description },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function CompanyPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const p = await getProfile(ticker);
  if (!p) notFound();
  const { company: co, financials: fin, derived: d } = p;
  const yrs = fin.years;
  const yl = yrs.map((y) => `FY${y}`);
  const col = (k: string) => yrs.map((y) => fin.series[k]?.[y] ?? null);
  const revenue = col("revenue");
  const ebitda = yrs.map((y) => {
    const oi = fin.series.operating_income?.[y];
    return oi == null ? null : oi + (fin.series.depreciation_amortization?.[y] ?? 0);
  });
  const margin = yrs.map((y, i) => {
    const oi = fin.series.operating_income?.[y];
    return oi != null && revenue[i] ? oi / revenue[i]! : null;
  });
  const last = (a: (number | null)[]) => a.at(-1) ?? null;
  const prev = (a: (number | null)[]) => a.at(-2) ?? null;
  const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

  return (
    <main className="page company">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebPage",
        url: `${SITE_URL}/company/${co.ticker}`,
        name: `${co.name} (${co.ticker}) takeover score`,
        about: {
          "@type": "Corporation",
          name: co.name,
          tickerSymbol: co.ticker,
          ...(p.headcount ? { numberOfEmployees: { "@type": "QuantitativeValue", value: p.headcount.employees } } : {}),
          ...(co.sic_description ? { industry: co.sic_description } : {}),
        },
      }) }} />
      <header className="co-head">
        <div className="co-id">
          <h1><TickerName ticker={co.ticker} name={co.name} link={false} /></h1>
          {co.sic_description && <p className="muted">{titleCase(co.sic_description)}</p>}
        </div>
        <dl className="stat-strip">
          <TrendStat label="Revenue" value={fmtUsd(last(revenue))}
            delta={<Delta now={last(revenue)} prev={prev(revenue)} />}
            spark={<Sparkline values={revenue} labels={yl} format={fmtUsd} />} />
          <TrendStat label="Operating margin" value={last(margin) != null ? fmtPct(last(margin)!) : "—"}
            delta={<Delta now={last(margin)} prev={prev(margin)} />}
            spark={<Sparkline values={margin} labels={yl} format={fmtPct} />} />
          <TrendStat label="EBITDA" value={fmtUsd(last(ebitda))}
            delta={<Delta now={last(ebitda)} prev={prev(ebitda)} />}
            spark={<Sparkline values={ebitda} labels={yl} format={fmtUsd} />} />
          <TrendStat label="Market cap" value={fmtUsd(co.market_cap)} />
          <TrendStat label="Employees" value={p.headcount ? p.headcount.employees.toLocaleString("en-US") : "—"}
            title={p.headcount?.matched_text}
            sub={d.revenue_per_employee != null ? `${fmtUsd(d.revenue_per_employee)} revenue each` : undefined} />
          <TrendStat label="Net debt / EBITDA" value={d.net_debt_to_ebitda != null ? `${d.net_debt_to_ebitda.toFixed(1)}×` : "—"}
            sub={d.net_debt != null ? `${fmtUsd(d.net_debt)} net debt` : undefined} />
          <TrendStat label="AI in 10-K" value={d.ai_mentions_per_10k_words != null ? d.ai_mentions_per_10k_words.toFixed(1) : "—"}
            sub={d.ai_mentions_per_10k_words != null ? "mentions per 10K words" : undefined} />
        </dl>
      </header>

      <section aria-labelledby="score-h" className="score-head">
        <h2 id="score-h">
          Takeover score{" "}
          {p.scores && <span className="score-value">{p.scores.takeover_score ?? 0}<span className="muted"> of {p.groups.reduce((n, g) => n + g.signals.length, 0)}</span></span>}
        </h2>
      </section>

      {p.groups.map((g) => (
        <section key={g.key} aria-labelledby={`${g.key}-h`}>
          <h3 id={`${g.key}-h`} className="group-h">
            {g.label}{" "}
            {p.scores && <span className="muted">{g.signals.filter((k) => p.scores![k] === true).length} of {g.signals.length}</span>}
          </h3>
          <SignalGrid keys={g.signals} scores={p.scores} marketCap={co.market_cap} />
        </section>
      ))}

        <section id="financials">
          <h2>Financials</h2>
          {fin.years.length === 0 ? (
            <p className="muted">No XBRL financials yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col"><span className="sr-only">Metric</span></th>
                    {fin.years.map((y, i) => <th key={y} className={`num${i < fin.years.length - 3 ? " old-year" : ""}`} scope="col">FY{y}</th>)}
                    <th className="num" scope="col">YoY</th>
                    <th scope="col" className="hide-narrow"><span className="sr-only">Trend</span></th>
                  </tr>
                </thead>
                <tbody>
                  {FIN_ROWS.filter(([k]) => fin.series[k]).map(([k, label]) => (
                    <tr key={k}>
                      <th scope="row" className="row-head">{label}</th>
                      {fin.years.map((y, i) => <td key={y} className={`num${i < fin.years.length - 3 ? " old-year" : ""}`}>{fmtUsd(fin.series[k]?.[y])}</td>)}
                      <td className="num"><Delta now={last(col(k))} prev={prev(col(k))} suffix=""
                        goodWhenUp={!["capex", "sbc"].includes(k)} /></td>
                      <td className="hide-narrow"><Sparkline values={col(k)} labels={yl} format={fmtUsd} width={80} height={22} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section id="deals">
          <h2>Deal filings</h2>
          {p.deals.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <div className="table-wrap">
              <table className="data stack-narrow">
                <thead>
                  <tr><th>Filed</th><th>Form</th><th>Acquirer</th><th className="num">Price</th><th className="num">Premium</th></tr>
                </thead>
                <tbody>
                  {p.deals.map((x) => (
                    <tr key={x.accession_number} data-terms={x.price_per_share != null || x.premium_pct != null}>
                      <td className="date muted" data-slot="date">{fmtDate(x.filing_date)}</td>
                      <td data-slot="form"><a href={x.document_url} rel="noopener">{x.form}</a></td>
                      <td data-slot="by">{x.acquirer ?? (x.matched_buyer ? <span className="muted">Mentions {x.matched_buyer}</span> : "—")}</td>
                      <td className="num" data-slot="price">{x.price_per_share != null ? `$${x.price_per_share.toFixed(2)}` : "—"}</td>
                      <td className="num" data-slot="prem">{x.premium_pct != null ? `${x.premium_pct}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section id="holders">
          <h2>13D filers</h2>
          {p.thirteen_d.length === 0 ? (
            <p className="muted">None on file.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Filed</th><th>Filer</th><th>Form</th><th className="num">Stake</th><th>Intent</th></tr></thead>
                <tbody>
                  {p.thirteen_d.map((x) => (
                    <tr key={x.accession_number}>
                      <td className="date muted">{fmtDate(x.filing_date)}</td>
                      <td>{x.filer_name}</td>
                      <td>{x.form}</td>
                      <td className="num">{x.aggregate_percent != null ? `${x.aggregate_percent.toFixed(1)}%` : "—"}</td>
                      <td>{x.is_active_intent ? "Active" : "Passive"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section id="insiders">
          <h2>Insider trading</h2>
          {p.insiders_365d.buy_count + p.insiders_365d.sell_count === 0 ? (
            <p className="muted">No open-market trades in the last 12 months.</p>
          ) : (
            <dl className="stat-row">
              <Fact label="Open-market buys, 12 mo" value={`${fmtUsd(p.insiders_365d.buys)} · ${p.insiders_365d.buy_count}`} />
              <Fact label="Open-market sells, 12 mo" value={`${fmtUsd(p.insiders_365d.sells)} · ${p.insiders_365d.sell_count}`} />
              <Fact label="Net" value={fmtUsd(p.insiders_365d.buys - p.insiders_365d.sells)} />
            </dl>
          )}
        </section>

        <section id="pay">
          <h2>Pay vs performance</h2>
          {p.pay_vs_performance.length === 0 ? (
            <p className="muted">No pay-versus-performance disclosure yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Year</th><th className="num">CEO total comp</th><th className="num">Comp actually paid</th><th className="num">TSR (indexed)</th><th className="num">Peer TSR</th></tr>
                </thead>
                <tbody>
                  {p.pay_vs_performance.map((x) => (
                    <tr key={x.fiscal_year}>
                      <td className="num">FY{x.fiscal_year}</td>
                      <td className="num">{fmtUsd(x.peo_total_comp)}</td>
                      <td className="num">{fmtUsd(x.peo_compensation_actually_paid)}</td>
                      <td className="num">{x.company_tsr_indexed?.toFixed(0) ?? "—"}</td>
                      <td className="num">{x.peer_group_tsr_indexed?.toFixed(0) ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
    </main>
  );
}

function TrendStat({ label, value, title, delta, spark, sub }: {
  label: string; value: string; title?: string; delta?: React.ReactNode; spark?: React.ReactNode; sub?: string;
}) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd title={title}>
        <span className="stat-value">{value}</span>
        {spark && <span className="stat-spark">{spark}</span>}
      </dd>
      {(delta || sub) && <dd className="stat-sub">{delta}{sub && <span className="muted">{sub}</span>}</dd>}
    </div>
  );
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd title={title}>{value}</dd>
    </div>
  );
}

// EDGAR SIC descriptions are uppercase ("SERVICES-BUSINESS SERVICES, NEC").
function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])\w/g, (m) => m.toUpperCase()).replace(/\bNec\b/, "NEC");
}

// "Dilutive SBC" -> "dilutive SBC": lowercase a leading word, keep acronyms.
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

// One cell per check: state, measured value, meter against the threshold, rule.
function SignalGrid({ keys, scores, marketCap }: { keys: readonly string[]; scores: Record<string, unknown> | null; marketCap: Num }) {
  return (
    <ul className="flag-grid">
      {keys.map((k) => {
        const fired = scores?.[k] === true;
        const ev = scores ? signalEvidence(k, scores, marketCap) : null;
        const m = scores ? signalMeasure(k, scores) : null;
        return (
          <li key={k} className="flag-cell" data-fired={fired}>
            <div className="flag-cell-top">
              <span>{SIGNAL_LABELS[k]}</span>
              <span className="flag-state">{!scores ? "Not scored" : fired ? "Yes" : "No"}</span>
            </div>
            <div className="flag-value">{ev ?? "—"}</div>
            {m ? (
              <Meter value={m.invert ? m.max - m.value : m.value} threshold={m.invert ? m.max - m.threshold : m.threshold}
                max={m.max} fired={fired} label={`${SIGNAL_LABELS[k]}: ${ev ?? ""}`} />
            ) : <div className="meter meter-empty" aria-hidden="true" />}
            <div className="flag-rule muted">{SIGNAL_RULES[k]}</div>
          </li>
        );
      })}
    </ul>
  );
}
