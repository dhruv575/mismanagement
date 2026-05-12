// API response shapes that aren't proxy extractions -- screen results,
// company summaries, financial-metric series. These are computed by the API
// from persisted data and live here so apps/web and apps/api agree on types.

export interface CompanySummary {
  cik: string;
  ticker: string;
  name: string;
  sicDescription: string | null;
  marketCap: number | null;
  priceLast: number | null;
  priceLastDate: string | null;
  fy25Revenue: number | null;
  rev3yCagr: number | null;
  rev5yCagr: number | null;
  tsr1y: number | null;
  tsr3y: number | null;
  tsr5y: number | null;
  ceoPayLatest: number | null;
  ceoPayRatioLatest: number | null;
  classifiedBoard: boolean | null;
  proxyFilingDate: string | null;
}

export interface FinancialMetric {
  cik: string;
  fiscalYear: number;
  concept: string;
  value: number;
  unit: string;
}

export interface PriceSnapshot {
  ticker: string;
  date: string;
  adjClose: number;
}
