import type { Metadata } from "next";
import Link from "next/link";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/format";

export const revalidate = 21600;

export const metadata: Metadata = {
  title: "Acquirers",
  description:
    "Every buyer named in a merger proxy, going-private schedule or tender offer on a US public company, " +
    "with its targets, filings and premiums paid.",
  alternates: { canonical: "/acquirers" },
};

interface Acquirer {
  slug: string;
  name: string;
  filings: number;
  targets: { ticker: string; name: string }[];
  latest: string;
  ai_rollup: boolean;
  median_premium: number | null;
}

export default async function Acquirers() {
  const { rows } = await api<{ rows: Acquirer[] }>("/acquirers");
  const repeat = rows.filter((r) => r.targets.length > 1).length;

  return (
    <main className="page">
      <h1>Acquirers</h1>
      <p className="muted page-lede">
        {rows.length.toLocaleString("en-US")} buyers named in deal filings, {repeat} with more than one target.
      </p>
      <div className="table-wrap">
        <table className="data stack-narrow">
          <thead>
            <tr>
              <th>Acquirer</th>
              <th>Targets</th>
              <th className="num hide-narrow">Filings</th>
              <th className="num hide-narrow">Median premium</th>
              <th>Latest</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.slug}>
                <td data-slot="main">
                  <Link href={`/acquirers/${a.slug}`}>{a.name}</Link>
                  {a.ai_rollup && <span className="tag">AI rollup</span>}
                </td>
                <td data-slot="by">
                  {a.targets.slice(0, 3).map((t, i) => (
                    <span key={t.ticker}>
                      {i > 0 && ", "}
                      <Link className="ticker" href={`/company/${t.ticker}`} title={t.name}>{t.ticker}</Link>
                    </span>
                  ))}
                  {a.targets.length > 3 && <span className="muted"> +{a.targets.length - 3}</span>}
                </td>
                <td className="num hide-narrow">{a.filings}</td>
                <td className="num hide-narrow">{a.median_premium != null ? `${a.median_premium}%` : "—"}</td>
                <td className="date muted" data-slot="date">{fmtDate(a.latest)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
