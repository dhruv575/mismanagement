# Data model

How each concept on the site maps to the Postgres tables and columns that hold it. Every table is filled by a deterministic pull from SEC EDGAR or Yahoo Finance; the two exceptions (13D/13G facts and 8-K vote tallies) are extracted from filing text by a small LLM and say so below.

- Schema: [`packages/ingest/src/migrate.ts`](../packages/ingest/src/migrate.ts)
- Ingest scripts: [`packages/ingest/src/`](../packages/ingest/src/) (`pull-*.ts`)
- Scoring: [`packages/ingest/src/refresh-mismanagement.ts`](../packages/ingest/src/refresh-mismanagement.ts)

Two recurring gotchas to internalize before reading the rest:

1. **`financial_metrics.concept` stores LOGICAL names** like `"revenue"`, `"net_income"`, `"cash_latest"` — not raw XBRL concepts like `us-gaap:Revenues`. The pull script tries a list of GAAP concepts per logical name and stores the first that resolves.
2. **`ixbrl_facts.concept` stores RAW XBRL names** with namespace prefix, e.g. `ecd:PeoTotalCompAmt`, `us-gaap:NetIncomeLoss`. Different table, different convention.

Companies are keyed by `cik` (text, zero-padded). Ticker is on `companies.ticker` for joins to `price_history`.

---

## Company market cap (derived)

Not stored as a column — compute from latest price × latest shares.

- **Sources:** `price_history.adj_close` (most recent row per ticker) × `financial_metrics.value where concept = 'shares_outstanding_latest' and fiscal_year = -1`
- **Concept-string filter:** `'shares_outstanding_latest'`

```sql
with latest_price as (
  select distinct on (ticker) ticker, adj_close
  from price_history
  where ticker = any($1::text[])
  order by ticker, trading_date desc
),
latest_shares as (
  select cik, value as shares
  from financial_metrics
  where concept = 'shares_outstanding_latest' and fiscal_year = -1
)
select c.cik, c.ticker, ls.shares * lp.adj_close as market_cap
from companies c
join latest_price lp on lp.ticker = c.ticker
join latest_shares ls on ls.cik = c.cik;
```

- **Notes:** `adj_close` is total-return adjusted (dividends + splits), which is fine for market cap because shares_outstanding is also a point-in-time figure. Coverage on shares is ~99.3% of R3K (incl. multi-class filers like META via `dei:EntityCommonStockSharesOutstanding` and a weighted-avg diluted fallback for stubborn filers).

---

## Latest revenue

- **Source table:** `financial_metrics`
- **Concept-string filter:** `concept = 'revenue'`
- **Key columns:** `cik`, `fiscal_year`, `value`, `unit` (always `'USD'` for revenue)

```sql
select fiscal_year, value as revenue
from financial_metrics
where cik = $1 and concept = 'revenue'
order by fiscal_year desc
limit 1;
```

- **Notes:** Logical concept `'revenue'` merges (in order) `RevenueFromContractWithCustomerExcludingAssessedTax`, `RevenueFromContractWithCustomerIncludingAssessedTax`, `Revenues`, `SalesRevenueNet`. The pull preferentially picks the frame-tagged consolidated value to avoid the eBay continuing-ops-subsegment bug. `fiscal_year` is the period-end year, not EDGAR's `fy` field.

---

## Revenue 5y CAGR (derived)

```sql
with rmy as (
  select cik, max(fiscal_year) as max_year
  from financial_metrics
  where concept = 'revenue' and fiscal_year > 0 and cik = $1
  group by cik
)
select case
         when min(case when fm.fiscal_year = rmy.max_year - 5 then fm.value end) > 0
         then power(
                max(case when fm.fiscal_year = rmy.max_year then fm.value end)
                / nullif(min(case when fm.fiscal_year = rmy.max_year - 5 then fm.value end), 0),
                1.0/5
              ) - 1
       end as cagr
from rmy
join financial_metrics fm on fm.cik = rmy.cik and fm.concept = 'revenue'
 and fm.fiscal_year in (rmy.max_year, rmy.max_year - 5)
group by rmy.cik;
```

- **Notes:** Filter on `fiscal_year > 0` excludes the point-in-time sentinel `-1`. If max_year - 5 has no row the CAGR is null; choose a shorter window (3y) at the caller if needed.

---

## Annual income-statement / cash-flow concepts

All rows live in `financial_metrics`, one row per `(cik, fiscal_year, concept)`. Filter on `fiscal_year > 0` to exclude point-in-time sentinel rows.

| Concept                 | `concept` filter string       |
|-------------------------|-------------------------------|
| Net income              | `'net_income'`                |
| Operating income        | `'operating_income'`          |
| Gross profit            | `'gross_profit'`              |
| Cost of revenue         | `'cost_of_revenue'`           |
| Operating expenses total| `'operating_expenses_total'`  |
| R&D                     | `'research_development'`      |
| S&M                     | `'selling_marketing'`         |
| G&A                     | `'general_administrative'`    |
| Stock-based comp        | `'sbc'`                       |
| Operating cash flow     | `'operating_cash_flow'`       |
| Capex                   | `'capex'`                     |
| Depreciation & amort.   | `'depreciation_amortization'` |
| Dividends paid          | `'dividends_paid'`            |
| Share buybacks          | `'buybacks'`                  |
| Interest expense        | `'interest_expense'`          |
| Income tax expense      | `'income_tax_expense'`        |

Free cash flow is **not stored** — compute as `operating_cash_flow - capex`:

```sql
select ocf.fiscal_year,
       ocf.value as ocf,
       cx.value  as capex,
       ocf.value - coalesce(cx.value, 0) as fcf
from financial_metrics ocf
left join financial_metrics cx
  on cx.cik = ocf.cik and cx.fiscal_year = ocf.fiscal_year and cx.concept = 'capex'
where ocf.cik = $1 and ocf.concept = 'operating_cash_flow' and ocf.fiscal_year > 0
order by ocf.fiscal_year desc;
```

- **Notes:** `capex` is reported as a positive cash outflow in companyfacts (`PaymentsToAcquirePropertyPlantAndEquipment`). `dividends_paid` and `buybacks` are likewise positive outflows. `interest_expense` is positive. Annual rows require ~340–380 days of period length, so partial-year stubs are excluded.

---

## Balance-sheet point-in-time

Stored in `financial_metrics` with the **sentinel `fiscal_year = -1`**. These are the latest reported instant values; they are not time-series in this table.

| Concept                 | `concept` filter string         |
|-------------------------|---------------------------------|
| Total assets            | `'total_assets_latest'`         |
| Total stockholders eq.  | `'total_equity_latest'`         |
| Total debt              | `'total_debt_latest'`           |
| Long-term debt          | `'long_term_debt_latest'`       |
| Short-term debt         | `'short_term_debt_latest'`      |
| Cash & equivalents      | `'cash_latest'`                 |
| Goodwill                | `'goodwill_latest'`             |
| Accounts receivable     | `'accounts_receivable_latest'`  |
| Inventory               | `'inventory_latest'`            |
| Shares outstanding      | `'shares_outstanding_latest'`   |

```sql
select concept, value, unit
from financial_metrics
where cik = $1
  and fiscal_year = -1
  and concept in (
    'total_assets_latest','total_equity_latest','total_debt_latest',
    'cash_latest','goodwill_latest','accounts_receivable_latest','inventory_latest'
  );
```

- **Notes:** `total_debt_latest` falls back through `DebtLongtermAndShorttermCombinedAmount` then `LongTermDebtAndCapitalLeaseObligations`; for a true combined debt figure you may need to sum `long_term_debt_latest + short_term_debt_latest`. Unit is `'USD'` for all except `shares_outstanding_latest` which is `'shares'`.

---

## Shares outstanding

- **Source:** `financial_metrics where concept = 'shares_outstanding_latest' and fiscal_year = -1`
- **Unit:** `'shares'`
- **Notes:** Coverage 99.3% across R3K. Resolution order: `us-gaap:CommonStockSharesOutstanding`, then `dei:EntityCommonStockSharesOutstanding` (the cover-page tag — captures multi-class filers like META, OKTA), then `us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding`, then basic weighted-avg. The diluted/basic weighted-avg fallbacks are within ~5% of period-end for most issuers.

---

## Pay-vs-Performance 5-year table

- **Source table:** `xbrl_pay_vs_performance`
- **Key:** `(cik, fiscal_year)`
- **Columns:** `peo_total_comp`, `peo_compensation_actually_paid`, `non_peo_neo_avg_total_comp`, `non_peo_neo_avg_compensation_actually_paid`, `company_tsr_indexed`, `peer_group_tsr_indexed`, `company_selected_measure_name`, `company_selected_measure_value`, `gaap_net_income`, `accession_number`, `pulled_at`

```sql
select fiscal_year,
       peo_total_comp,
       peo_compensation_actually_paid as peo_cap,
       non_peo_neo_avg_total_comp,
       non_peo_neo_avg_compensation_actually_paid as non_peo_neo_avg_cap,
       company_tsr_indexed,
       peer_group_tsr_indexed,
       gaap_net_income,
       company_selected_measure_name,
       company_selected_measure_value
from xbrl_pay_vs_performance
where cik = $1
order by fiscal_year desc;
```

- **Notes:** Authoritative source for PvP — pulled from EDGAR companyfacts via the `ecd:` taxonomy plus `us-gaap:NetIncomeLoss`. Both TSR fields are indexed to a $100 initial investment per Dodd-Frank disclosure rules. Most filers have 3–5 years of data; PvP rule applies to FY2023+. Coverage is wide (most large R3K issuers) but not universal — small filers may have 0 rows.

---

## CEO pay ratio

- **Source table:** `ixbrl_facts`
- **Concept-string filter:** `concept = 'ecd:PeoPayRatio'`
- **Key columns:** `cik`, `accession_number`, `numeric_value`, `period_end`, `text_value`

```sql
select x.cik, x.accession_number, x.period_end,
       x.numeric_value as pay_ratio
from ixbrl_facts x
where x.cik = $1 and x.concept = 'ecd:PeoPayRatio'
order by x.period_end desc
limit 1;
```

- **Notes:** Only available when the filer's DEF 14A has the pay ratio tagged in inline XBRL (most large accelerated filers do; smaller filers may not). Generic per-fact storage; `text_value` is populated for narrative tags. Use `period_end` for sort because `fiscal_year` is not a column on this table. Join to `filings.filing_date` via `accession_number` if you need the filing date.

---

## Insider transactions (Form 4)

- **Source table:** `insider_transactions`
- **Key columns:** `cik`, `insider_name`, `transaction_date`, `transaction_code`, `shares`, `price_per_share`, `transaction_value`, `is_director`, `is_officer`, `is_ten_percent_owner`, `officer_title`, `acquired_or_disposed`, `shares_owned_after`, `direct_or_indirect`, `ten_b_5_one_plan`, `derivative`

Useful filters:

| Intent                | Filter                                                          |
|-----------------------|-----------------------------------------------------------------|
| Open-market purchases | `transaction_code = 'P'`                                        |
| Open-market sales     | `transaction_code = 'S'`                                        |
| Material only         | `transaction_value >= 100000`                                   |
| Outside Rule 10b5-1   | `ten_b_5_one_plan is not true`                                  |
| Non-derivative only   | `derivative = false`                                            |

```sql
-- Net insider flow over the last 12 months (P minus S, dollar-weighted).
select cik,
       sum(case when transaction_code = 'P' then transaction_value
                when transaction_code = 'S' then -transaction_value
                else 0 end) as net_buy_dollars
from insider_transactions
where cik = $1
  and transaction_date > current_date - interval '12 months'
group by cik;
```

- **Notes:** Other SEC transaction codes are present (`A` grant, `M` exercise, `F` tax-withholding, `D` sale to issuer, `G` gift, `X` derivative exercise, `J` other). Most signals look only at `P`/`S`. Both non-derivative and derivative legs are in this one table; flag with `derivative`.

---

## 13D / 13G filings

- **Source table:** `thirteen_d_filings`
- **Key columns:** `cik` (issuer), `filer_name`, `filer_cik`, `form`, `filing_date`, `event_date`, `is_active_intent`, `purpose_summary`, `cooperation_agreement_present`, `standstill_present`, `aggregate_shares`, `aggregate_percent`, `sole_voting_power`, `shared_voting_power`, `sole_dispositive_power`, `shared_dispositive_power`, `group_members`

```sql
-- Active-intent 13Ds on a company within the last 18 months.
select filing_date, filer_name, aggregate_percent,
       purpose_summary, cooperation_agreement_present
from thirteen_d_filings
where cik = $1
  and is_active_intent = true
  and filing_date > current_date - interval '18 months'
order by filing_date desc;
```

For a raw filing count (without extracted facts) you can also query `filings` directly:

```sql
select count(*)
from filings
where cik = $1
  and form in ('SC 13D', 'SC 13D/A', 'SCHEDULE 13D', 'SCHEDULE 13D/A')
  and filing_date > current_date - interval '18 months';
```

- **Notes:** `is_active_intent = true` is the canonical filter for activist 13Ds (vs. passive 13Gs). `aggregate_percent` is the percent of class beneficially owned (Item 5). `group_members` is a text array (Item 2). The `filings` table has the universe; `thirteen_d_filings` has the extracted fields.

---

## Daily prices

- **Source table:** `price_history`
- **Key:** `(ticker, trading_date)`
- **Columns:** `adj_close` (double precision)

```sql
select trading_date, adj_close
from price_history
where ticker = $1
  and trading_date > current_date - interval '1 year'
order by trading_date;
```

- **Notes:** `adj_close` is the **total-return adjusted** close (dividends + splits folded in) from Yahoo Finance. Use this directly for TSR calcs — do not adjust again. Keyed on `ticker`, not `cik`; join via `companies.ticker`.

---

## Deal filings

- **Source table:** `deal_filings` (filled by `pull-deals.ts`)
- **Key columns:** `cik` (target), `form`, `filing_date`, `acquirer`, `matched_buyer`, `price_per_share`, `premium_pct`, `document_url`

Merger proxies (`DEFM14A`/`PREM14A`), going-private schedules (`SC 13E3`) and tender offers (`SC TO-T`) on each issuer, plus Item 1.01 8-Ks found by EDGAR full-text search for known AI-rollup buyers.

- **Notes:** `acquirer` is parsed from the proxy's "Parent is an affiliate of …" sentence. `matched_buyer` is the search term that found the filing — a **mention, not attribution** (bankers' comparable-deal tables cite other buyers' deals). Price and premium are parsed from merger proxies only and may be null.

---

## Headcount and filing-text signals

- **`headcount`:** `(cik, fiscal_year) → employees`, regex-parsed from the 10-K human-capital section (filers rarely XBRL-tag it). `matched_text` keeps the source sentence.
- **`filing_text_signals`:** per 10-K, `word_count` and `ai_term_count` (artificial intelligence / generative AI / AI / machine learning / LLM / automation). Use the rate, not the count: `ai_term_count / word_count * 1e4` mentions per 10K words.

---

## Storage windows

Neon's free tier caps a project at 1 GB, so ingest keeps only what a screen reads:

| Data | Kept |
|---|---|
| Form 4 filings | last 2 years (rolling) |
| 8-K filings | 2020+, Items 5.07 and 1.01 only |
| 10-K, DEF 14A, 13D/13G | 2019+ |
| `price_history` | last 2 years (rolling) |
