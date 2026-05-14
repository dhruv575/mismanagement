// Every term that appears on a company page, defined once and ordered
// the same way the reader meets them. Flags first, then the numerics
// row, then prose cards, then each table section below the hero. Each
// entry carries a concrete example so the abstract rule becomes legible.

interface Term {
  /** Short label as the reader sees it on the page. */
  label: string;
  /** Companion phrase (e.g. the long form of an abbreviation). */
  aka?: string;
  /** One-line definition in plain English. */
  def: string;
  /** Concrete example showing the term in action. Mostly OKTA-grounded
   *  for continuity; the company-page brief uses OKTA throughout. */
  example: string;
  /** Filing or table the value is computed from. */
  source: string;
}

interface Group {
  /** Section title — mirrors the eyebrow on the company page. */
  title: string;
  /** Optional one-line note about what this section is for. */
  note?: string;
  terms: Term[];
}

const GROUPS: Group[] = [
  {
    title: "The scorecard",
    note:
      "Nine binary flags. A flag fires when a deterministic rule (pure SQL over the fact tables) returns true. Ranking on /mismanagement is the count of fired flags.",
    terms: [
      {
        label: "TSR",
        aka: "Trailed peers",
        def: "If you invested $100 in this company or invested $100 across its peers, which would give you a higher return? The flag fires when the peer group beat the company in 3 or more of the last 5 disclosed fiscal years.",
        example:
          "OKTA: $100 invested at the start of FY2022 became $33 at the end of FY2026; the same $100 in the peer group became $256 — trailed in 4 of 5 years.",
        source: "DEF 14A pay-vs-performance table",
      },
      {
        label: "Pay",
        aka: "Paid through it",
        def: "Was the CEO still getting paid over $15 million while the company underperformed its peers? Fires when median principal-executive-officer (PEO, i.e. CEO) total compensation across disclosed years is at least $15M AND the TSR flag is also firing.",
        example:
          "Salesforce's median PEO comp over the 5 pay-vs-performance (PvP) years is ~$28M; over the same window company TSR trailed peers — both halves of the rule fire.",
        source: "DEF 14A summary compensation table + PvP",
      },
      {
        label: "13D",
        aka: "Active 13D",
        def: "Have any outside entities accumulated over 5% of the company in the past 18 months with the disclosed intent to influence control, board, or strategy? That's the filing every activist campaign starts with.",
        example:
          "Elliott Management filed a 13D on Salesforce in Jan 2023 citing intent to push for board changes and operating-margin discipline.",
        source: "Schedule 13D filings",
      },
      {
        label: "Insid",
        aka: "Insider selling",
        def: "Have the company's executives and insiders been buying or selling the company's equity? The flag fires when net open-market activity (purchases minus sales) over the last 12 months is worse than −$10M.",
        example:
          "OKTA TTM: $267K bought versus $58.4M sold across 11 reporting persons → −$58.1M net.",
        source: "Form 4",
      },
      {
        label: "Cash",
        aka: "Earnings ≠ cash",
        def: "Is the profit the company reports actually showing up as cash in the bank? Fires when operating cash flow in the latest fiscal year is less than 80% of GAAP net income — i.e. the income statement is outpacing the cash statement.",
        example:
          "A company reporting $1.0B net income but only $0.6B OCF (60%) fires — cash conversion below threshold.",
        source: "10-K / 10-Q",
      },
      {
        label: "SBC",
        aka: "Dilutive SBC",
        def: "Is the company giving away an unusually large slice of itself each year as employee stock compensation? Fires when stock-based comp in the latest fiscal year is greater than 10% of revenue.",
        example:
          "OKTA FY2024: $828M SBC against $2.61B revenue → 32% of revenue.",
        source: "10-K / 10-Q",
      },
      {
        label: "Cap",
        aka: "Returns over OCF",
        def: "Is the company spending more on buybacks and dividends than the cash it actually generates from operations? Fires when buybacks plus dividends in the latest fiscal year exceed operating cash flow — i.e. capital returns are being funded with debt or the balance sheet, not earnings.",
        example:
          "Boeing FY2022: $5.0B in buybacks + dividends against ~$3.5B OCF → fires; the gap was funded with debt.",
        source: "10-K cash-flow statement",
      },
      {
        label: "GW",
        aka: "Goodwill heavy",
        def: "Has the company spent so much buying other businesses that the premium it paid for them now dominates its balance sheet? Goodwill is the accounting plug for that premium and gets written down if acquisitions underperform. Fires when goodwill is greater than 40% of total assets.",
        example:
          "OKTA: $5.41B goodwill / $11.58B total assets → 47%, mostly from the Auth0 acquisition.",
        source: "10-K / 10-Q balance sheet",
      },
      {
        label: "Vote",
        aka: "Vote dissent",
        def: "At the last annual meeting, did shareholders meaningfully push back against executive pay or any specific director? Fires when the advisory say-on-pay (SoP) vote received less than 80% support — For / (For + Against) — or any director nominee received less than 80% support — For / (For + Withheld). 80% is the threshold at which boards typically start to address dissent.",
        example:
          "OKTA FY2024: SoP 92% support, lowest director support 96%. Flag does not fire.",
        source: "8-K Item 5.07 (filed within 4 business days of the annual meeting)",
      },
    ],
  },
  {
    title: "Key numerics (hero row)",
    terms: [
      {
        label: "Market cap",
        def: "Shares outstanding × latest adjusted close. Computed at the time the Russell-3000 universe was pulled; not real-time.",
        example: "OKTA: 173M shares × $77 = $13.4B.",
        source: "Company filings + Yahoo Finance",
      },
      {
        label: "TSR gap",
        def: "Peer-group indexed TSR minus company indexed TSR for the latest disclosed PvP year, in dollars per $100 invested. A negative number means the company trailed.",
        example: "OKTA: peer $256 − OKTA $33 = −$223 per $100 over the FY2022→FY2026 window.",
        source: "DEF 14A pay-vs-performance",
      },
      {
        label: "Insider TTM",
        def: "Trailing-12-month net dollar value of insider open-market activity. Positive = net buying, negative = net selling. Routine 10b5-1 plan sales count.",
        example: "OKTA: −$58.1M means insiders net sold $58.1M of OKTA stock over the trailing year.",
        source: "Form 4",
      },
    ],
  },
  {
    title: "Compensation card / NEO table",
    terms: [
      {
        label: "PEO",
        aka: "Principal Executive Officer",
        def: "SEC's term for the CEO in compensation disclosures. The PEO row in PvP is the year's serving CEO.",
        example: "Todd McKinnon, OKTA's CEO, is the PEO in OKTA's PvP table for every year he served.",
        source: "DEF 14A",
      },
      {
        label: "NEO",
        aka: "Named Executive Officer",
        def: "The PEO, the CFO, and the next-three most-highly-compensated officers. Each gets a row in the summary compensation table.",
        example:
          "OKTA FY2024 NEOs: McKinnon (PEO), Brett Tighe (CFO), plus three EVPs — five rows in the SCT.",
        source: "DEF 14A",
      },
      {
        label: "Total compensation",
        def: "Sum of salary, bonus, stock awards (grant-date fair value), option awards, non-equity incentive, and all other compensation. Reported, not realized.",
        example:
          "McKinnon FY2024: $1 salary + $0 bonus + $40.0M stock awards + $0 options + $0 non-equity + ~$20K other = $40.0M.",
        source: "DEF 14A summary compensation table",
      },
      {
        label: "CEO pay ratio",
        def: "Reported CEO total compensation divided by the company's median-employee compensation. Disclosed annually.",
        example: "OKTA FY2024: $36.8M CEO comp / $205,371 median employee = 179:1.",
        source: "DEF 14A",
      },
    ],
  },
  {
    title: "Performance card / PvP table",
    note:
      "The pay-vs-performance disclosure was added by SEC rule in 2022. It re-states comp using a market-value framework and tags it against indexed TSR + peer TSR.",
    terms: [
      {
        label: "Indexed TSR",
        def: "Value of $100 invested in the stock at the start of the disclosure period, reinvesting dividends, marked to the end of each fiscal year.",
        example: "$100 in OKTA on the first day of FY2022 → $33 at the end of FY2026.",
        source: "DEF 14A PvP",
      },
      {
        label: "Peer group TSR",
        def: "Same $100-invested calculation against the issuer's self-stated peer group from the same proxy statement.",
        example: "OKTA's peer group $100 → $256 over the same FY2022→FY2026 period.",
        source: "DEF 14A PvP",
      },
      {
        label: "Compensation actually paid",
        def: "PEO/NEO comp re-stated under the PvP rule: vested equity is marked at year-end value, not grant-date. Can swing wildly with the stock price.",
        example:
          "McKinnon's reported $40.0M in FY2024 became $11.3M actually paid after stock-price marks; in FY2023 his reported $4.0M became −$71.4M.",
        source: "DEF 14A PvP",
      },
      {
        label: "GAAP net income",
        def: "Bottom-line earnings under US GAAP. Pulled from the income statement, not the proxy.",
        example: "OKTA FY2024: −$355M net loss.",
        source: "10-K",
      },
    ],
  },
  {
    title: "Activity card / Insider table",
    terms: [
      {
        label: "Form 4",
        def: "SEC form an insider files within two business days of a transaction in the issuer's stock. Buys, sells, option exercises, gifts all show up.",
        example:
          "Frederic Kerrest filed Form 4 on 2024-03-15 reporting a $5.0M sale at $90.12/share under a 10b5-1 plan.",
        source: "SEC EDGAR",
      },
      {
        label: "Open-market acquisition",
        def: "Insider bought shares at the prevailing market price using their own money — distinct from option exercises or grants.",
        example: "A director buys 5,000 shares at $73.10 → coded P, transaction value $365,500.",
        source: "Form 4, code P",
      },
      {
        label: "Disposition",
        def: "Insider sold or otherwise transferred shares. Includes option-exercise-and-sell.",
        example: "Officer sells 50,000 shares under a 10b5-1 plan at $92.00 → coded S, value $4.6M.",
        source: "Form 4, code S (and others)",
      },
      {
        label: "Net flow",
        def: "Sum of acquisition dollar values minus sum of disposition dollar values over the lookback window.",
        example: "OKTA last 90d: $267K bought − $5.4M sold = −$5.1M net.",
        source: "Form 4",
      },
      {
        label: "Schedule 13D",
        def: "Required when an investor (or group) crosses 5% ownership and intends to influence the company. Filed within 5 business days.",
        example:
          "Elliott crosses 5% of Salesforce on 2023-01-22 → filed 13D within 5 business days disclosing intent to push for cost cuts.",
        source: "SEC EDGAR",
      },
      {
        label: "Schedule 13G",
        def: "Same 5% threshold as 13D but for passive holders — institutional investors with no intent to influence.",
        example:
          "Vanguard's 10.3% stake in OKTA disclosed on 2024-07-09 was filed as a 13G — passive.",
        source: "SEC EDGAR",
      },
      {
        label: "Active intent",
        def: "Filer's stated purpose in the 13D includes board nominations, strategy changes, M&A, or another control-related goal — as opposed to passive holding.",
        example:
          "Carl Icahn's 13D against Illumina cited 'board nominations' in Item 4 → counts as active intent.",
        source: "Schedule 13D · Item 4",
      },
    ],
  },
  {
    title: "Financials table",
    terms: [
      {
        label: "Revenue",
        def: "Top-line net revenue (or net sales) for the fiscal year as reported in XBRL tagging.",
        example: "OKTA FY2024: $2.61B.",
        source: "10-K · us-gaap:Revenues family",
      },
      {
        label: "Net income",
        def: "Earnings attributable to the company after taxes and interest. Bottom line.",
        example: "OKTA FY2024: −$355M (a net loss).",
        source: "10-K · us-gaap:NetIncomeLoss",
      },
      {
        label: "Operating cash flow (OCF)",
        def: "Net cash from operating activities — the cash-flow statement's first subtotal.",
        example:
          "OKTA FY2024: $625M positive OCF despite a $355M GAAP loss (gap is SBC + working-capital changes).",
        source: "10-K · us-gaap:NetCashProvidedByUsedInOperatingActivities",
      },
      {
        label: "Capex",
        def: "Capital expenditures — cash spent on property, plant, equipment, and capitalized software.",
        example: "OKTA FY2024 capex: $14M — software companies tend to be capex-light.",
        source: "10-K · us-gaap:PaymentsToAcquirePropertyPlantAndEquipment",
      },
      {
        label: "Stock-based compensation (SBC)",
        def: "Non-cash compensation expense for equity grants. The income-statement charge, not the dilution count.",
        example: "OKTA FY2024 SBC: $828M — 32% of revenue.",
        source: "10-K · us-gaap:ShareBasedCompensation",
      },
      {
        label: "Buybacks",
        def: "Cash paid to repurchase the company's own stock during the year.",
        example: "OKTA FY2024 buybacks: $0 (no announced repurchase program).",
        source: "10-K · us-gaap:PaymentsForRepurchaseOfCommonStock",
      },
      {
        label: "Dividends paid",
        def: "Cash paid out as dividends during the fiscal year (excludes stock dividends).",
        example: "OKTA FY2024: $0 — no dividend program.",
        source: "10-K · us-gaap:PaymentsOfDividends",
      },
    ],
  },
  {
    title: "Balance sheet",
    note: "Latest 10-Q (or 10-K if no quarterly is available).",
    terms: [
      {
        label: "Cash & equivalents",
        def: "Cash plus short-duration, highly-liquid securities readily convertible to cash.",
        example: "OKTA Q4 FY2024: $2.51B.",
        source: "10-K/10-Q · us-gaap:CashAndCashEquivalentsAtCarryingValue",
      },
      {
        label: "Long-term debt",
        def: "Debt obligations not due within one year. Excludes the current portion.",
        example: "OKTA Q4 FY2024: $1.08B — mostly convertible notes.",
        source: "10-K/10-Q · us-gaap:LongTermDebtNoncurrent",
      },
      {
        label: "Goodwill",
        def: "Excess paid over fair value of net assets in an acquisition — sits on the balance sheet until impaired.",
        example: "OKTA: $5.41B — largely from the 2021 Auth0 acquisition.",
        source: "10-K/10-Q · us-gaap:Goodwill",
      },
      {
        label: "Total assets",
        def: "Everything the company owns at carrying value.",
        example: "OKTA Q4 FY2024: $11.58B.",
        source: "10-K/10-Q · us-gaap:Assets",
      },
      {
        label: "Equity",
        def: "Total assets minus total liabilities — what's left for shareholders.",
        example: "OKTA Q4 FY2024: $6.94B stockholders' equity.",
        source: "10-K/10-Q · us-gaap:StockholdersEquity",
      },
    ],
  },
  {
    title: "Board section",
    terms: [
      {
        label: "Independent director",
        def: "A director the board has determined meets the independence standards of the relevant exchange (NYSE/Nasdaq). No material relationship with the company.",
        example:
          "OKTA's Patrick Grady — board has determined he is independent under Nasdaq Rule 5605(a)(2); sits on Comp committee.",
        source: "DEF 14A · director-independence disclosure",
      },
      {
        label: "Lead independent director",
        def: "Designated independent voice on the board, typically when the CEO is also Chair. Sets agendas for executive sessions.",
        example:
          "OKTA's lead independent director is Michelle Wilson; McKinnon serves as both CEO and Chair, which is why a lead is named.",
        source: "DEF 14A",
      },
      {
        label: "Audit / Compensation / Nominating committees",
        def: "Standing committees with independence requirements. Audit oversees the auditor; Comp sets executive pay; Nom-Gov controls director slate.",
        example: "OKTA Audit committee: 3 directors, all independent, chaired by Robert Henske.",
        source: "DEF 14A · committee charters",
      },
      {
        label: "Attendance flag",
        def: "Director attended fewer than 75% of board and committee meetings during the prior year — proxies must disclose this by name.",
        example: "A director attending 14 of 20 combined meetings (70%) gets called out in the proxy by name.",
        source: "DEF 14A",
      },
      {
        label: "Related-party transaction",
        def: "Transaction between the company and an officer, director, or 5% holder (or their family/affiliated entities). Disclosed individually.",
        example:
          "Company licenses software to a venture firm in which a director is a partner for $1.2M/yr → disclosed under Item 404.",
        source: "DEF 14A · Item 404",
      },
    ],
  },
  {
    title: "Beneficial ownership",
    terms: [
      {
        label: "≥5% holder",
        def: "Any party owning 5% or more of any class of voting stock. Identified individually in the proxy ownership table.",
        example: "OKTA Class A: Vanguard 10.3%, BlackRock 8.4%, T. Rowe Price 5.1%.",
        source: "DEF 14A · ownership table",
      },
      {
        label: "Beneficial ownership",
        def: "Shares the holder controls economically — direct holdings plus shares the holder has voting/dispositive power over (e.g. via funds they manage).",
        example:
          "BlackRock's 8.4% includes shares held in iShares and BlackRock-managed mutual funds where BlackRock votes the proxy.",
        source: "13D/13G · Item 5",
      },
    ],
  },
  {
    title: "Editorial promise",
    note: "What this site does and does not do.",
    terms: [
      {
        label: "Deterministic",
        def: "Every number on the site is computed by rule from a filing. No LLM-generated tags, no opinion text, no judgement calls embedded in scores.",
        example:
          "The 'Pay' flag is exactly: median(PEO total comp) ≥ $15M AND TSR flag fires. Pure SQL. Open the screen view to confirm any row.",
        source: "—",
      },
      {
        label: "Auditable",
        def: "Every flag has a single rule expressed in SQL or code that you can read. If you disagree with the threshold, the flag is wrong for your purposes — not the data.",
        example:
          "Goodwill flag fires at >40%. If you think 30% is the real line, look at the underlying number on the company page — it's still there.",
        source: "—",
      },
      {
        label: "Reader's job",
        def: "Characterization. We don't claim a company is well- or badly-run. We surface the same primary-source numbers an activist investor would build their thesis on.",
        example:
          "We say '32% SBC of revenue'. You decide whether that's reasonable for an enterprise-software company at OKTA's growth stage.",
        source: "—",
      },
    ],
  },
];

export function GlossaryPage() {
  return (
    <div className="glossary">
      <header className="glossary-head">
        <p className="hero-eyebrow">GLOSSARY</p>
        <h1 className="glossary-title">Every term, defined.</h1>
        <p className="glossary-dek">
          Walk-through of what each label means on a company page, in the order
          the reader meets them. Each definition cites the filing or table the
          number is computed from, and shows a concrete example.
        </p>
      </header>

      {GROUPS.map((g) => (
        <section key={g.title} className="glossary-group">
          <header className="glossary-group-head">
            <h2 className="glossary-group-title">{g.title}</h2>
            {g.note ? <p className="glossary-group-note">{g.note}</p> : null}
          </header>
          <dl className="glossary-list">
            {g.terms.map((t) => (
              <div key={t.label} className="glossary-row">
                <dt className="glossary-term">
                  <span className="glossary-label">{t.label}</span>
                  {t.aka ? <span className="glossary-aka"> — {t.aka}</span> : null}
                </dt>
                <dd className="glossary-def">
                  {t.def}
                  <span className="glossary-example">{t.example}</span>
                  <span className="glossary-source">{t.source}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
