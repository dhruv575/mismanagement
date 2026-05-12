"""
Stage 1 quant screen — proof of concept against ETSY.

Pulls SEC EDGAR XBRL companyfacts + Stooq price history, computes the
screen metrics Cohen would have looked at: revenue trend, opex bloat,
buyback intensity, SBC ratio, cash hoard, TSR vs peers.

Run: python stage1_etsy.py
"""
from __future__ import annotations
import json
import sys
import urllib.request
from collections import defaultdict
from datetime import date

UA = "MTS Editorial dhruvgup@seas.upenn.edu"

TICKERS = {
    "ETSY": "0001370637",
    "EBAY": "0001065088",   # peer
    "PINS": "0001506293",   # peer
    "W":    "0001616707",   # Wayfair, peer
}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def companyfacts(cik: str) -> dict:
    return json.loads(fetch(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"))


def submissions(cik: str) -> dict:
    return json.loads(fetch(f"https://data.sec.gov/submissions/CIK{cik}.json"))


def annual_series(facts: dict, concept: str, unit: str = "USD") -> dict[int, float]:
    """Fiscal-year totals for a US-GAAP concept. Picks the FY 10-K row per year."""
    try:
        rows = facts["facts"]["us-gaap"][concept]["units"][unit]
    except KeyError:
        return {}
    out: dict[int, float] = {}
    for r in rows:
        if r.get("fp") != "FY" or r.get("form") not in ("10-K", "10-K/A"):
            continue
        fy = r.get("fy")
        if not fy:
            continue
        # last filing wins (amendments override)
        out[int(fy)] = float(r["val"])
    return out


def annual_series_merged(facts: dict, concepts: list[str], unit: str = "USD") -> dict[int, float]:
    """Merge multiple US-GAAP concepts into one annual series. Earlier concepts
    in the list win for any year both report — handles ASC-606-style migrations
    where a company switches from `Revenues` to
    `RevenueFromContractWithCustomerExcludingAssessedTax`."""
    out: dict[int, float] = {}
    for c in concepts:
        for y, v in annual_series(facts, c, unit).items():
            out.setdefault(y, v)
    return out


def latest_value(facts: dict, concept: str, unit: str = "USD") -> tuple[int | None, float | None]:
    """Most recent value of any frequency, used for point-in-time concepts (cash, shares)."""
    try:
        rows = facts["facts"]["us-gaap"][concept]["units"][unit]
    except KeyError:
        return None, None
    rows = sorted(rows, key=lambda r: r.get("end", ""))
    if not rows:
        return None, None
    return rows[-1].get("end"), float(rows[-1]["val"])


def find_concept(facts: dict, candidates: list[str]) -> str | None:
    """First concept name in `candidates` that the company actually reports."""
    have = facts.get("facts", {}).get("us-gaap", {})
    for c in candidates:
        if c in have:
            return c
    return None


def yahoo_history(ticker: str, range_str: str = "10y") -> list[tuple[date, float]]:
    """Daily adjusted close from Yahoo Finance chart API. Free, no key.
    Adjusted close folds dividends + splits, so the resulting series is the
    correct input for total-shareholder-return."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range={range_str}&interval=1d"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    res = data["chart"]["result"][0]
    ts = res["timestamp"]
    adj = res["indicators"]["adjclose"][0]["adjclose"]
    out: list[tuple[date, float]] = []
    for t, p in zip(ts, adj):
        if p is None:
            continue
        out.append((date.fromtimestamp(t), float(p)))
    return out


def tsr(history: list[tuple[date, float]], years: int) -> float | None:
    if not history:
        return None
    last_d, last_p = history[-1]
    target = date(last_d.year - years, last_d.month, min(last_d.day, 28))
    # nearest trading day on/after target
    for d, p in history:
        if d >= target:
            return (last_p / p) - 1.0
    return None


def screen(ticker: str, cik: str) -> dict:
    facts = companyfacts(cik)
    sub = submissions(cik)

    # Merged across pre/post ASC-606 concept names. Companies switched from
    # `Revenues` to `RevenueFromContractWithCustomer*` around 2018; without
    # this merge the series breaks at the transition year.
    rev = annual_series_merged(facts, [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
    ])
    ni = annual_series(facts, "NetIncomeLoss")
    op = annual_series(facts, "OperatingIncomeLoss")
    # Etsy uses both `SellingAndMarketingExpense` and `MarketingExpense` in
    # different years — merge.
    sm = annual_series_merged(facts, ["SellingAndMarketingExpense", "MarketingExpense"])
    rd = annual_series(facts, "ResearchAndDevelopmentExpense")
    ga = annual_series(facts, "GeneralAndAdministrativeExpense")
    sbc = annual_series_merged(facts, ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"])
    bb = annual_series(facts, "PaymentsForRepurchaseOfCommonStock")

    cash_d, cash = latest_value(facts, "CashAndCashEquivalentsAtCarryingValue")
    # `LongTermDebt` is the catch-all; `LongTermDebtNoncurrent` is the
    # post-2017 split. Try the all-in concept first.
    debt_d, debt = latest_value(facts, "LongTermDebt")
    if debt is None:
        debt_d, debt = latest_value(facts, "LongTermDebtNoncurrent")
    sh_d, sh = latest_value(facts, "CommonStockSharesOutstanding", "shares")

    hist = yahoo_history(ticker)

    return {
        "ticker": ticker,
        "name": sub.get("name"),
        "sic": sub.get("sicDescription"),
        "employees": sub.get("ein") and sub.get("name"),  # placeholder
        "fy_revenue": rev,
        "fy_net_income": ni,
        "fy_operating_income": op,
        "fy_sm_expense": sm,
        "fy_rd_expense": rd,
        "fy_ga_expense": ga,
        "fy_sbc": sbc,
        "fy_buybacks": bb,
        "cash": (cash_d, cash),
        "long_term_debt": (debt_d, debt),
        "shares_outstanding": (sh_d, sh),
        "price_today": hist[-1] if hist else None,
        "tsr_1y": tsr(hist, 1),
        "tsr_3y": tsr(hist, 3),
        "tsr_5y": tsr(hist, 5),
    }


def fmt_money(x: float | None) -> str:
    if x is None:
        return "—"
    if abs(x) >= 1e9:
        return f"${x/1e9:.2f}B"
    if abs(x) >= 1e6:
        return f"${x/1e6:.1f}M"
    return f"${x:,.0f}"


def fmt_pct(x: float | None) -> str:
    return "—" if x is None else f"{x*100:+.1f}%"


def cagr(series: dict[int, float], n_years: int) -> float | None:
    if len(series) < n_years + 1:
        return None
    years = sorted(series)
    end_y = years[-1]
    start_y = end_y - n_years
    if start_y not in series:
        return None
    start, end = series[start_y], series[end_y]
    if start <= 0:
        return None
    return (end / start) ** (1 / n_years) - 1


def report(s: dict) -> None:
    print(f"\n{'=' * 70}")
    print(f"{s['ticker']} — {s['name']} ({s['sic']})")
    print('=' * 70)

    rev = s["fy_revenue"]
    if rev:
        years = sorted(rev)[-6:]
        print(f"\nRevenue ({years[0]}-{years[-1]}):")
        for y in years:
            print(f"  FY{y}: {fmt_money(rev[y])}")
        print(f"  3y CAGR: {fmt_pct(cagr(rev, 3))}   5y CAGR: {fmt_pct(cagr(rev, 5))}")

    ni = s["fy_net_income"]
    op = s["fy_operating_income"]
    if ni:
        years = sorted(ni)[-5:]
        print(f"\nProfitability:")
        for y in years:
            r = rev.get(y)
            margin = (op.get(y) / r * 100) if (r and op.get(y) is not None) else None
            margin_str = f", OpMargin {margin:.1f}%" if margin is not None else ""
            print(f"  FY{y}: NI {fmt_money(ni[y])}, OpInc {fmt_money(op.get(y))}{margin_str}")

    sm, rd, ga = s["fy_sm_expense"], s["fy_rd_expense"], s["fy_ga_expense"]
    if sm or rd or ga:
        years = sorted(set(sm) | set(rd) | set(ga))[-4:]
        print(f"\nOpex breakdown (the eBay-style attack vector):")
        print(f"  {'Year':<6} {'S&M':>10} {'R&D':>10} {'G&A':>10} {'Total':>10} {'%Rev':>7}")
        for y in years:
            total = (sm.get(y) or 0) + (rd.get(y) or 0) + (ga.get(y) or 0)
            pct = total / rev[y] * 100 if rev.get(y) else None
            pct_str = f"{pct:>6.1f}%" if pct is not None else "    —  "
            print(f"  {y:<6} {fmt_money(sm.get(y)):>10} {fmt_money(rd.get(y)):>10} "
                  f"{fmt_money(ga.get(y)):>10} {fmt_money(total):>10} {pct_str}")

    sbc = s["fy_sbc"]
    if sbc:
        years = sorted(sbc)[-4:]
        print(f"\nStock-based comp (dilution / 'equity like candy'):")
        for y in years:
            ratio = sbc[y] / rev[y] * 100 if rev.get(y) else None
            tag = f"  ({ratio:.1f}% of revenue)" if ratio else ""
            print(f"  FY{y}: {fmt_money(sbc[y])}{tag}")

    bb = s["fy_buybacks"]
    if bb:
        years = sorted(bb)[-4:]
        print(f"\nBuybacks:")
        for y in years:
            print(f"  FY{y}: {fmt_money(bb[y])}")
        total_bb = sum(bb[y] for y in years)
        print(f"  Last {len(years)} years total: {fmt_money(total_bb)}")

    cash_d, cash = s["cash"]
    debt_d, debt = s["long_term_debt"]
    sh_d, sh = s["shares_outstanding"]
    print(f"\nBalance sheet & cap structure:")
    print(f"  Cash (as of {cash_d}): {fmt_money(cash)}")
    print(f"  LT debt (as of {debt_d}): {fmt_money(debt)}")
    if sh:
        print(f"  Shares outstanding (as of {sh_d}): {sh/1e6:.1f}M")
        if s["price_today"]:
            d, p = s["price_today"]
            mcap = sh * p
            print(f"  Last close ({d}): ${p:.2f}   Market cap: {fmt_money(mcap)}")

    print(f"\nTotal shareholder return (price only, dividends ignored):")
    print(f"  1y: {fmt_pct(s['tsr_1y'])}   3y: {fmt_pct(s['tsr_3y'])}   5y: {fmt_pct(s['tsr_5y'])}")


def main() -> None:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for ticker, cik in TICKERS.items():
        if only and ticker != only.upper():
            continue
        try:
            s = screen(ticker, cik)
            report(s)
        except Exception as e:
            print(f"\n{ticker}: ERROR {e}")


if __name__ == "__main__":
    main()
