# Takeover

Takeover attractiveness for every Russell 3000 company, computed from SEC filings.

**[takeover.droov.info](https://takeover.droov.info)**

Takeover scores each company on thirteen yes/no checks that an activist or a buyer would look at before making an approach: shareholder returns that trail peers, CEO pay that climbs anyway, a lean balance sheet, a size a buyer can afford, an activist already on the register. Every check is a threshold on numbers the company itself reported to the SEC. The takeover score is the count of checks that fire. The site shows the number behind each check next to the rule it was tested against, and leaves the judgment to the reader.

It also tracks a newer kind of buyer. AI holding companies (Long Lake, Thrive Holdings, General Catalyst's roll-ups) have started taking public, labor-heavy services companies private. Deal filings, headcount, revenue per employee and how often a 10-K mentions AI are pulled alongside the checks.

## The thirteen signals

They fall into three groups.

**Fixable underperformance**: problems a new owner could fix.

| Signal | Fires when | Source |
|---|---|---|
| TSR below peers | Total shareholder return trails the company's own peer group in 3+ of the last 5 years | Pay-versus-performance table (XBRL) |
| High CEO pay despite TSR | Median CEO pay ≥ $15M while the TSR signal fires | Pay-versus-performance table (XBRL) |
| Earnings not backed by cash | Operating cash flow under 80% of positive net income | 10-K (XBRL) |
| Dilutive SBC | Stock-based compensation over 10% of revenue | 10-K (XBRL) |
| Payouts exceed cash flow | Buybacks plus dividends exceed operating cash flow | 10-K (XBRL) |
| Goodwill-heavy | Goodwill over 40% of total assets | 10-K (XBRL) |
| Shareholder dissent | Say-on-pay or any director under 80% support at the last annual meeting | 8-K Item 5.07 |

**Deal economics**: what makes the company cheap or easy to buy.

| Signal | Fires when | Source |
|---|---|---|
| Low revenue per employee | Bottom quartile of its 2-digit SIC industry (industries with 8+ scored companies) | Revenue (XBRL) ÷ headcount from the 10-K |
| Quiet on AI | AI mentions per 10K words of the latest 10-K are in the bottom quartile of the universe | 10-K full text |
| Net cash | EBITDA is positive and the company holds more cash than debt | XBRL income statement and balance sheet |
| Buyout-sized | Market cap between $500M and $5B | Shares outstanding × price |

**Catalysts**: someone is already moving.

| Signal | Fires when | Source |
|---|---|---|
| Active 13D | An active-intent Schedule 13D in the last 18 months, excluding filings by the company itself | Schedule 13D |
| Net insider selling | Open-market insider sales exceed purchases by more than $10M over 12 months | Form 4 |

Missing inputs never fire a signal. The two percentile signals recalibrate on every refresh; the rest are fixed thresholds set where a signal is hard to explain away in a single year. They live in [`refresh-scores.ts`](packages/ingest/src/refresh-scores.ts).

## How it works

```
SEC EDGAR ─┐                                         ┌─ apps/site (Next.js)
Yahoo      ├─> packages/ingest ─> Postgres (Neon) ─> ├─ apps/api  (Hono)
Finance   ─┘   pull-*.ts             │               │
                                     └─ refresh-scores.ts
                                        (materializes the scores)
```

- **`packages/ingest`**: idempotent scripts that pull SEC submissions, XBRL company facts, inline-XBRL pay-versus-performance data, Form 4s, 13D/13Gs, 8-K vote results and merger filings into Postgres. Everything is parsed deterministically except two filing types with no fixed layout, 13D/13G cover pages and 8-K vote tallies, which go through a small LLM ([Mistral Nemo](https://mistral.ai) via [Vercel AI Gateway](https://vercel.com/ai-gateway)) with schema validation.
- **`apps/api`**: a [Hono](https://hono.dev) read API over the database.
- **`apps/site`**: the [Next.js](https://nextjs.org) site. Pages are rendered on the server, cached for six hours, and call the API in-process rather than over HTTP.

The tables and the concept behind each column are documented in [`docs/data-model.md`](docs/data-model.md).

## Running it locally

Requires Node 20+ and [pnpm](https://pnpm.io).

```sh
pnpm install
cp .env.example .env          # set DATABASE_URL; AI_GATEWAY_API_KEY is only needed for pull-13d / pull-votes
pnpm migrate
```

Fill the database. Each step is safe to re-run.

```sh
pnpm pull-universe            # Russell 3000 constituents + every SEC-registered ticker
pnpm pull-edgar               # filings index + XBRL financials
pnpm pull-prices              # two years of adjusted daily closes
pnpm pull-ecd                 # pay-versus-performance (XBRL)
pnpm pull-ixbrl               # inline-XBRL facts from proxies
pnpm pull-form4               # insider transactions
pnpm pull-13d                 # 13D/13G cover-page facts (LLM)
pnpm pull-votes               # annual-meeting vote results (LLM)
pnpm pull-deals               # merger proxies, headcount, 10-K text signals
pnpm pull-deals --buyers      # full-text search for AI-rollup buyers
pnpm fill-market-cap
pnpm refresh                  # recompute takeover_scores
```

Any pull takes tickers to limit its run (`pnpm pull-edgar ADT CBZ`). Then start the site:

```sh
cp .env apps/site/.env.local
pnpm dev                      # http://localhost:3000
```

A full first pull of the Russell 3000 takes a few hours, mostly to stay within EDGAR's ten-requests-per-second limit. The database stays around 300 MB because ingest keeps only the window each screen reads (see [storage windows](docs/data-model.md#storage-windows)).

## Caveats

- Filings report what happened, not why. A fired signal is a question to ask, not a conclusion.
- XBRL tagging varies between filers. A company that tags a concept unusually may show a gap rather than a value.
- Headcount, deal terms and acquirers are parsed from filing text and can miss unusual phrasing. Each value links back to its source filing.
- Nothing here is investment advice.

## License

[MIT](LICENSE)
