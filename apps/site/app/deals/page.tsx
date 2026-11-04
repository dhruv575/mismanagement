import type { Metadata } from "next";
import { api } from "@/lib/api";
import { TickerName } from "@/lib/ticker";
import { fmtDate } from "@/lib/format";
import { SIGNAL_LABELS } from "@/lib/signals";
import Link from "next/link";

export const revalidate = 21600;

export const metadata: Metadata = {
  title: "Deals",
  description:
    "Merger proxies, going-private schedules and tender offers on US public companies since 2017, with price, premium and acquirer, " +
    "and a point-in-time backtest of which signals showed up before the deal.",
  alternates: { canonical: "/deals" },
};

interface Deal {
  accession_number: string;
  ticker: string;
  name: string;
  form: string;
  filing_date: string;
  acquirer: string | null;
  matched_buyer: string | null;
  acquirer_slug: string | null;
  price_per_share: number | null;
  premium_pct: number | null;
  document_url: string;
  pre_score: number | null;
  buyer_type: string | null;
  target_business: string | null;
  rollup_buyer: string | null;
}

interface ScoreRow {
  ticker: string; name: string; announced: string; buyer: string | null; buyer_type: string | null; rollup_buyer: string | null;
  services_business: boolean | null; probability: number; multiple: number; percentile: number; inputs_before: boolean | null; in_training: boolean;
}

interface Backtest {
  company_years: number;
  deals: number;
  base_rate: number;
  first_cohort: number | null;
  last_cohort: number | null;
  max_score: number;
  signals: { key: string; fired: number; deals: number; deal_rate: number | null; lift: number | null; sampled?: boolean }[];
  text_sample: number;
  untested: { key: string; why: string }[];
  scores: { score: number; n: number; deals: number }[];
  sponsor: { rows: number; positives: number; base_rate: number } | null;
}

// deal_class.buyer_type (classify-deals.ts) as shown on the page.
const BUYER_TYPE: Record<string, string> = {
  financial_sponsor: "Sponsor", sponsor_platform: "Sponsor platform", holdco_or_ai_rollup: "Holdco / rollup",
  management_or_insider: "Insiders", strategic: "Strategic",
};
const SPONSORISH = new Set(["financial_sponsor", "sponsor_platform", "holdco_or_ai_rollup", "management_or_insider"]);

const pct = (v: number | null, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const FIRST_YEAR = 2017;

export default async function Deals({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const thisYear = new Date().getUTCFullYear();
  const asked = Number((await searchParams).year);
  const year = asked >= FIRST_YEAR && asked <= thisYear ? asked : thisYear;
  const [{ rows }, bt, sc] = await Promise.all([
    api<{ rows: Deal[] }>(`/deals?year=${year}`),
    api<Backtest>("/backtest"),
    api<{ rows: ScoreRow[] }>("/scorecard"),
  ]);
  // Out-of-sample deals the model scored from filings made before the announcement.
  const live = sc.rows.filter((r) => !r.in_training && r.inputs_before !== false);
  const liveRollup = live.filter((r) => r.rollup_buyer || (SPONSORISH.has(r.buyer_type ?? "") && r.services_business));
  const top10 = (xs: ScoreRow[]) => xs.filter((r) => r.percentile >= 0.9).length;
  const years = Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, i) => thisYear - i);
  const topScore = Math.max(...bt.scores.map((s) => s.n ? s.deals / s.n : 0), bt.base_rate, 1e-9);

  return (
    <main className="page">
      <h1>Deals</h1>

      {bt.sponsor && (
        <section className="backtest" id="model" aria-labelledby="model-h">
          <h2 id="model-h">The AI-rollup buyout model</h2>
          <p className="muted page-lede">
            AI rollups (holdcos and private-equity-style buyers that acquire services businesses and automate the work) are too
            new to backtest directly, so the model learns from their closest precedent: private-equity firms, sponsor-backed platforms,
            holdcos and insider groups buying services businesses (consultancies, staffing, outsourcing, brokerages, clinics, engineering
            and government services). A language model read each deal document to tell those apart from strategic acquisitions and product
            companies, and read every company&rsquo;s 10-K from before the deal to score its business: recurring revenue, services share, labor intensity,
            how much of the work AI could do, market fragmentation and overall fit for an AI rollup.
          </p>
          <p className="muted page-lede">
            {bt.sponsor.positives} of {bt.sponsor.rows.toLocaleString("en-US")} company-years ({pct(bt.sponsor.base_rate)}) were followed by
            a buyout like that within 12 months. Trained only on earlier years and tested on each of 2020&ndash;2024, the model put about 6.7×
            the average rate in its top tenth, against about 2× for predicting any deal; with only 24 such buyouts in the test years, treat
            that as a rough figure. Being a services business, smaller size, AI-rollup fit and goodwill from past acquisitions carry most of
            the weight.
          </p>
        </section>
      )}

      {live.length > 0 && (
        <section className="backtest" id="scorecard" aria-labelledby="sc-h">
          <h2 id="sc-h">Scorecard: deals since the model was trained</h2>
          <p className="muted page-lede">
            Every company agreeing to be acquired since April 2026, after the last deal the model learned from, with where the model
            ranked it among {bt.sponsor ? "the universe" : "all companies"} using filings made before the announcement.
            {liveRollup.length > 0 && <> {top10(liveRollup)} of {liveRollup.length} AI-rollup-style buyouts were in the model&rsquo;s top tenth.</>}
            {" "}{top10(live)} of {live.length} deals of any kind were.
          </p>
          <div className="table-wrap">
            <table className="data rows-hover">
              <thead>
                <tr><th>Announced</th><th>Company</th><th>Buyer</th><th className="hide-narrow">Type</th><th className="num">Model rank</th><th className="num hide-narrow">Odds vs. average</th></tr>
              </thead>
              <tbody>
                {live.map((r) => (
                  <tr key={r.ticker}>
                    <td className="date muted">{fmtDate(r.announced)}</td>
                    <td><TickerName ticker={r.ticker} name={r.name} /></td>
                    <td>{r.rollup_buyer ?? r.buyer ?? "—"}{r.rollup_buyer && <> <span className="tag">AI rollup</span></>}</td>
                    <td className="hide-narrow muted">{r.buyer_type && BUYER_TYPE[r.buyer_type] ? BUYER_TYPE[r.buyer_type] : "—"}{r.services_business ? " · services" : ""}</td>
                    <td className="num" data-high={r.percentile >= 0.9}>Top {Math.max(1, Math.ceil((1 - r.percentile) * 100))}%</td>
                    <td className="num hide-narrow">{r.multiple.toFixed(1)}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {bt.company_years > 0 && (
        <section className="backtest" aria-labelledby="bt-h">
          <h2 id="bt-h">Which signals showed up before a deal</h2>
          <p className="muted page-lede">
            Every company with at least $500M of public float, as of April 1 each year from {bt.first_cohort! + 1} to {bt.last_cohort! + 1},
            scored only on what it had filed by then, including companies since bought and delisted.{" "}
            {bt.deals.toLocaleString("en-US")} of {bt.company_years.toLocaleString("en-US")} company-years ({pct(bt.base_rate)}) had a
            merger proxy, tender offer or going-private filing within the next 12 months. Lift is how much more often that happened
            when the signal had fired.
          </p>
          <div className="bt-grid">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Signal</th><th className="num">Fired</th><th className="num">Then a deal</th><th className="num">Lift</th></tr>
                </thead>
                <tbody>
                  {bt.signals.map((s) => (
                    <tr key={s.key}>
                      <td>{SIGNAL_LABELS[s.key]}{s.sampled && <sup className="muted" title="Estimated from a sample of 10-Ks">*</sup>}</td>
                      <td className="num">{s.fired.toLocaleString("en-US")}</td>
                      <td className="num">{pct(s.deal_rate)}</td>
                      <td className="num"><span className="lift" data-up={(s.lift ?? 0) >= 1.2} data-down={(s.lift ?? 1) <= 0.8}>{s.lift?.toFixed(2) ?? "—"}×</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <figure className="bt-scores">
              <div className="bt-bars">
                {bt.scores.map((s) => {
                  const rate = s.n ? s.deals / s.n : 0;
                  return (
                    <div key={s.score} className="bt-col" title={`Score ${s.score}: ${s.deals} of ${s.n} followed by a deal`}>
                      <span className="bt-rate">{pct(rate, 0)}</span>
                      <span className="bt-bar" style={{ height: `${(rate / topScore) * 100}%` }} />
                      <span className="bt-k">{s.score}</span>
                      <span className="bt-n muted">{s.n.toLocaleString("en-US")}</span>
                    </div>
                  );
                })}
              </div>
              <figcaption className="muted">Deal rate by score, out of the {bt.max_score} signals that can be rebuilt historically. Small print: companies at that score.</figcaption>
            </figure>
          </div>
          {bt.text_sample > 0 && (
            <p className="muted bt-untested">
              * Read from the 10-K text, which comes from a sample of {bt.text_sample.toLocaleString("en-US")} company-years: every
              company that later had a deal, plus five random others for each, weighted back up to the full panel. Treat these two as estimates.
            </p>
          )}
          {bt.untested.length > 0 && <p className="muted bt-untested">
            Not in the backtest, because their history isn&apos;t kept:{" "}
            {bt.untested.map((u, i) => (
              <span key={u.key}>{i > 0 && "; "}{SIGNAL_LABELS[u.key]} ({u.why.charAt(0).toLowerCase() + u.why.slice(1)})</span>
            ))}.
          </p>}
        </section>
      )}

      <nav className="year-tabs" aria-label="Filing year">
        {years.map((y) => (
          <Link key={y} href={y === thisYear ? "/deals" : `/deals?year=${y}`} aria-current={y === year ? "page" : undefined}>{y}</Link>
        ))}
      </nav>
      <div className="table-wrap">
        {rows.length === 0 ? (
          <p className="empty">No deal filings in {year}.</p>
        ) : (
          <table className="data stack-narrow">
            <thead>
              <tr>
                <th>Filed</th>
                <th>Company</th>
                <th>Form</th>
                <th>Acquirer</th>
                <th className="hide-narrow">Buyer</th>
                <th className="num hide-narrow" title={`Signals fired as of the April 1 before the filing, out of ${bt.max_score}`}>Score before</th>
                <th className="num">Price</th>
                <th className="num">Premium</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.accession_number} data-terms={d.price_per_share != null || d.premium_pct != null}>
                  <td className="date muted" data-slot="date">{fmtDate(d.filing_date)}</td>
                  <td data-slot="main">
                    <TickerName ticker={d.ticker} name={d.name} />
                  </td>
                  <td data-slot="form"><a href={d.document_url} rel="noopener">{d.form}</a></td>
                  <td data-slot="by">{d.acquirer && d.acquirer_slug ? <Link href={`/acquirers/${d.acquirer_slug}`}>{d.acquirer}</Link> : d.acquirer ?? <span className="muted">—</span>}
                    {d.rollup_buyer && <> <span className="tag">AI rollup</span></>}</td>
                  <td className="hide-narrow">{d.buyer_type && BUYER_TYPE[d.buyer_type]
                    ? <span className={SPONSORISH.has(d.buyer_type) ? "tag" : "muted"} title={d.target_business ?? undefined}>{BUYER_TYPE[d.buyer_type]}</span>
                    : <span className="muted">—</span>}</td>
                  <td className="num hide-narrow">{d.pre_score != null ? <>{d.pre_score}<span className="muted"> / {bt.max_score}</span></> : <span className="muted">—</span>}</td>
                  <td className="num" data-slot="price">{d.price_per_share != null ? `$${d.price_per_share.toFixed(2)}` : "—"}</td>
                  <td className="num" data-slot="prem">{d.premium_pct != null ? `${Math.round(d.premium_pct)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
