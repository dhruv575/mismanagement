"""
Stage 2 governance-screen extraction — Etsy DEF 14A 2026.

Downloads Etsy's most recent proxy from EDGAR, strips XBRL noise while
keeping table structure intact, then hands it to Gemini 3 Flash via
OpenRouter with a structured-output schema. Saves the extracted JSON
to data/etsy-2026-def14a.json.

Run: python stage2_etsy.py
"""
from __future__ import annotations
import json
import os
import sys
import urllib.request
from pathlib import Path

# Force UTF-8 stdout on Windows so we can print unicode and the cleaned HTML
# byte counts don't trip cp1252.
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from bs4 import BeautifulSoup, Tag
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

OPENROUTER_KEY = os.environ["OPENROUTER_API_KEY"]
EDGAR_UA = "MTS Editorial dhruvgup@seas.upenn.edu"
MODEL = "google/gemini-3-flash-preview"

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)


# Pre-configured issuers. Each entry tells us where to find the most recent
# DEF 14A on EDGAR and what fiscal year it covers. Add more by appending.
ISSUERS: dict[str, dict] = {
    "ETSY": {
        "issuer": "Etsy, Inc.",
        "cik": "0001370637",
        "proxy_url": "https://www.sec.gov/Archives/edgar/data/1370637/000137063726000026/etsy-20260417.htm",
        "filing_date": "2026-04-17",
        "accession_number": "0001370637-26-000026",
        "fiscal_year_covered": 2025,
        "slug": "etsy-2026",
    },
    "EBAY": {
        "issuer": "eBay Inc.",
        "cik": "0001065088",
        "proxy_url": "https://www.sec.gov/Archives/edgar/data/1065088/000155278126000285/e26002_ebay-def14a.htm",
        "filing_date": "2026-04-30",
        "accession_number": "0001552781-26-000285",
        "fiscal_year_covered": 2025,
        "slug": "ebay-2026",
    },
}


def paths_for(slug: str) -> tuple[Path, Path, Path]:
    return (
        DATA_DIR / f"{slug}-def14a.html",
        DATA_DIR / f"{slug}-def14a-clean.html",
        DATA_DIR / f"{slug}-def14a.json",
    )


def fetch_proxy(url: str, dest: Path) -> str:
    if dest.exists():
        return dest.read_text(encoding="utf-8")
    req = urllib.request.Request(
        url, headers={"User-Agent": EDGAR_UA, "Accept-Encoding": "identity"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode("utf-8", errors="replace")
    dest.write_text(body, encoding="utf-8")
    return body


def clean_html(raw: str) -> str:
    """Drop scripts, styles, hidden XBRL blocks, and presentation-only attrs.
    Keep tables, headings, paragraphs, lists. The goal is to give Gemini the
    visible reader-facing document at ~30% of the original byte size."""
    soup = BeautifulSoup(raw, "html.parser")

    for tag in soup(["script", "style", "meta", "link"]):
        tag.decompose()

    # XBRL inline tagging produces an `<ix:header>` block at the top of the
    # document plus `ix:hidden` regions throughout. The visible text inside
    # `ix:nonNumeric` / `ix:nonFraction` wrappers is what we want -- unwrap
    # those, drop the rest. Decompose first (mutates tree), then unwrap the
    # remaining ix tags from a re-collected list (skipping anything orphaned
    # by the prior decompose pass).
    for tag in list(soup.find_all(
        lambda t: isinstance(t, Tag) and t.name and t.name.startswith(("ix:header", "ix:hidden", "ix:references", "ix:resources"))
    )):
        tag.decompose()
    for tag in list(soup.find_all(
        lambda t: isinstance(t, Tag) and t.name and t.name.startswith("ix:")
    )):
        if tag.parent is not None:
            tag.unwrap()

    # CSS classes / inline styles waste tokens without helping the VLM.
    for tag in soup.find_all(True):
        for attr in ("style", "class", "id", "lang", "dir", "data-*"):
            if attr.endswith("*"):
                continue
            if attr in tag.attrs:
                del tag.attrs[attr]

    # Body only — no <head>.
    body = soup.body or soup
    return str(body)


SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "summary_compensation": {
            "type": "array",
            "description": "One row per (named executive officer, fiscal year) combination "
                           "in the Summary Compensation Table. All dollar amounts in dollars, not thousands.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string"},
                    "title": {"type": "string"},
                    "fiscal_year": {"type": "integer"},
                    "salary": {"type": ["number", "null"]},
                    "bonus": {"type": ["number", "null"]},
                    "stock_awards": {"type": ["number", "null"]},
                    "option_awards": {"type": ["number", "null"]},
                    "non_equity_incentive_plan": {"type": ["number", "null"]},
                    "change_in_pension_value": {"type": ["number", "null"]},
                    "all_other_compensation": {"type": ["number", "null"]},
                    "total": {"type": ["number", "null"]},
                },
                "required": ["name", "title", "fiscal_year", "total"],
            },
        },
        "all_other_compensation_detail": {
            "type": "array",
            "description": "Itemization of the 'All Other Compensation' column from the footnote. "
                           "This is where personal aircraft, security, club dues, financial planning, "
                           "tax gross-ups appear.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string"},
                    "fiscal_year": {"type": "integer"},
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "category": {"type": "string",
                                             "description": "e.g. 'personal aircraft', 'security', "
                                                            "'401(k) match', 'tax gross-up', 'relocation'"},
                                "amount": {"type": ["number", "null"]},
                                "description": {"type": "string"},
                            },
                            "required": ["category", "amount"],
                        },
                    },
                },
                "required": ["name", "fiscal_year", "items"],
            },
        },
        "ceo_pay_ratio": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "ceo_total_compensation": {"type": ["number", "null"]},
                "median_employee_compensation": {"type": ["number", "null"]},
                "ratio_x_to_1": {"type": ["number", "null"],
                                 "description": "e.g. if ratio is 423:1, return 423"},
                "fiscal_year": {"type": ["integer", "null"]},
            },
        },
        "pay_versus_performance": {
            "type": "array",
            "description": "The Dodd-Frank Pay-vs-Performance table. One row per fiscal year shown.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "year": {"type": "integer"},
                    "ceo_compensation_actually_paid": {"type": ["number", "null"]},
                    "average_neo_compensation_actually_paid": {"type": ["number", "null"]},
                    "company_tsr_indexed": {"type": ["number", "null"],
                                            "description": "value of $100 invested at start of period"},
                    "peer_group_tsr_indexed": {"type": ["number", "null"]},
                    "gaap_net_income": {"type": ["number", "null"]},
                    "company_selected_measure_name": {"type": ["string", "null"]},
                    "company_selected_measure_value": {"type": ["number", "null"]},
                },
                "required": ["year"],
            },
        },
        "director_compensation": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string"},
                    "fees_earned_or_paid_in_cash": {"type": ["number", "null"]},
                    "stock_awards": {"type": ["number", "null"]},
                    "option_awards": {"type": ["number", "null"]},
                    "non_equity_incentive": {"type": ["number", "null"]},
                    "all_other_compensation": {"type": ["number", "null"]},
                    "total": {"type": ["number", "null"]},
                },
                "required": ["name", "total"],
            },
        },
        "board": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string"},
                    "age": {"type": ["integer", "null"]},
                    "director_since_year": {"type": ["integer", "null"]},
                    "independent": {"type": ["boolean", "null"]},
                    "is_chair": {"type": ["boolean", "null"]},
                    "is_lead_independent_director": {"type": ["boolean", "null"]},
                    "committees": {"type": "array", "items": {"type": "string"}},
                    "other_public_boards": {"type": "array", "items": {"type": "string"},
                                            "description": "company names of other public boards served"},
                    "attendance_below_75pct": {"type": ["boolean", "null"]},
                },
                "required": ["name"],
            },
        },
        "board_structure": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "classified_board": {"type": ["boolean", "null"],
                                     "description": "true if directors elected for staggered terms"},
                "dual_class_voting": {"type": ["boolean", "null"]},
                "chair_ceo_combined": {"type": ["boolean", "null"]},
                "lead_independent_director_name": {"type": ["string", "null"]},
                "shareholder_proposal_threshold": {"type": ["string", "null"]},
                "majority_voting_for_directors": {"type": ["boolean", "null"]},
            },
        },
        "related_party_transactions": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "description": {"type": "string"},
                    "parties": {"type": "array", "items": {"type": "string"}},
                    "amount_or_terms": {"type": "string"},
                },
                "required": ["description"],
            },
        },
        "equity_ownership": {
            "type": "array",
            "description": "Beneficial-ownership table — 5%+ holders and named officers/directors.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string"},
                    "type": {"type": "string", "description": "'5pct_holder', 'officer', 'director', 'all_directors_and_officers'"},
                    "shares": {"type": ["number", "null"]},
                    "percent_class": {"type": ["number", "null"]},
                },
                "required": ["name", "type"],
            },
        },
        "compensation_consultants": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string"},
                    "scope": {"type": "string"},
                    "fees_paid": {"type": ["number", "null"]},
                },
                "required": ["name"],
            },
        },
        "peer_group": {
            "type": "array",
            "description": "Companies named as eXtsy's compensation peer group.",
            "items": {"type": "string"},
        },
        "say_on_pay": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "last_vote_year": {"type": ["integer", "null"]},
                "last_vote_approval_pct": {"type": ["number", "null"]},
            },
        },
    },
    "required": ["summary_compensation", "board"],
}


SYSTEM_PROMPT = """You are a financial-document extraction model. You extract structured \
data from US SEC DEF 14A proxy statements.

Rules:
1. All dollar amounts are in dollars (not thousands). If the proxy reports "$1,234" \
treat it as 1234. If it reports "(in thousands) $1,234" treat it as 1234000.
2. Use the values exactly as printed; do not infer or compute totals the company \
did not print. Do not characterize, interpret, or editorialize -- extract facts.
3. If a field is not present in the document, return null. Do not hallucinate.
4. Return only a single JSON object -- no prose, no code fences, no commentary."""


def extract_json(s: str) -> dict:
    """Tolerant JSON extraction. Mirrors the pattern used in the UFO project's
    openrouter.ts: strip ```json fences, then walk forward through the text
    finding balanced top-level objects until one parses. Gemini sometimes
    appends a self-critique block after the primary JSON; we want the first
    valid object."""
    # Strip code fences
    import re
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", s)
    text = (fenced.group(1) if fenced else s).strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Walk for balanced objects
    candidates: list[str] = []
    i = 0
    while i < len(text):
        if text[i] != "{":
            i += 1
            continue
        start = i
        depth = 0
        in_str = False
        esc = False
        while i < len(text):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                i += 1
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidates.append(text[start:i + 1])
                    i += 1
                    break
            i += 1
        else:
            break  # unbalanced — give up

    for c in candidates:
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            continue
    raise ValueError(f"Could not parse JSON; first 300 chars: {text[:300]}")


def call_gemini(html: str, issuer: str, fy: int) -> dict:
    # Embed the schema description in the prompt rather than relying on
    # provider-side strict json-schema enforcement -- Gemini-3 support varies
    # across OpenRouter providers (per UFO project comment in openrouter.ts).
    user_prompt = (
        f"Extract structured data from this {issuer} DEF 14A. The fiscal year "
        f"covered is {fy}. Pay-vs-Performance typically shows 5 years.\n\n"
        "Return a single JSON object matching this exact schema "
        "(all fields required unless wrapped in [\"...\", \"null\"]):\n\n"
        + json.dumps(SCHEMA, indent=2)
        + "\n\n=== PROXY HTML ===\n" + html
    )
    payload = {
        "model": MODEL,
        "max_tokens": 32768,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {OPENROUTER_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://activist-investing.mts.now",
            "X-Title": "MTS Activist Investing Editorial",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        resp = json.loads(r.read())
    content = resp["choices"][0]["message"]["content"]
    usage = resp.get("usage", {})
    print(f"  prompt tokens: {usage.get('prompt_tokens', '?'):,}  "
          f"completion: {usage.get('completion_tokens', '?'):,}")
    return extract_json(content)


def run(ticker: str) -> dict:
    cfg = ISSUERS[ticker]
    raw_path, clean_path, json_path = paths_for(cfg["slug"])

    print(f"-> Fetching {cfg['issuer']} DEF 14A ({cfg['filing_date']})…")
    raw = fetch_proxy(cfg["proxy_url"], raw_path)
    print(f"  raw HTML: {len(raw):,} bytes")

    print("-> Cleaning XBRL + scripts…")
    clean = clean_html(raw)
    clean_path.write_text(clean, encoding="utf-8")
    print(f"  cleaned HTML: {len(clean):,} bytes (~{len(clean)//4:,} tokens est.)")

    if json_path.exists():
        print(f"  cached extract found at {json_path.name} -- reusing")
        return json.loads(json_path.read_text(encoding="utf-8"))

    print(f"-> Calling {MODEL} via OpenRouter…")
    extracted = call_gemini(clean, cfg["issuer"], cfg["fiscal_year_covered"])
    extracted["_meta"] = {k: v for k, v in cfg.items() if k != "proxy_url"}
    json_path.write_text(json.dumps(extracted, indent=2), encoding="utf-8")
    print(f"  extracted -> {json_path}")
    return extracted


def main() -> None:
    ticker = sys.argv[1].upper() if len(sys.argv) > 1 else "ETSY"
    if ticker not in ISSUERS:
        print(f"Unknown ticker {ticker}. Available: {list(ISSUERS)}")
        sys.exit(1)
    extracted = run(ticker)
    summarize(extracted)


def summarize(d: dict) -> None:
    meta = d.get("_meta") or {}
    print("\n" + "=" * 70)
    print(f"{meta.get('issuer', '?')} DEF 14A {meta.get('filing_date', '')} -- "
          f"FY{meta.get('fiscal_year_covered', '?')}")
    print("=" * 70)

    sc = d.get("summary_compensation", [])
    if sc:
        print(f"\nSummary Compensation Table — {len(sc)} rows")
        for r in sc:
            total = r.get("total")
            print(f"  FY{r.get('fiscal_year')} {r.get('name'):<25} {r.get('title'):<35} "
                  f"${(total or 0)/1e6:>6.2f}M")

    aoc = d.get("all_other_compensation_detail", [])
    if aoc:
        print(f"\nAll Other Compensation breakdown — {len(aoc)} executive-years")
        for r in aoc:
            print(f"  FY{r.get('fiscal_year')} {r.get('name')}:")
            for it in r.get("items", []):
                amt = it.get("amount")
                print(f"    - {it.get('category'):<30} ${(amt or 0):>10,.0f}  {it.get('description', '')[:50]}")

    cpr = d.get("ceo_pay_ratio") or {}
    if cpr.get("ratio_x_to_1") is not None:
        print(f"\nCEO Pay Ratio (FY{cpr.get('fiscal_year')}): "
              f"{cpr['ratio_x_to_1']:.0f}:1  "
              f"(CEO ${(cpr.get('ceo_total_compensation') or 0)/1e6:.2f}M / "
              f"median ${cpr.get('median_employee_compensation', 0):,.0f})")

    pvp = d.get("pay_versus_performance", [])
    if pvp:
        print(f"\nPay-vs-Performance — {len(pvp)} years")
        print(f"  {'Year':<6} {'CEO CAP':>12} {'Co. TSR':>10} {'Peer TSR':>10} {'Net Inc':>12}")
        for r in pvp:
            print(f"  {r.get('year'):<6} "
                  f"${(r.get('ceo_compensation_actually_paid') or 0)/1e6:>10.2f}M "
                  f"{r.get('company_tsr_indexed', '—'):>10} "
                  f"{r.get('peer_group_tsr_indexed', '—'):>10} "
                  f"${(r.get('gaap_net_income') or 0)/1e6:>10.1f}M")

    bd = d.get("board", [])
    if bd:
        print(f"\nBoard — {len(bd)} directors")
        for r in bd:
            tags = []
            if r.get("is_chair"): tags.append("Chair")
            if r.get("is_lead_independent_director"): tags.append("LID")
            if r.get("independent") is False: tags.append("NOT-IND")
            if r.get("attendance_below_75pct"): tags.append("LOW-ATTEND")
            tagstr = " ".join(f"[{t}]" for t in tags)
            other = r.get("other_public_boards") or []
            other_str = f"  +{len(other)} other boards" if other else ""
            since = r.get("director_since_year")
            fy = (meta.get("fiscal_year_covered") or 0) + 1
            tenure = (fy - since) if (since and fy) else None
            tenure_str = f"  {tenure}y" if tenure else ""
            print(f"  {r.get('name'):<30} age {str(r.get('age') or '—'):>3}{tenure_str}{other_str}  {tagstr}")

    rpt = d.get("related_party_transactions", [])
    print(f"\nRelated-party transactions: {len(rpt)}")
    for r in rpt:
        amt = r.get("amount_or_terms") or ""
        print(f"  - {r.get('description', '')[:100]}  {amt[:60]}")

    bs = d.get("board_structure") or {}
    if bs:
        print("\nBoard structure:")
        for k, v in bs.items():
            print(f"  {k}: {v}")

    dc = d.get("director_compensation", [])
    if dc:
        print(f"\nDirector compensation -- {len(dc)} non-employee directors")
        for r in dc:
            cash = r.get("fees_earned_or_paid_in_cash") or 0
            stock = r.get("stock_awards") or 0
            other = r.get("all_other_compensation") or 0
            total = r.get("total") or 0
            print(f"  {r.get('name'):<30} cash ${cash:>9,.0f}  stock ${stock:>9,.0f}  "
                  f"other ${other:>7,.0f}  total ${total:>9,.0f}")

    eo = d.get("equity_ownership", [])
    if eo:
        print(f"\nBeneficial ownership -- {len(eo)} entries")
        for r in eo:
            sh = r.get("shares")
            sh_s = f"{sh:>13,.0f}" if isinstance(sh, (int, float)) else f"{'?':>13}"
            pct = r.get("percent_class")
            pct_s = f"{pct:>5.2f}%" if isinstance(pct, (int, float)) else f"{'?':>6}"
            print(f"  {r.get('type'):<22} {r.get('name')[:38]:<38}  {sh_s}  {pct_s}")

    pg = d.get("peer_group") or []
    if pg:
        print(f"\nCompensation peer group ({len(pg)} companies):")
        # 5 per line
        for i in range(0, len(pg), 5):
            print("  " + ", ".join(pg[i:i+5]))

    cc = d.get("compensation_consultants") or []
    if cc:
        print(f"\nCompensation consultants:")
        for r in cc:
            fee = r.get("fees_paid")
            fee_s = f"  fees ${fee:,.0f}" if fee else ""
            print(f"  {r.get('name')}{fee_s}")
            if r.get("scope"):
                print(f"    scope: {r['scope'][:120]}")

    sop = d.get("say_on_pay") or {}
    if sop.get("last_vote_year") is not None:
        print(f"\nSay-on-pay vote: {sop.get('last_vote_year')} approval "
              f"{sop.get('last_vote_approval_pct')}%")


if __name__ == "__main__":
    main()
