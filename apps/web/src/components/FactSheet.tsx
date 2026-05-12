import { useEffect, useState } from "react";
import { fetchSheet, type SheetResponse } from "../api.js";
import { fmtUsd, fmtUsdCompact, fmtPctRaw, fmtDate } from "../lib/format.js";

interface Props {
  ticker: string;
}

// Editorial fact sheet — computed sentences only, no adjectives. The
// promise of the project ("show facts, let reader characterize") is
// delivered here. Each card chains 2–3 facts within a single thematic
// area; eyebrow labels disambiguate. Cards share the dark/hairline
// styling of the scorecard tiles above.

export function FactSheet({ ticker }: Props) {
  const [sheet, setSheet] = useState<SheetResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setSheet(null);
    setLoaded(false);
    fetchSheet(ticker)
      .then(setSheet)
      .catch(() => setSheet(null))
      .finally(() => setLoaded(true));
  }, [ticker]);

  if (!loaded) return <div className="loading-state">Loading fact sheet…</div>;
  if (!sheet) return null;

  return (
    <section className="fact-sheet">
      <div className="fact-grid">
        <CompensationCard sheet={sheet} />
        <PerformanceCard sheet={sheet} />
        <ActivityCard sheet={sheet} />
      </div>
      <Provenance sheet={sheet} />
    </section>
  );
}

function CompensationCard({ sheet }: { sheet: SheetResponse }) {
  const { highest_paid, ceo_pay_ratio } = sheet;
  if (!highest_paid && !ceo_pay_ratio?.ratio_x_to_1) return null;

  return (
    <div className="fact-card">
      <span className="fact-eyebrow">Compensation</span>
      <p className="fact-body">
        {highest_paid ? (
          <>
            Top-paid named executive officer <strong>{highest_paid.name}</strong>
            {highest_paid.title ? <> ({highest_paid.title.toLowerCase()})</> : null}
            {" "}made <strong>{fmtUsdCompact(highest_paid.total)}</strong> in FY{highest_paid.fiscal_year}
          </>
        ) : (
          <>CEO pay ratio</>
        )}
        {ceo_pay_ratio?.ratio_x_to_1 ? (
          <>
            {" "}— <strong>{ceo_pay_ratio.ratio_x_to_1.toFixed(0)}×</strong> the median employee
            {ceo_pay_ratio.median_employee ? <> ({fmtUsdCompact(ceo_pay_ratio.median_employee)})</> : null}
          </>
        ) : null}
        .
      </p>
    </div>
  );
}

function PerformanceCard({ sheet }: { sheet: SheetResponse }) {
  const pvp = sheet.latest_pvp;
  if (!pvp || pvp.company_tsr_indexed == null || pvp.peer_group_tsr_indexed == null) return null;
  const gap = pvp.peer_group_tsr_indexed - pvp.company_tsr_indexed;
  const direction = gap > 0 ? "trailed" : "led";

  return (
    <div className="fact-card">
      <span className="fact-eyebrow">Performance</span>
      <p className="fact-body">
        FY{pvp.fiscal_year}: $100 in {sheet.ticker} became{" "}
        <strong>${pvp.company_tsr_indexed.toFixed(0)}</strong>; in the peer group,{" "}
        <strong>${pvp.peer_group_tsr_indexed.toFixed(0)}</strong> — {direction} by{" "}
        <strong className={gap > 0 ? "neg" : "pos"}>${Math.abs(gap).toFixed(0)}</strong>.
      </p>
    </div>
  );
}

function ActivityCard({ sheet }: { sheet: SheetResponse }) {
  const f = sheet.insider_flow_90d;
  const t = sheet.thirteen_d;
  const hasInsiderActivity = f.buys_count + f.sells_count > 0;
  if (!hasInsiderActivity && t.total === 0) return null;

  return (
    <div className="fact-card">
      <span className="fact-eyebrow">Activity</span>
      <p className="fact-body">
        {hasInsiderActivity ? (
          <>
            Insiders 90d: bought <strong>{fmtUsdCompact(f.buys_value)}</strong>,
            sold <strong>{fmtUsdCompact(f.sells_value)}</strong>, net{" "}
            <strong className={f.net_value >= 0 ? "pos" : "neg"}>
              {f.net_value >= 0 ? "+" : "−"}{fmtUsdCompact(Math.abs(f.net_value))}
            </strong>.{" "}
          </>
        ) : null}
        {t.total > 0 ? (
          <>
            <strong>{t.total}</strong> 13D/13G on file
            {t.active_count > 0 ? <>, <strong>{t.active_count}</strong> active</> : null}
            {t.most_recent_filer && t.most_recent_date
              ? <>; latest <strong>{t.most_recent_filer}</strong>, {fmtDate(t.most_recent_date)}
                  {t.most_recent_pct != null ? <> @ <strong>{fmtPctRaw(t.most_recent_pct)}</strong></> : null}</>
              : null}
            .
          </>
        ) : null}
      </p>
    </div>
  );
}

function Provenance({ sheet }: { sheet: SheetResponse }) {
  const fy = sheet.source.proxy_fiscal_year;
  if (!fy) {
    return (
      <p className="fact-provenance">
        No DEF 14A proxy statement has been extracted for this issuer yet.
        Compensation, board, and ownership facts are not available.
        Run <code>extract-proxy {sheet.ticker}</code>.
      </p>
    );
  }
  return (
    <p className="fact-provenance">
      Compensation, board, and ownership facts from the DEF 14A covering
      fiscal year {fy}. Performance and activity facts from EDGAR ECD
      tagging and Form 4 filings, current as of {fmtDate(sheet.source.proxy_extracted_at)}.
    </p>
  );
}
