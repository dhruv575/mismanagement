import Link from "next/link";

/** The one way a company is labeled: TICKER | Name. `link` off for the page
 *  that already is the company (its own title). */
export function TickerName({ ticker, name, link = true }: { ticker: string; name?: string | null; link?: boolean }) {
  return (
    <span className="tk">
      {link ? <Link href={`/company/${ticker}`} className="ticker">{ticker}</Link> : <span className="ticker">{ticker}</span>}
      {name && (
        <>
          <span className="tk-sep" aria-hidden="true">|</span>
          <span className="tk-name">{name}</span>
        </>
      )}
    </span>
  );
}
