// Zod schemas for the Stage 2 DEF 14A extraction. The VLM call returns JSON
// shaped like ProxyExtraction; ingest scripts validate before persisting so a
// drifted prompt or model regression doesn't silently land bad rows.
//
// All dollar amounts are in dollars (not thousands). Indexed TSR values are
// "value of $100 invested at start of period" per Dodd-Frank PvP convention.
//
// Editorial note: this schema captures *facts*, not interpretation. There is
// no `red_flags` / `governance_concerns` / `activist_observations` field --
// downstream consumers compute comparisons (TSR vs peer TSR, opex/revenue
// trend) and present them; no characterization happens at extraction time.

import { z } from "zod";

const NullableNumber = z.number().nullable();
const NullableInt = z.number().int().nullable();
const NullableString = z.string().nullable();
const NullableBool = z.boolean().nullable();

// DeepSeek (and most LLMs) emit `null` for "no value" rather than omitting the
// field or returning [] / {}. The original schema required objects/arrays
// strictly, which dropped ~12% of R3K extractions to Zod validation errors
// when sections were genuinely empty. Helpers below treat null/undefined as
// "field absent" and substitute the right default.
const arrayOr = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v == null ? [] : v), z.array(inner));
const nullableObj = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v == null ? undefined : v), inner.optional());
// Strings that show up as null in a required position -- coerce to "".
const coerceEmptyString = z.preprocess(
  (v) => (v == null ? "" : v),
  z.string(),
);

export const SummaryCompensationRow = z.object({
  name: z.string(),
  title: z.string(),
  fiscal_year: z.number().int(),
  salary: NullableNumber,
  bonus: NullableNumber,
  stock_awards: NullableNumber,
  option_awards: NullableNumber,
  non_equity_incentive_plan: NullableNumber,
  change_in_pension_value: NullableNumber,
  all_other_compensation: NullableNumber,
  total: NullableNumber,
});

export const AllOtherCompensationItem = z.object({
  category: z.string(),
  amount: NullableNumber,
  description: coerceEmptyString.optional().default(""),
});

export const AllOtherCompensationRow = z.object({
  name: z.string(),
  fiscal_year: z.number().int(),
  items: arrayOr(AllOtherCompensationItem),
});

export const CeoPayRatio = z.object({
  ceo_total_compensation: NullableNumber,
  median_employee_compensation: NullableNumber,
  ratio_x_to_1: NullableNumber,
  fiscal_year: NullableInt,
});

export const PayVsPerformanceRow = z.object({
  year: z.number().int(),
  ceo_compensation_actually_paid: NullableNumber,
  average_neo_compensation_actually_paid: NullableNumber,
  company_tsr_indexed: NullableNumber,
  peer_group_tsr_indexed: NullableNumber,
  gaap_net_income: NullableNumber,
  company_selected_measure_name: NullableString,
  company_selected_measure_value: NullableNumber,
});

export const DirectorCompensationRow = z.object({
  name: z.string(),
  fees_earned_or_paid_in_cash: NullableNumber,
  stock_awards: NullableNumber,
  option_awards: NullableNumber,
  non_equity_incentive: NullableNumber,
  all_other_compensation: NullableNumber,
  total: NullableNumber,
});

export const Director = z.object({
  name: z.string(),
  age: NullableInt,
  director_since_year: NullableInt,
  independent: NullableBool,
  is_chair: NullableBool,
  is_lead_independent_director: NullableBool,
  committees: arrayOr(z.string()),
  other_public_boards: arrayOr(z.string()),
  attendance_below_75pct: NullableBool,
});

export const BoardStructure = z.object({
  classified_board: NullableBool,
  dual_class_voting: NullableBool,
  chair_ceo_combined: NullableBool,
  lead_independent_director_name: NullableString,
  shareholder_proposal_threshold: NullableString,
  majority_voting_for_directors: NullableBool,
});

export const RelatedPartyTransaction = z.object({
  description: coerceEmptyString,
  parties: arrayOr(z.string()),
  amount_or_terms: coerceEmptyString.optional().default(""),
});

// `type` arrives as model-chosen text -- "5% Holder", "Officer", "Director",
// "5pct_holder", etc. We normalize at the boundary so downstream queries can
// filter on a stable set of values without caring about model whim. Unknown
// labels pass through verbatim so we don't lose information.
const HOLDER_TYPE_ALIASES: Record<string, string> = {
  "5% holder": "5pct_holder",
  "5pct holder": "5pct_holder",
  "5pct_holder": "5pct_holder",
  "five percent holder": "5pct_holder",
  "officer": "officer",
  "executive officer": "officer",
  "named executive officer": "officer",
  "neo": "officer",
  "director": "director",
  "non-employee director": "director",
  "all directors and officers": "all_directors_and_officers",
  "all directors and officers as a group": "all_directors_and_officers",
  "all_directors_and_officers": "all_directors_and_officers",
};

export const EquityOwnershipRow = z.object({
  name: z.string(),
  type: z
    .string()
    .transform((s) => HOLDER_TYPE_ALIASES[s.trim().toLowerCase()] ?? s.trim().toLowerCase().replace(/\s+/g, "_")),
  shares: NullableNumber,
  percent_class: NullableNumber,
});

export const CompensationConsultant = z.object({
  name: z.string(),
  scope: coerceEmptyString.optional().default(""),
  fees_paid: NullableNumber,
});

export const SayOnPay = z.object({
  last_vote_year: NullableInt,
  last_vote_approval_pct: NullableNumber,
});

export const ProxyExtractionMeta = z.object({
  issuer: z.string(),
  cik: z.string(),
  filing_date: z.string(),
  accession_number: z.string(),
  fiscal_year_covered: z.number().int(),
  slug: z.string(),
});

export const ProxyExtraction = z.object({
  summary_compensation: arrayOr(SummaryCompensationRow),
  all_other_compensation_detail: arrayOr(AllOtherCompensationRow),
  ceo_pay_ratio: nullableObj(CeoPayRatio),
  pay_versus_performance: arrayOr(PayVsPerformanceRow),
  director_compensation: arrayOr(DirectorCompensationRow),
  board: arrayOr(Director),
  board_structure: nullableObj(BoardStructure),
  related_party_transactions: arrayOr(RelatedPartyTransaction),
  equity_ownership: arrayOr(EquityOwnershipRow),
  compensation_consultants: arrayOr(CompensationConsultant),
  // Models sometimes return peer-group entries as objects ({name, ticker})
  // instead of strings. Normalize to a string per entry so downstream code
  // doesn't have to care.
  peer_group: z
    .array(
      z.preprocess((v) => {
        if (typeof v === "string") return v;
        if (v && typeof v === "object") {
          const obj = v as { name?: unknown; ticker?: unknown; symbol?: unknown };
          const name = typeof obj.name === "string" ? obj.name : "";
          const ticker =
            typeof obj.ticker === "string"
              ? obj.ticker
              : typeof obj.symbol === "string"
                ? obj.symbol
                : "";
          if (name && ticker) return `${name} (${ticker})`;
          return name || ticker || JSON.stringify(v);
        }
        return String(v);
      }, z.string()),
    )
    .default([]),
  say_on_pay: SayOnPay.optional(),
  _meta: ProxyExtractionMeta.optional(),
});

export type ProxyExtraction = z.infer<typeof ProxyExtraction>;
export type Director = z.infer<typeof Director>;
export type SummaryCompensationRow = z.infer<typeof SummaryCompensationRow>;
export type PayVsPerformanceRow = z.infer<typeof PayVsPerformanceRow>;

// JSON Schema sent to Gemini with the user prompt. Generated by hand from the
// Zod schemas because zod-to-json-schema would couple the runtime to a
// transitive dep, and the prompt-side shape rarely changes.
export const PROXY_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary_compensation: {
      type: "array",
      description:
        "One row per (named executive officer, fiscal year) combination in " +
        "the Summary Compensation Table. All dollar amounts in dollars, not thousands.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          title: { type: "string" },
          fiscal_year: { type: "integer" },
          salary: { type: ["number", "null"] },
          bonus: { type: ["number", "null"] },
          stock_awards: { type: ["number", "null"] },
          option_awards: { type: ["number", "null"] },
          non_equity_incentive_plan: { type: ["number", "null"] },
          change_in_pension_value: { type: ["number", "null"] },
          all_other_compensation: { type: ["number", "null"] },
          total: { type: ["number", "null"] },
        },
        required: ["name", "title", "fiscal_year", "total"],
      },
    },
    all_other_compensation_detail: {
      type: "array",
      description:
        "Itemization of the 'All Other Compensation' column from the footnote " +
        "(personal aircraft, security, club dues, financial planning, tax " +
        "gross-ups, severance, relocation, housing, etc).",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          fiscal_year: { type: "integer" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                category: { type: "string" },
                amount: { type: ["number", "null"] },
                description: { type: "string" },
              },
              required: ["category", "amount"],
            },
          },
        },
        required: ["name", "fiscal_year", "items"],
      },
    },
    ceo_pay_ratio: {
      type: "object",
      properties: {
        ceo_total_compensation: { type: ["number", "null"] },
        median_employee_compensation: { type: ["number", "null"] },
        ratio_x_to_1: { type: ["number", "null"] },
        fiscal_year: { type: ["integer", "null"] },
      },
    },
    director_compensation: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          fees_earned_or_paid_in_cash: { type: ["number", "null"] },
          stock_awards: { type: ["number", "null"] },
          option_awards: { type: ["number", "null"] },
          non_equity_incentive: { type: ["number", "null"] },
          all_other_compensation: { type: ["number", "null"] },
          total: { type: ["number", "null"] },
        },
        required: ["name", "total"],
      },
    },
    board: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: ["integer", "null"] },
          director_since_year: { type: ["integer", "null"] },
          independent: { type: ["boolean", "null"] },
          is_chair: { type: ["boolean", "null"] },
          is_lead_independent_director: { type: ["boolean", "null"] },
          committees: { type: "array", items: { type: "string" } },
          other_public_boards: { type: "array", items: { type: "string" } },
          attendance_below_75pct: { type: ["boolean", "null"] },
        },
        required: ["name"],
      },
    },
    board_structure: {
      type: "object",
      properties: {
        classified_board: { type: ["boolean", "null"] },
        dual_class_voting: { type: ["boolean", "null"] },
        chair_ceo_combined: { type: ["boolean", "null"] },
        lead_independent_director_name: { type: ["string", "null"] },
        shareholder_proposal_threshold: { type: ["string", "null"] },
        majority_voting_for_directors: { type: ["boolean", "null"] },
      },
    },
    related_party_transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          parties: { type: "array", items: { type: "string" } },
          amount_or_terms: { type: "string" },
        },
        required: ["description"],
      },
    },
    equity_ownership: {
      type: "array",
      description: "Beneficial-ownership table -- 5%+ holders and named officers/directors.",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          shares: { type: ["number", "null"] },
          percent_class: { type: ["number", "null"] },
        },
        required: ["name", "type"],
      },
    },
    compensation_consultants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          scope: { type: "string" },
          fees_paid: { type: ["number", "null"] },
        },
        required: ["name"],
      },
    },
    peer_group: { type: "array", items: { type: "string" } },
    say_on_pay: {
      type: "object",
      properties: {
        last_vote_year: { type: ["integer", "null"] },
        last_vote_approval_pct: { type: ["number", "null"] },
      },
    },
  },
  required: ["summary_compensation", "board"],
} as const;
