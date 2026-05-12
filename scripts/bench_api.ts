// Quick wall-clock benchmark over the dev API. Run with:
//   pnpm tsx scripts/bench_api.ts
// Hits each endpoint twice (cold + warm — the second result is usually
// dominated by the Postgres planner cache + Vercel/Neon WS reuse).

const BASE = process.env.API_URL ?? "http://localhost:5071/api";

const ENDPOINTS: Array<[string, string]> = [
  ["/health", "health"],
  ["/overview", "home: overview"],
  ["/mismanagement?min_mcap=1000000000&limit=300", "home: leaderboard (top-300 r3k+1bn)"],
  ["/search?q=okt", "home: search"],
  ["/companies/OKTA", "company: meta"],
  ["/companies/OKTA/sheet", "company: sheet"],
  ["/companies/OKTA/financials", "company: financials"],
  ["/companies/OKTA/prices?limit=1300", "company: prices"],
  ["/companies/OKTA/comp", "company: comp"],
  ["/companies/OKTA/board", "company: board"],
  ["/companies/OKTA/insider-activity?days=365", "company: insider 365d"],
  ["/companies/OKTA/13d", "company: 13d"],
  ["/companies/OKTA/mismanagement", "company: scorecard"],
  ["/mismanagement/rank/OKTA", "company: rank"],
  ["/companies/OKTA/peers", "company: peers"],
];

async function hit(path: string): Promise<{ ms: number; bytes: number; status: number }> {
  const t0 = performance.now();
  const r = await fetch(BASE + path);
  const buf = await r.arrayBuffer();
  return { ms: performance.now() - t0, bytes: buf.byteLength, status: r.status };
}

async function main() {
  console.log(`Hitting ${BASE}`);
  console.log("");
  console.log("endpoint                                cold     warm     payload");
  console.log("─".repeat(76));

  for (const [path, label] of ENDPOINTS) {
    try {
      const cold = await hit(path);
      const warm = await hit(path);
      const tag = cold.status === 200 ? "" : ` [${cold.status}]`;
      const kb = (cold.bytes / 1024).toFixed(1).padStart(7);
      console.log(
        `${label.padEnd(38)} ${cold.ms.toFixed(0).padStart(5)}ms  ${warm.ms.toFixed(0).padStart(5)}ms  ${kb}KB${tag}`,
      );
    } catch (e) {
      console.log(`${label.padEnd(38)} ERROR ${String(e)}`);
    }
  }

  // Concurrent burst — what the company page actually does on first paint.
  console.log("");
  console.log("Company-page bundle (parallel fire, one ticker):");
  const t0 = performance.now();
  await Promise.all([
    hit("/companies/OKTA"),
    hit("/companies/OKTA/sheet"),
    hit("/companies/OKTA/financials"),
    hit("/companies/OKTA/prices?limit=1300"),
    hit("/companies/OKTA/comp"),
    hit("/companies/OKTA/board"),
    hit("/companies/OKTA/insider-activity?days=365"),
    hit("/companies/OKTA/13d"),
    hit("/companies/OKTA/mismanagement"),
    hit("/mismanagement/rank/OKTA"),
    hit("/companies/OKTA/peers"),
  ]);
  console.log(`  wall: ${(performance.now() - t0).toFixed(0)}ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
