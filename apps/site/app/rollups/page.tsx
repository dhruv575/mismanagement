import Link from "next/link";
import type { Metadata } from "next";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { TickerName } from "@/lib/ticker";

// Feeds refresh daily; the page re-renders every few hours.
export const revalidate = 21600;

export const metadata: Metadata = {
  title: "AI rollups",
  description: "Every acquisition by AI rollups and AI holding companies: Long Lake, Thrive Holdings, Crete, Shield, General Catalyst's platforms and more, from press coverage and SEC filings, updated daily.",
  alternates: { canonical: "/rollups" },
};

interface Buyer { slug: string; name: string; kind: string; note: string; deals: number; latest: string | null }
interface Source { title: string; outlet: string; url: string }
interface Deal {
  kind: "public" | "private"; buyer: string; buyer_slug: string; target: string; target_sector: string | null;
  announced: string; ticker?: string; sources: Source[];
}

export default async function Rollups({ searchParams }: { searchParams: Promise<{ buyer?: string }> }) {
  const { buyer } = await searchParams;
  const data = await api<{ buyers: Buyer[]; deals: Deal[] }>("/rollups");
  const active = data.buyers.find((b) => b.slug === buyer) ?? null;
  const deals = active ? data.deals.filter((d) => d.buyer_slug === active.slug) : data.deals;
  const tracked = data.buyers.filter((b) => b.deals > 0);

  return (
    <main className="page">
      <h1>AI rollups</h1>
      <p className="muted page-lede">
        Acquisitions by AI holding companies and rollups: buyers that acquire services businesses and run them with AI.
        Private deals come from press coverage, public take-privates from SEC filings. Updated daily.{" "}
        <Link href="/">Which public companies fit the pattern</Link>
      </p>

      <nav className="year-tabs" aria-label="Buyer">
        <Link href="/rollups" aria-current={!active ? "page" : undefined}>All <span className="muted">{data.deals.length}</span></Link>
        {tracked.map((b) => (
          <Link key={b.slug} href={`/rollups?buyer=${b.slug}`} aria-current={active?.slug === b.slug ? "page" : undefined}>
            {b.name} <span className="muted">{b.deals}</span>
          </Link>
        ))}
      </nav>

      {active && (
        <p className="buyer-note"><strong>{active.name}</strong> <span className="tag">{active.kind}</span> {active.note}</p>
      )}

      {deals.length === 0 ? (
        <p className="empty table-wrap">No deals tracked yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data rows-hover stack-narrow">
            <thead>
              <tr><th>Announced</th><th>Buyer</th><th>Target</th><th className="hide-narrow">Business</th><th>Source</th></tr>
            </thead>
            <tbody>
              {deals.map((d) => (
                <tr key={`${d.buyer_slug}:${d.target}`}>
                  <td className="date muted" data-slot="date">{fmtDate(d.announced)}</td>
                  <td><Link href={`/rollups?buyer=${d.buyer_slug}`}>{d.buyer}</Link></td>
                  <td data-slot="main">
                    {d.ticker ? <TickerName ticker={d.ticker} name={d.target} /> : d.target}
                    {d.kind === "public" && <> <span className="tag">Public</span></>}
                  </td>
                  <td className="hide-narrow muted">{d.target_sector || "—"}</td>
                  <td>
                    <a href={d.sources[0]!.url} rel="noopener nofollow">{d.sources[0]!.outlet}</a>
                    {d.sources.length > 1 && <span className="muted"> +{d.sources.length - 1}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
