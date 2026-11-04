import Link from "next/link";

/** The one way a company is labeled: TICKER | Name. `link` off for the page
 *  that already is the company (its own title). Delisted issuers without a
 *  ticker carry a CIK placeholder; they show the name alone, unlinked. */
export function TickerName({ ticker, name, link = true, base = "" }: { ticker: string; name?: string | null; link?: boolean; base?: string }) {
  if (ticker.startsWith("CIK") && name) return <span className="tk"><span className="tk-name">{name}</span></span>;
  return (
    <span className="tk">
      {link ? <Link href={`${base}/company/${ticker}`} className="ticker">{ticker}</Link> : <span className="ticker">{ticker}</span>}
      {name && (
        <>
          <span className="tk-sep" aria-hidden="true">|</span>
          <span className="tk-name">{name}</span>
        </>
      )}
    </span>
  );
}
