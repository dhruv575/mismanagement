import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { app } from "@takeover/api";
import { fmtDate } from "@/lib/format";
import { TickerName } from "@/lib/ticker";

export const revalidate = 21600;
export const dynamicParams = true;
export async function generateStaticParams() {
  return [];
}

type Num = number | null;
interface Profile {
  slug: string;
  name: string;
  ai_rollup: boolean;
  aliases: string[];
  targets: { ticker: string; name: string; takeover_score: Num; pre_score: Num; filings: number; first: string; last: string }[];
  deals: { accession_number: string; ticker: string; name: string; form: string; filing_date: string; mention: boolean; price_per_share: Num; premium_pct: Num; document_url: string }[];
}

const load = cache(async (slug: string): Promise<Profile | null> => {
  const res = await app.request(`/api/acquirers/${encodeURIComponent(slug)}`);
  return res.ok ? ((await res.json()) as Profile) : null;
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const p = await load((await params).slug);
  if (!p) return { title: "Acquirer not found" };
  const t = p.targets.map((x) => x.ticker).slice(0, 5).join(", ");
  return {
    title: `${p.name} acquisitions`,
    description: `${p.name} in ${p.deals.length} deal filing${p.deals.length === 1 ? "" : "s"} on ${p.targets.length} public compan${p.targets.length === 1 ? "y" : "ies"}: ${t}.`,
    alternates: { canonical: `/acquirers/${p.slug}` },
  };
}

export default async function AcquirerPage({ params }: { params: Promise<{ slug: string }> }) {
  const p = await load((await params).slug);
  if (!p) notFound();
  const prem = p.deals.map((d) => d.premium_pct).filter((v): v is number => v != null).sort((a, b) => a - b);
  const median = prem.length ? Math.round(prem[Math.floor(prem.length / 2)]!) : null;
  const mentions = p.deals.some((d) => d.mention);
  const others = p.aliases.filter((a) => a !== p.name);

  return (
    <main className="page company">
      <header className="co-head">
        <div className="co-id">
          <p className="muted"><Link href="/acquirers">Acquirers</Link></p>
          <h1>{p.name}{p.ai_rollup && <span className="tag">AI rollup</span>}</h1>
          {others.length > 0 && <p className="muted">Also filed as {others.join("; ")}</p>}
        </div>
        <dl className="stat-strip" data-cols="5">
          <div className="stat"><dt>Targets</dt><dd>{p.targets.length}</dd></div>
          <div className="stat"><dt>Filings</dt><dd>{p.deals.length}</dd></div>
          <div className="stat"><dt>Median premium</dt><dd>{median != null ? `${median}%` : "—"}</dd></div>
          <div className="stat"><dt>First filing</dt><dd>{fmtDate(p.deals[p.deals.length - 1]!.filing_date)}</dd></div>
          <div className="stat"><dt>Latest filing</dt><dd>{fmtDate(p.deals[0]!.filing_date)}</dd></div>
        </dl>
      </header>

      <section>
        <h2>Targets</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Company</th>
                <th className="num" title="Signals fired as of the April 1 before the first filing, out of the 7 that can be rebuilt historically">Score before deal</th>
                <th className="num" title="Today's takeover score, out of 15">Score now</th>
                <th className="num">Filings</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {p.targets.map((t) => (
                <tr key={t.ticker}>
                  <td><TickerName ticker={t.ticker} name={t.name} base="/pe" /></td>
                  <td className="num">{t.pre_score != null ? <>{t.pre_score}<span className="muted"> / 7</span></> : <span className="muted">—</span>}</td>
                  <td className="num">{t.ticker.startsWith("CIK") || t.takeover_score == null ? <span className="muted">—</span> : <>{t.takeover_score}<span className="muted"> / 13</span></>}</td>
                  <td className="num">{t.filings}</td>
                  <td className="date muted">{fmtDate(t.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Deal filings</h2>
        {mentions && (
          <p className="muted page-lede">
            Rows marked mention are 8-Ks that name {p.name} in a material agreement. They show a relationship, not necessarily a sale.
          </p>
        )}
        <div className="table-wrap">
          <table className="data stack-narrow">
            <thead>
              <tr><th>Filed</th><th>Company</th><th>Form</th><th className="num">Price</th><th className="num">Premium</th></tr>
            </thead>
            <tbody>
              {p.deals.map((d) => (
                <tr key={d.accession_number} data-terms={d.price_per_share != null || d.premium_pct != null}>
                  <td className="date muted" data-slot="date">{fmtDate(d.filing_date)}</td>
                  <td data-slot="main"><TickerName ticker={d.ticker} name={d.name} base="/pe" /></td>
                  <td data-slot="form"><a href={d.document_url} rel="noopener">{d.form}</a>{d.mention && <span className="muted"> · mention</span>}</td>
                  <td className="num" data-slot="price">{d.price_per_share != null ? `$${d.price_per_share.toFixed(2)}` : "—"}</td>
                  <td className="num" data-slot="prem">{d.premium_pct != null ? `${d.premium_pct}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
