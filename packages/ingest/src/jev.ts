// Decision-model client: TypeSafe Jev through AI Gateway's /v1/decisions.
// One request answers every factor question against one excerpt and returns
// typed answers (no JSON parsing or schema repair).
import { aiGatewayApiKey } from "./env.js";
import { type Factor, JEV } from "./factors.js";

export async function decideFactors(input: string, factors: Factor[], model = JEV): Promise<{ scores: Record<string, number>; cost: number }> {
  const body = JSON.stringify({
    model, input,
    questions: factors.map((f) => f.levels
      ? { type: "score", name: f.name, instructions: f.instructions, levels: f.levels.map((label) => ({ label })) }
      : { type: "predicate", name: f.name, instructions: f.instructions }),
    providerOptions: { gateway: { zeroDataRetention: true } },
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/decisions", {
      method: "POST", body, signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${aiGatewayApiKey()}`, "Content-Type": "application/json" },
    });
    if (res.ok) {
      const j = await res.json() as { answers: { name: string; type: string; score?: number; probability?: number }[]; provider_metadata?: { gateway?: { cost?: string } } };
      const scores: Record<string, number> = {};
      for (const a of j.answers) {
        const f = factors.find((x) => x.name === a.name)!;
        scores[a.name] = a.type === "predicate" ? a.probability! * 10 : (a.score! / (f.levels!.length - 1)) * 10;
      }
      return { scores, cost: Number(j.provider_metadata?.gateway?.cost ?? 0) };
    }
    const msg = `decisions ${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (attempt >= 4 || (res.status >= 400 && res.status < 500 && res.status !== 429)) throw new Error(msg);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}
