# Mismanagement — Design Brief

A one-page brief to feed to claude.ai/design for mock variations. Skim the
top three sections, then look at the example data block at the bottom and
imagine 5–6 different ways to organise that information.

---

## 1. What this site is

A reader-facing site that ranks public US companies by how badly run they
appear to be. Every signal is computed deterministically from SEC filings —
no opinion text, no LLM-written tags, no editorial framing. The reader
looks at the numbers and decides what counts as failure.

The flagship page is called **Mismanagement**. It's a leaderboard. Each
company is scored on **8 binary red flags**; rank = number of flags fired.
Clicking through goes to a per-company page that shows the same 8 flags as
a scorecard, plus the underlying financials, comp data, board, insider
activity, and any 13D filings against the issuer.

**Tone:** Bloomberg terminal × literary magazine. Quantitative,
typographically confident, no exclamation marks, no emoji. The reader
should feel they are looking at primary data, not a hot take.

---

## 2. Visual identity (already locked in)

This site shares a design family with sibling MTS sites (`ufo`,
`court-transcripts`, etc.). Tokens are fixed — designs should respect them.

**Palette (dark only):**
```
--bg          #0e0e10   page background
--bg-1        #16161a   card background
--bg-2        #1c1c22   sunken / hover
--bg-topbar   #000000   absolute black topbar
--line        rgba(255,255,255,0.08)   hairline
--line-strong rgba(255,255,255,0.16)   stronger hairline
--ink         #e9eaee   primary text
--ink-strong  #ffffff   emphasis
--ink-dim     rgba(233,234,238,0.66)   secondary text
--ink-mute    rgba(233,234,238,0.42)   labels / meta
--accent      #ffd60a   MTS yellow (used sparingly for ticker, eyebrows)
--pos         #4ade80   gains, buys
--neg         #f87171   losses, sells, fired flags
--mts-red     #e63946   reserved for stronger negatives
```

**Type:**
- Body / UI sans: **Geist** (fallback: Söhne, system-ui)
- Tabular / labels mono: **Geist Mono** (fallback: JetBrains Mono)
- Display serif: **Instrument Serif** *italic* (used for page titles and
  company names — never for UI chrome)

**Existing pattern vocabulary:**
- Numeric tables use mono, tabular-nums, right-aligned numerics
- Eyebrows (small caps mono with 0.14–0.18em letter-spacing) above titles
- Cards: 1px line on `--bg-1`, 6–8px radius, no heavy shadow
- Tags (small mono pills): neutral / `.pos` green / `.neg` red

**Don't:**
- Use blue/purple gradients
- Use shadows for depth — use the 1px line instead
- Use bright colour fills beyond the accent yellow and red flag dots
- Use rounded-pill buttons or material-style elevation

---

## 3. Header (current)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  [MTS]  OVERVIEW  MISMANAGEMENT  ACTIVITY  COMP            [icons →]   │
└─────────────────────────────────────────────────────────────────────────┘
   black bar, sticky top, 14px vertical padding, 1px bottom hairline
   nav links: mono, 11px, 0.14em tracking, uppercase, --ink-dim
   active link: --accent (yellow) with rgba(255,214,10,0.10) bg + yellow border
```

- Left: a 26px MTS logo glyph that links to `/`
- Centre-left: page tabs (Overview, Mismanagement, Activity, Comp)
- Right: small social/source icons (GitHub, etc.)

Open question for the designer: **the header is currently very thin and
restrained.** That works for sibling sites but the Mismanagement leaderboard
is a denser, more "terminal-like" experience. Some mocks could explore a
slightly more substantive header — e.g. a single live stat ("147 companies
with 5+ flags fired") sitting at the right, or a global search.

---

## 4. The Mismanagement page — what we're aiming for

**The job of this page:** in 5 seconds, the reader should be able to
see who the worst-run companies are and why. They should be able to
scan a row and understand which specific things are wrong, not just a
score.

**Current layout (works, but room to grow):**
1. Title "Mismanagement" + one-paragraph dek
2. Legend block: 8 flags with one-line descriptions
3. Controls row: min market cap dropdown + "N of M companies"
4. Table: rank, company, market cap, TSR gap, 8-dot strip, evidence chips

**What the 8 dots represent:**

| Short | Long form                                                       |
|-------|-----------------------------------------------------------------|
| TSR   | Trailed peer-group TSR in 3+ of last 5 years                    |
| Pay   | Median PEO total comp ≥ $15M while underperforming peers        |
| 13D   | Active-intent 13D filed against issuer in last 18 months        |
| Insid | Net insider P − S < −$10M over last 12 months                   |
| Cash  | Operating cash flow < 80% of net income (latest FY)             |
| SBC   | Stock-based comp > 10% of revenue (latest FY)                   |
| Cap   | Buybacks + dividends exceed operating cash flow (latest FY)     |
| GW    | Goodwill > 40% of total assets (impairment exposure)            |

Each dot is red when fired, faint grey when not. Hovering a dot shows
which flag it is. Rows with 5+ flags fired get a subtle red wash.

**Ideas to explore in the mocks (the brief for claude.ai/design):**

- **Density vs. drama.** Right now every row is the same height. Should
  the top 10 (5+ flags) get a larger / more dramatic treatment with a
  short editorial sentence summarising the evidence chips? Or should
  every row be terminal-dense and the table itself just be long?
- **Flag strip alternatives.** The 8-dot strip works but is cryptic
  without the legend. Could the strip be 8 narrow vertical bars labelled
  T/P/D/I/$/S/C/G? A horizontal "checklist" with crossed-out passed
  flags? A radial 8-slice ring?
- **Evidence chips.** Currently rendered as red-tinted mono pills inline.
  Could they instead live in a sub-row, stacked, only on hot rows? Or
  hidden behind a "▸ details" expander?
- **Filters.** Right now we only have min-market-cap. Should there be a
  filter strip for: sector, "must have 13D", "must have insider selling",
  flag-count slider?
- **Sort.** Today it's fixed (flag count desc, TSR gap tiebreak). Should
  columns be sortable, or should we offer 2–3 named views (Worst overall /
  Most over-paid / Most insider-sold)?
- **Empty / fewer flags.** A company with 0–2 flags still ranks at the
  bottom of the table. Should those be visually de-emphasised, or hidden
  behind a "show clean" toggle?

---

## 5. The Company page — sections, in order

When the reader clicks a ticker, they land on `/company/:ticker`. Current
section list, top to bottom:

1. **Company header.** Big mono ticker (yellow, 56px), serif italic
   company name, then a row of meta: CIK · sector · exchange · HQ · etc.
2. **Mismanagement scorecard.** The same 8 flags, but rendered as a grid
   of cards instead of dots — each card states the rule, the company's
   number, and FIRED / OK.
3. **Fact sheet.** 2–3 paragraphs of plain English assembled from the
   numbers ("The CEO was paid $42M in 2024, the third year in a row above
   the $15M flag threshold. Insiders net sold $58M over the last 12
   months…"). No adjectives.
4. **Financials — latest fiscal years.** Table: revenue, net income, OCF,
   capex, SBC, buybacks, dividends, gross margin, by FY.
5. **Balance sheet — most recent quarter.** Cash, debt, goodwill, total
   assets, equity.
6. **Adjusted-close history.** Single yellow sparkline, ~5y.
7. **NEO compensation.** PEO / non-PEO comp table, plus PvP (pay vs.
   performance) sub-table when available.
8. **Board.** Members, related-party transactions block.
9. **Beneficial ownership.** ≥5% holders.
10. **Insider activity — last 365 days.** Form 4 transactions.
11. **13D / 13G filings.** Schedule 13D/G filings against this issuer.

**Open design question for the company page:**
- Is the **scorecard at the top** the right anchor, or should the fact
  sheet (prose) come first? The scorecard is information-dense; the fact
  sheet is more inviting. Both work — the mocks should try at least one of
  each.
- The current page is a vertical stack. Could the right rail show a
  permanent "scorecard summary" while the left scrolls through detail
  sections? On wide screens that would let the reader keep the flags in
  view while reading financials.

---

## 6. Example data: OKTA (Okta, Inc.)

A real row from the current leaderboard. Use this as the test case in
every mock.

### Mismanagement row

```
Rank:        #3
Flags:       5 of 8 fired
Ticker:      OKTA
Name:        Okta, Inc.
Sector:      Services-Prepackaged Software
Market cap:  $13.4B
TSR gap:     −$48  (peer 100→152, OKTA 100→104 over PvP window)
```

8-flag strip (● = fired red, ○ = passed):

```
TSR  Pay  13D  Insid  Cash  SBC  Cap  GW
 ●    ○    ○    ●     ○    ●    ○    ●
```

Evidence chips that would render on this row:

- `Trailed peers 4/5y`
- `Insiders net sold $58M`
- `SBC 32% of revenue`
- `Goodwill 47% of assets`

### Company page — same data, expanded

**Header**
- Ticker: `OKTA` (yellow mono)
- Name: *Okta, Inc.*
- Meta: CIK 1660134 · Services-Prepackaged Software · NASDAQ · San Francisco, CA

**Scorecard (8 cards):**

| Flag                              | Rule                                | Value                  | Status |
|-----------------------------------|-------------------------------------|------------------------|--------|
| Underperformed peers (TSR)        | trailed peers in 3+ of last 5 yrs   | 4/5 years              | FIRED  |
| Over-paid (Pay)                   | median PEO comp ≥ $15M              | $12.3M median          | OK     |
| Active 13D                        | active-intent 13D in last 18 mo     | 0 filings              | OK     |
| Insider selling                   | net P − S < −$10M (TTM)             | −$58.1M                | FIRED  |
| Earnings vs. cash                 | OCF < 80% of NI                     | OCF $625M / NI $-355M  | OK*    |
| Dilutive SBC                      | SBC > 10% of revenue                | 32%                    | FIRED  |
| Capital returns over FCF          | buybacks + divs > OCF               | $0 returns vs $625M    | OK     |
| Goodwill-heavy                    | goodwill > 40% of assets            | 47%                    | FIRED  |

\* OK because net income is negative — flag rule skips this case.

**Fact sheet (illustrative prose):**

> **Pay & performance.** Okta's PEO has received a median $12.3M in
> reported total compensation over the last 4 disclosed years, while
> Okta's compensation-actually-paid figure has trailed its peer-group
> initial-value index in 4 of those 5 years.
>
> **Insider activity.** Over the last 12 months insiders have net sold
> $58.1M of stock against zero open-market purchases.
>
> **Balance sheet.** Goodwill stands at $5.4B against $11.6B of total
> assets — 47% — concentrated from the Auth0 acquisition in 2021.

**Financials table:**

| FY    | Revenue | Net income | OCF    | Capex | SBC    | Buybacks | Dividends |
|-------|---------|------------|--------|-------|--------|----------|-----------|
| 2024  | $2.61B  | −$355M     | $625M  | $14M  | $828M  | $0       | $0        |
| 2023  | $1.86B  | −$815M     | $89M   | $12M  | $760M  | $0       | $0        |
| 2022  | $1.30B  | −$848M     | −$24M  | $18M  | $551M  | $0       | $0        |

**Balance sheet (latest quarter):**

| Cash & equivalents | Long-term debt | Goodwill | Total assets | Equity |
|--------------------|----------------|----------|--------------|--------|
| $2.51B             | $1.08B         | $5.41B   | $11.58B      | $6.94B |

**NEO compensation (latest FY):**

| Officer            | Role | Base    | Bonus | Stock awards | Option awards | Total      |
|--------------------|------|---------|-------|--------------|---------------|------------|
| Todd McKinnon      | PEO  | $1      | $0    | $40.0M       | $0            | $40.0M     |
| Brett Tighe        | CFO  | $470k   | $0    | $7.1M        | $0            | $7.6M      |

**Pay vs. performance (PvP table):**

| FY    | PEO comp reported | PEO comp actually paid | Company TSR ($100→) | Peer TSR ($100→) | Net income |
|-------|-------------------|------------------------|---------------------|------------------|------------|
| 2024  | $40.0M            | $11.3M                 | $104                | $152             | −$355M     |
| 2023  | $4.0M             | −$71.4M                | $84                 | $138             | −$815M     |
| 2022  | $32.7M            | −$104.4M               | $79                 | $112             | −$848M     |
| 2021  | $76.8M            | $111.2M                | $208                | $124             | −$266M     |
| 2020  | $5.1M             | $90.4M                 | $202                | $116             | −$208M     |

**Board (illustrative — abbreviated):**

| Director              | Role            | Independent | Tenure | Committees           |
|-----------------------|-----------------|-------------|--------|----------------------|
| Todd McKinnon         | Chair, CEO      | No          | 17y    | —                    |
| Frederic Kerrest      | Vice Chair, EVP | No          | 17y    | —                    |
| Patrick Grady         | Director        | Yes         | 14y    | Comp                 |
| Michelle Wilson       | Lead Indep.     | Yes         | 5y     | Audit, Nom-Gov       |
| (… 5 more …)          |                 |             |        |                      |

**Insider activity (last 365 days, summarised):**

| Insider             | Role     | Buys | Sells   | Net      |
|---------------------|----------|------|---------|----------|
| Todd McKinnon       | CEO      | $0   | −$22.4M | −$22.4M  |
| Frederic Kerrest    | EVP      | $0   | −$14.1M | −$14.1M  |
| Brett Tighe         | CFO      | $0   | −$5.8M  | −$5.8M   |
| (… 6 more …)        |          |      |         | −$15.8M  |
| **Total**           |          | $0   | −$58.1M | **−$58.1M** |

**13D / 13G filings against OKTA (latest 18 months):** none.

---

## 7. What the designer should produce

5–6 distinct directions for **the Mismanagement page** + **the
top-of-company-page (header + scorecard)** rendered with the OKTA data
above. Variation should be on layout and information hierarchy, *not* on
palette / type — those are fixed.

Things it's OK to invent for the sake of layout:
- Iconography for the 8 flags (today they're just dots)
- A small sparkline shape next to each row
- Sector taxonomy chips
- A "since X date" timestamp strip

Things to keep:
- Dark background, MTS yellow accent, mono for numbers, serif italic for
  titles
- No editorial adjectives — every number on the page must be auditable
- Red dots / red wash for fired flags is the visual centerpiece; don't
  bury it
