import Link from "next/link";
import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { acquirerSlug, app } from "@takeover/api";
import { fmtDate, fmtMultiple, fmtUsd, likelihoodPhrase } from "@/lib/format";
import { TickerName } from "@/lib/ticker";
import { SITE_URL } from "@/lib/site";
import { SIGNAL_LABELS, SIGNAL_RULES, signalEvidence, signalMeasure, type SignalGroup } from "@/lib/signals";
import { Delta, Meter, Sparkline } from "@/lib/charts";

import { baseOf, type Side } from "@/lib/side";

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


export async function companyMetadata(ticker: string, side: Side): Promise<Metadata> {
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
  const mult = p.scores?.sponsor_multiple != null ? Number(p.scores.sponsor_multiple) : null;
  const title = side === "angel" ? `${co.name} (${co.ticker}) AI-rollup odds` : `${co.name} (${co.ticker}) takeover score`;
  const lead = side === "angel"
    ? `${co.name} (${co.ticker}): ${mult != null ? `${likelihoodPhrase(mult)} to be bought by an AI rollup.` : "AI-rollup odds from SEC filings."}`
    : `${co.name} (${co.ticker}): ${p.scores?.pe_multiple != null ? `${likelihoodPhrase(Number(p.scores.pe_multiple))} to be taken private. ` : ""}${scoreText}`;
  const description = `${lead}${facts ? ` ${facts[0]!.toUpperCase()}${facts.slice(1)}.` : ""}`;
  const path = `${baseOf(side)}/company/${co.ticker}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", url: path, title, description },
    twitter: { card: "summary_large_image", title, description },
  };
}

export async function CompanyView({ ticker, side }: { ticker: string; side: Side }) {
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
        url: `${SITE_URL}${baseOf(side)}/company/${co.ticker}`,
        name: `${co.name} (${co.ticker}) takeover score`,
        about: {
          "@type": "Corporation",
          name: co.name,
          tickerSymbol: co.ticker,
          ...(p.headcount ? { numberOfEmployees: { "@type": "QuantitativeValue", value: p.headcount.employees } } : {}),
          ...(co.sic_description ? { industry: co.sic_description } : {}),
        },
      }) }} />
      <header className="co-head co-head-simple">
        <h1><TickerName ticker={co.ticker} name={co.name} link={false} /></h1>
        <p className="muted">
          {[co.sic_description && titleCase(co.sic_description), co.market_cap != null && `${fmtUsd(co.market_cap)} market cap`,
            p.headcount && `${p.headcount.employees.toLocaleString("en-US")} employees`].filter(Boolean).join(" · ")}
        </p>
      </header>

      {side === "angel" && (p.scores?.sponsor_prob != null ? <SponsorOdds s={p.scores} /> : <p className="muted">Not scored by the AI-rollup model yet.</p>)}
      {side === "devil" && <Signals p={p} />}

      {p.deals.length > 0 && <DealTable deals={p.deals} />}

      <section aria-labelledby="key-h">
        <h2 id="key-h">Key numbers</h2>
        <dl className="stat-strip" data-cols="4">
          <TrendStat label="Revenue" value={fmtUsd(last(revenue))}
            delta={<Delta now={last(revenue)} prev={prev(revenue)} />}
            spark={<Sparkline values={revenue} labels={yl} format={fmtUsd} />} />
          <TrendStat label="Operating margin" value={last(margin) != null ? fmtPct(last(margin)!) : "—"}
            delta={<Delta now={last(margin)} prev={prev(margin)} />}
            spark={<Sparkline values={margin} labels={yl} format={fmtPct} />} />
          <TrendStat label="EBITDA" value={fmtUsd(last(ebitda))}
            delta={<Delta now={last(ebitda)} prev={prev(ebitda)} />}
            spark={<Sparkline values={ebitda} labels={yl} format={fmtUsd} />} />
          <TrendStat label="Net debt / EBITDA" value={d.net_debt_to_ebitda != null ? `${d.net_debt_to_ebitda.toFixed(1)}×` : "—"}
            sub={d.net_debt != null ? `${fmtUsd(d.net_debt)} net debt` : undefined} />
        </dl>
      </section>


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

        {side === "devil" && <>
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
            <Insiders t={p.insiders_365d} />
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
        </>}
    </main>
  );
}

// Devil side headline: how many takeover signals fired, then the evidence.
function Signals({ p }: { p: Profile }) {
  const all = p.groups.flatMap((g) => g.signals);
  const fired = all.filter((k) => p.scores?.[k] === true), rest = all.filter((k) => p.scores?.[k] !== true);
  const co = p.company;
  const mult = p.scores?.pe_multiple != null ? Number(p.scores.pe_multiple) : null;
  const pct = p.scores?.pe_percentile != null ? Number(p.scores.pe_percentile) : null;
  return (
    <section aria-labelledby="score-h">
      {mult != null && (
        <div className="verdict" data-high={mult >= 3}>
          <div className="verdict-num">{fmtMultiple(mult)}</div>
          <div>
            <h2 id="pe-h">{bare(mult)} to be taken private</h2>
            <p className="muted">{pct != null && <>Top {topShare(pct)} of the Russell 3000 for a buyout by a private-equity firm, holdco or insiders. </>}<Link href="/pe/deals#model">How it works</Link></p>
          </div>
        </div>
      )}
      <div className="signals-head">
        <div>
          <h2 id="score-h">Takeover signals</h2>
          <p className="muted">What an activist or buyer would see: cheap, overpaid, diluted or under pressure.</p>
        </div>
        <div className="signals-count">
          {p.scores ? <span className="signals-num"><strong>{fired.length}</strong><span className="muted">of {all.length} fired</span></span> : <span className="muted">Not scored yet</span>}
          <Link href="/pe/deals#backtest">How well they predict deals →</Link>
        </div>
      </div>
      {fired.length > 0 ? <SignalGrid keys={fired} scores={p.scores} marketCap={co.market_cap} /> : <p className="muted">No signals fired.</p>}
      {rest.length > 0 && (
        <details className="other-signals">
          <summary>{rest.length} other checks</summary>
          <SignalGrid keys={rest} scores={p.scores} marketCap={co.market_cap} />
        </details>
      )}
    </section>
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

const BUSINESS_ROWS: [string, string][] = [
  ["recurring_revenue", "Recurring revenue"],
  ["rollup_fit", "AI-rollup fit"],
  ["services_share", "Services share"],
  ["labor_intensity", "Labor intensity"],
  ["ai_automatable", "Work AI could do"],
  ["fragmented_market", "Fragmented market"],
];

// The verdict: how much likelier than average an AI rollup, holdco or PE firm
// is to buy this company, and the 10-K business scores behind it.
function SponsorOdds({ s }: { s: Record<string, unknown> }) {
  const mult = Number(s.sponsor_multiple);
  const pct = s.sponsor_percentile != null ? Number(s.sponsor_percentile) : null;
  const scores = BUSINESS_ROWS.filter(([k]) => s[k] != null);
  return (
    <section aria-labelledby="sponsor-h" className="verdict" data-high={mult >= 3}>
      <div className="verdict-num">{fmtMultiple(mult)}</div>
      <div>
        <h2 id="sponsor-h">{bare(mult)} to be bought by an AI rollup</h2>
        <p className="muted">{pct != null && <>Top {topShare(pct)} of the Russell 3000. </>}<Link href="/deals#model">How it works</Link></p>
      </div>
      {s.business_summary != null && <p className="verdict-summary">{String(s.business_summary)}</p>}
      {scores.length > 0 && (
        <ul className="biz-bars" aria-label="What the 10-K says about the business, out of 10">
          {scores.map(([k, label]) => {
            const v = Number(s[k]);
            return (
              <li key={k}>
                <span>{label}</span>
                <span className="biz-track" aria-hidden="true"><span style={{ width: `${v * 10}%` }} /></span>
                <span className="biz-v">{v}<span className="muted">/10</span></span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DealTable({ deals }: { deals: Profile["deals"] }) {
  return (
    <section id="deals" aria-labelledby="deals-h">
      <h2 id="deals-h">Deal filings</h2>
      <div className="table-wrap">
        <table className="data stack-narrow">
          <thead>
            <tr><th>Filed</th><th>Form</th><th>Acquirer</th><th className="num">Price</th><th className="num">Premium</th></tr>
          </thead>
          <tbody>
            {deals.map((x) => (
              <tr key={x.accession_number} data-terms={x.price_per_share != null || x.premium_pct != null}>
                <td className="date muted" data-slot="date">{fmtDate(x.filing_date)}</td>
                <td data-slot="form"><a href={x.document_url} rel="noopener">{x.form}</a></td>
                <td data-slot="by">{x.acquirer ? <Link href={`/acquirers/${acquirerSlug(x.acquirer)}`}>{x.acquirer}</Link> : (x.matched_buyer ? <span className="muted">Mentions {x.matched_buyer}</span> : "—")}</td>
                <td className="num" data-slot="price">{x.price_per_share != null ? `$${x.price_per_share.toFixed(2)}` : "—"}</td>
                <td className="num" data-slot="prem">{x.premium_pct != null ? `${x.premium_pct}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Percentile (0-1) as a "top N%" share: 0.9998 -> "1%", never "0%".
function topShare(pct: number): string {
  const top = (1 - pct) * 100;
  return top < 1 ? "1%" : `${Math.round(top)}%`;
}

// The phrase without its leading number, for next to the big multiple:
// "more likely than average", "less likely than average", "About as likely as average".
function bare(mult: number): string {
  const s = likelihoodPhrase(mult).replace(/^[0-9.]+× /, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Open-market buys against sells over 12 months: one bar each, same scale.
function Insiders({ t }: { t: Profile["insiders_365d"] }) {
  const top = Math.max(t.buys, t.sells, 1);
  const net = t.buys - t.sells;
  const row = (label: string, v: number, n: number, kind: "buy" | "sell") => (
    <li className="ins-row" data-kind={kind}>
      <span className="ins-label">{label}</span>
      <span className="ins-track" aria-hidden="true"><span style={{ width: `${Math.max((v / top) * 100, v ? 1.5 : 0)}%` }} /></span>
      <span className="ins-v">{fmtUsd(v)}<span className="muted"> · {n} {n === 1 ? "trade" : "trades"}</span></span>
    </li>
  );
  return (
    <div className="insiders">
      <ul aria-label="Open-market insider trades, last 12 months">
        {row("Bought", t.buys, t.buy_count, "buy")}
        {row("Sold", t.sells, t.sell_count, "sell")}
      </ul>
      <p className="muted ins-net">
        Net {net >= 0 ? "buying" : "selling"} of <strong className={net >= 0 ? "pos" : "neg"}>{fmtUsd(Math.abs(net))}</strong> in open-market trades over the last 12 months.
      </p>
    </div>
  );
}
