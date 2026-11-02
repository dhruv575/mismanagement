import type { Metadata } from "next";
import { api } from "@/lib/api";
import { TickerName } from "@/lib/ticker";
import { fmtDate } from "@/lib/format";

export const revalidate = 21600;

export const metadata: Metadata = {
  title: "Deals",
  description:
    "Merger proxies, going-private schedules and tender offers on US public companies, with price, premium and acquirer, " +
    "including AI-rollup buyers like Long Lake, Thrive Holdings and General Catalyst.",
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
  price_per_share: number | null;
  premium_pct: number | null;
  document_url: string;
}

export default async function Deals() {
  const { rows } = await api<{ rows: Deal[] }>("/deals");

  return (
    <main className="page">
      <h1>Deals</h1>
      <div className="table-wrap">
        {rows.length === 0 ? (
          <p className="empty">No deal filings yet.</p>
        ) : (
          <table className="data stack-narrow">
            <thead>
              <tr>
                <th>Filed</th>
                <th>Company</th>
                <th>Form</th>
                <th>Acquirer</th>
                <th className="hide-narrow">Search match</th>
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
                  <td data-slot="by">{d.acquirer ?? <span className="muted">{d.matched_buyer ? `Mentions ${d.matched_buyer}` : "—"}</span>}</td>
                  <td className="hide-narrow muted">{d.matched_buyer ?? "—"}</td>
                  <td className="num" data-slot="price">{d.price_per_share != null ? `$${d.price_per_share.toFixed(2)}` : "—"}</td>
                  <td className="num" data-slot="prem">{d.premium_pct != null ? `${d.premium_pct}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
