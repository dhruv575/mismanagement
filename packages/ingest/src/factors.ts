// Business factors read from a 10-K's Item 1 by a decision model (Jev via
// AI Gateway /v1/decisions). Each factor is one typed question; all of them
// are answered in a single request per filing, and the cost is set by the
// excerpt length, not the number of questions, so adding a factor is free.
//
// Scores are stored 0-10 (an ordinal question's interpolated rung, rescaled)
// and predicates as 0-10 too (probability x 10), so every factor reads the
// same way in the models and on the site.

export interface Factor {
  name: string;
  group: "rollup" | "model" | "market" | "ownership" | "situation";
  label: string;          // short name for the site
  instructions: string;
  levels?: string[];      // ordinal, lowest first; omitted = yes/no predicate
}

const lv = (...l: string[]) => l;

export const FACTORS: Factor[] = [
  // ---- the AI-rollup profile (the original six) ----
  { name: "services_share", group: "rollup", label: "Services share",
    instructions: "How much of revenue comes from services that people deliver (consulting, administration, brokerage, staffing, field service, outsourced processing)? Software, apps, online platforms and subscriptions to them are products, not services. So are goods, drugs, commodities, real estate and lending.",
    levels: lv("almost none: products, software, platforms, commodities, property or lending", "a small share of people-delivered services", "a mix of products and people-delivered services", "mostly people-delivered services", "almost all revenue is people-delivered services") },
  { name: "labor_intensity", group: "rollup", label: "Labor intensity",
    instructions: "How much do employee costs dominate the company's cost base?",
    levels: lv("employees are a minor cost next to materials, capital or content", "employees are a meaningful but not leading cost", "employees are roughly half the cost base", "employees are the largest cost", "employee costs dominate everything else") },
  { name: "ai_automatable", group: "rollup", label: "AI-automatable work",
    instructions: "How much of what this company's employees do is document, communication, analysis or back-office process work that current AI could do? Manufacturing, field work, driving, clinical care, construction and retail floor work are not.",
    levels: lv("almost none: physical, clinical or hands-on work", "a little: mostly physical work with some office work", "about half office and process work", "mostly office, document and process work", "almost all document, communication and process work") },
  { name: "fragmented_market", group: "rollup", label: "Fragmented market",
    instructions: "Is the company's market made of many small competitors, leaving room to buy and combine them?",
    levels: lv("a few giants dominate", "concentrated among a handful of large players", "a mix of large and small players", "many competitors, mostly small", "highly fragmented: thousands of small local firms") },
  { name: "recurring_revenue", group: "rollup", label: "Recurring revenue",
    instructions: "How much of revenue is contracted, subscription or reliably repeat business?",
    levels: lv("one-off sales or projects", "some repeat customers", "about half recurring", "mostly contracted or repeat", "almost all contracted, subscription or repeat") },
  { name: "rollup_fit", group: "rollup", label: "AI-rollup fit",
    instructions: "AI rollups buy people-heavy services businesses (accounting, IT services, BPO, insurance brokerage, healthcare administration, staffing, property management, marketing services, payroll, freight brokerage) and automate the work with AI. How good a target is this company, all things considered?",
    levels: lv("a poor fit", "a weak fit", "a possible fit", "a good fit", "an ideal target") },

  // Yes/no twins: Jev's predicates separate cases more sharply than its
  // ordinal scales, which bunch toward the middle (Orthofix scored 6.5 on
  // the scale version of "AI-automatable work", 0.3 on the predicate).
  { name: "office_work", group: "rollup", label: "Office work is the product", instructions: "Is the company's product mainly office work done by people (processing documents, handling claims or transactions, answering customers, consulting, recruiting, bookkeeping) rather than physical goods, software or capital assets?" },
  { name: "people_services", group: "rollup", label: "People-delivered services", instructions: "Does most revenue come from services delivered by the company's employees, as opposed to selling goods, software, content, capital or access to assets?" },
  { name: "payroll_heavy", group: "rollup", label: "Payroll is the main cost", instructions: "Are salaries and wages the company's largest cost?" },
  { name: "many_small_rivals", group: "rollup", label: "Many small rivals", instructions: "Does the company compete mainly against many small, local or regional firms?" },
  { name: "contracted", group: "rollup", label: "Contracted revenue", instructions: "Does most revenue come from multi-year contracts, subscriptions, retainers or recurring fees?" },
  { name: "rollup_target", group: "rollup", label: "AI-rollup target", instructions: "Would an AI-rollup buyer (one that acquires people-heavy services firms and automates the work with AI) want to buy this company?" },

  // ---- business model ----
  { name: "software_platform", group: "model", label: "Software or platform", instructions: "Does the company mainly sell software, SaaS, an app, an online marketplace or a digital platform?" },
  { name: "b2b", group: "model", label: "Sells to businesses",
    instructions: "Who are the customers?",
    levels: lv("consumers only", "mostly consumers", "a mix of consumers and businesses", "mostly businesses or governments", "only businesses or governments") },
  { name: "asset_light", group: "model", label: "Asset-light",
    instructions: "How much does the business depend on heavy physical assets (plants, fleets, networks, mines, real estate, inventory)?",
    levels: lv("extremely asset-heavy", "asset-heavy", "moderate assets", "light assets", "almost no physical assets: people and software") },
  { name: "physical_ops", group: "model", label: "Physical operations", instructions: "Does most of the work happen on site or in the field: manufacturing, construction, installation, repair, transport, mining, farming or in-person care?" },
  { name: "regulated", group: "model", label: "Heavily regulated", instructions: "Is the business heavily regulated or licensed (banking, insurance, utilities, healthcare providers, defense, gambling, telecom, pharma approvals)?" },
  { name: "gov_customers", group: "model", label: "Government customers", instructions: "Does a large share of revenue come from government agencies or government programs (federal contracts, Medicare, Medicaid, defense)?" },
  { name: "customer_concentration", group: "model", label: "Customer concentration", instructions: "Does a small number of customers account for a large share of revenue (for example one customer over 10%, or top few over a third)?" },
  { name: "franchise_model", group: "model", label: "Franchise or network model", instructions: "Does the company run a franchise, dealer, agent or affiliate network model?" },
  { name: "multi_segment", group: "model", label: "Several unrelated segments", instructions: "Does the company run several distinct, largely unrelated business segments (a conglomerate that could be broken up)?" },
  { name: "acquisitive", group: "model", label: "Serial acquirer", instructions: "Does the company describe growing through frequent acquisitions, or a roll-up or buy-and-build strategy of its own?" },

  // ---- market ----
  { name: "cyclical", group: "market", label: "Cyclical", instructions: "Is demand strongly tied to the economic, housing, credit, commodity or industrial cycle?" },
  { name: "commodity_exposure", group: "market", label: "Commodity prices drive results", instructions: "Do commodity prices (oil, gas, metals, crops, chemicals) drive the company's revenue or costs?" },
  { name: "niche_leader", group: "market", label: "Niche leader", instructions: "Does the company describe itself as the leader, or a top player, in a specific niche or specialty market?" },
  { name: "us_focused", group: "market", label: "Mostly U.S.",
    instructions: "How much of the business is in the United States?",
    levels: lv("mostly outside the U.S.", "more outside than inside", "about half", "mostly U.S.", "almost entirely U.S.") },
  { name: "growth_stage", group: "market", label: "Growth stage",
    instructions: "What stage is the business in?",
    levels: lv("declining or in turnaround", "mature and flat", "steady modest growth", "growing fast", "early-stage, pre-profit hypergrowth") },
  { name: "disruption_risk", group: "market", label: "Threatened by technology", instructions: "Is the company's core business at clear risk of being displaced by new technology, AI or digital competitors?" },
  { name: "pricing_power", group: "market", label: "Pricing power",
    instructions: "How much pricing power does the company appear to have?",
    levels: lv("a price-taker in a commodity market", "weak", "average", "strong: differentiated or essential", "very strong: must-have, few alternatives") },

  // ---- ownership and governance ----
  // Strict wording ("does the text say..."): without it Jev answers ~0.5 when
  // the excerpt is silent, which is noise rather than a maybe.
  { name: "sponsor_backed", group: "ownership", label: "PE-backed", instructions: "Does the text say a private-equity firm or financial sponsor owns a significant stake in the company, or that it went public as a sponsor-backed company? Answer no unless the text says so." },
  { name: "controlled_company", group: "ownership", label: "Controlled company", instructions: "Does the text say that one shareholder, parent company, family or group controls a majority of the company's voting power? Answer no unless the text says so." },
  { name: "founder_led", group: "ownership", label: "Founder-led", instructions: "Does the text say the company's founder or founding family still runs it as CEO or chairman? Answer no unless the text says so." },
  { name: "dual_class", group: "ownership", label: "Dual-class shares", instructions: "Does the text describe multiple classes of common stock with different voting rights? Answer no unless the text says so." },
  { name: "recent_listing", group: "ownership", label: "Recently listed", instructions: "Does the text say the company went public, emerged from bankruptcy, merged with a SPAC or was spun off within the last few years? Answer no unless the text says so." },
  { name: "foreign_parent", group: "ownership", label: "Foreign parent or HQ", instructions: "Is the company headquartered outside the U.S., or majority owned by a foreign parent?" },

  // ---- situation ----
  { name: "restructuring", group: "situation", label: "Restructuring", instructions: "Does the company describe a restructuring, a turnaround, major cost cutting, a transformation program or a review of strategic alternatives?" },
  { name: "distress", group: "situation", label: "Financial distress", instructions: "Does the company describe financial distress: going-concern doubt, covenant problems, debt restructuring or bankruptcy?" },
  { name: "portfolio_change", group: "situation", label: "Selling or buying businesses", instructions: "Has the company recently sold, spun off or bought a major business, or does it plan to?" },
  { name: "small_scale", group: "situation", label: "Subscale", instructions: "Does the company seem small or subscale next to its main competitors?" },
];

export const FACTOR_NAMES = FACTORS.map((f) => f.name);
export const JEV = "typesafe-ai/jev";
