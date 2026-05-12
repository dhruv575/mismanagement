# activist-investing

Editorial screening tool over public-company financial filings. Pulls SEC
EDGAR XBRL + Yahoo Finance + DEF 14A proxy extractions into a single Postgres
database, surfaces them as a quantitative reader-facing site.

The premise: an activist-style screen ("which boards look ripe for an Elliott
or Cohen letter") can be built almost entirely from filings every public
company is already required to publish. This repo builds that screen and
shows the underlying numbers; readers draw their own conclusions.

## Layout

```
activist-investing/
├── api/[[...path]].ts            # Vercel Edge entry -- re-exports the Hono app
├── apps/
│   ├── api/                       # Hono API (src/index.ts exports `app`)
│   └── web/                       # (deferred) Vite + React reader UI
├── packages/
│   ├── shared/                    # Zod schemas + TS types
│   └── ingest/
│       ├── src/migrate.ts         # Postgres schema, idempotent
│       ├── src/pull-edgar.ts      # SEC submissions + companyfacts JSON
│       ├── src/pull-prices.ts     # Yahoo Finance daily adjusted close
│       ├── src/extract-proxy.ts   # DEF 14A -> structured JSON via Gemini 3 Flash
│       └── src/screen.ts          # Stage-1 quant report
├── scripts/                       # Python prototypes used to design the pipeline
│   ├── stage1_etsy.py
│   └── stage2_etsy.py
└── data/                          # cached EDGAR HTML + extraction JSON (gitignored)
```

## Local setup

1. Create a Neon project at <https://console.neon.tech>, copy the connection string into `.env`:

   ```
   cp .env.example .env
   # edit DATABASE_URL and OPENROUTER_API_KEY
   ```

2. Install deps and migrate:

   ```
   pnpm install
   pnpm migrate
   ```

3. Pull data:

   ```
   pnpm pull-edgar           # all issuers in packages/ingest/src/issuers.ts
   pnpm pull-prices
   pnpm extract-proxy        # cost ~$0.03 per issuer via OpenRouter
   ```

   Each script is idempotent and safe to re-run. To target a single ticker:

   ```
   pnpm pull-edgar ETSY
   pnpm extract-proxy --force ETSY
   ```

4. Run the API:

   ```
   pnpm dev
   ```

   The Hono app listens on `http://localhost:5051/api`.

## Data flow

```
SEC EDGAR submissions JSON   ┐
SEC EDGAR companyfacts JSON  ├──> pull-edgar.ts ──> companies, filings, financial_metrics
                             │
Yahoo Finance chart API ─────┴──> pull-prices.ts ──> price_history

DEF 14A HTML ──> extract-proxy.ts ──> proxy_extractions (raw JSON)
                                      └─> summary_compensation,
                                          all_other_compensation,
                                          pay_vs_performance,
                                          directors,
                                          director_compensation,
                                          equity_ownership,
                                          related_party_transactions,
                                          compensation_consultants
```

The proxy extraction uses **Gemini 3 Flash via OpenRouter** with the
JSON schema embedded in the prompt and a tolerant parser (same pattern as the
UFO project's `openrouter.ts`). One DEF 14A averages ~150K input tokens / 5–7K
output tokens, ~$0.025–0.030 per extraction.

## What this does *not* do

The schema captures *facts*, not interpretation. There is no `red_flags`
column, no `governance_score`, no activist-thesis text. Comparisons (company
TSR vs peer TSR, opex/revenue, comp ratio percentile within peer group) are
computed at query time and surfaced as numbers; characterization is the
reader's job.

## Python prototypes

`scripts/stage1_etsy.py` and `scripts/stage2_etsy.py` are the design-time
spike that became this pipeline. They run standalone (no Postgres, just stdout
+ a `data/` folder of cached JSON) and stay around as a reference -- handy
when iterating on prompt or schema changes without paying the full pnpm/Turbo
cycle.
