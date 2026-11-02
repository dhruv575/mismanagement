// Chat-completions client for structured extraction from filing text,
// via Vercel AI Gateway (OpenAI-compatible). Text-only.
//
// Strict json_schema enforcement varies by provider, so we ask for
// json_object with the schema embedded in the prompt and parse with a
// tolerant fallback that walks the response for balanced top-level objects.

import { LLM_MODEL, aiGatewayApiKey } from "./env.js";

const ENDPOINT = "https://ai-gateway.vercel.sh/v1/chat/completions";

export interface LLMCallOpts {
  systemPrompt: string;
  userPrompt: string;
  /** Defaults to LLM_MODEL from env. */
  model?: string;
  /** Output budget. 13D / vote extractions are a few hundred tokens;
   * 8192 leaves ample headroom. */
  maxTokens?: number;
}

export interface LLMCallResult {
  json: unknown;
  raw: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  finishReason?: string;
}

export async function callLLM(opts: LLMCallOpts): Promise<LLMCallResult> {
  // json_object mode plus the tolerant parser below recovers from code
  // fences or trailing commentary. Keep inputs short: a filing's relevant
  // section, not the whole document.
  const body = {
    model: opts.model ?? LLM_MODEL,
    max_tokens: opts.maxTokens ?? 8192,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  };

  // Retry on transient errors: 429 rate limits, 5xx, and TCP-level
  // "terminated" reads.
  // Honors `retry_after_seconds` from the JSON body when present; else
  // exponential with jitter, capped at 30s. Without this, our R3K extract
  // dropped 7-9% of issuers to transient errors that would have cleared
  // in seconds.
  const MAX_ATTEMPTS = 6;
  let delay = 2_000;
  let res: Response;
  let lastErr = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${aiGatewayApiKey()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (res.ok) break;
      const text = await res.text();
      lastErr = `${res.status}: ${text.slice(0, 500)}`;
      const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retriable || attempt === MAX_ATTEMPTS) {
        throw new Error(`AI Gateway ${lastErr}`);
      }
      let waitMs = delay + Math.floor(Math.random() * 500);
      const m = text.match(/"retry_after_seconds"\s*:\s*(\d+(?:\.\d+)?)/);
      if (m) waitMs = Math.min(parseFloat(m[1]!) * 1000 + 500, 30_000);
      await new Promise((r) => setTimeout(r, waitMs));
      delay = Math.min(delay * 2, 30_000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retriable = /terminated|fetch failed|ECONN|socket hang up|timeout|network/i.test(msg);
      if (!retriable || attempt === MAX_ATTEMPTS) throw e;
      lastErr = msg;
      await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * 500)));
      delay = Math.min(delay * 2, 30_000);
    }
  }
  // @ts-expect-error res is assigned inside the loop on success
  if (!res || !res.ok) throw new Error(`AI Gateway exhausted retries: ${lastErr}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const choice = data.choices?.[0];
  const content: string = choice?.message?.content ?? "";
  const finishReason = choice?.finish_reason;
  const usage = data.usage
    ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens }
    : undefined;
  console.log(
    `[llm] finish_reason=${finishReason ?? "?"} ` +
      `prompt_tokens=${usage?.prompt_tokens ?? "?"} ` +
      `completion_tokens=${usage?.completion_tokens ?? "?"} ` +
      `content_chars=${content.length}`,
  );
  if (finishReason && finishReason !== "stop") {
    console.warn(`[llm] non-stop finish_reason; output may be truncated`);
  }
  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch (e) {
    // Re-raise with the raw content attached so callers can persist it for
    // debugging without re-running the (paid) call.
    const err = e as Error & { raw?: string; finishReason?: string };
    err.raw = content;
    err.finishReason = finishReason;
    throw err;
  }
  return { json: unwrapSchemaEcho(parsed), raw: content, usage, finishReason };
}

// Small models sometimes echo the prompt's JSON-schema wrapper and nest the
// answer inside it: {"type":"object","properties":{...actual fields...}}.
function unwrapSchemaEcho(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const props = o.properties;
    if (o.type === "object" && props && typeof props === "object" && !Array.isArray(props)) {
      // Only when the inner values look like data, not schema fragments.
      const vals = Object.values(props as Record<string, unknown>);
      const schemaLike = vals.every((x) => x && typeof x === "object" && "type" in (x as object));
      if (!schemaLike) return props;
    }
  }
  return v;
}

function extractJson(s: string): unknown {
  // Strip ```json ... ``` fences if the model added them despite instructions.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const text = (fenced ? fenced[1]! : s).trim();

  try {
    return JSON.parse(text);
  } catch {
    // Fall through to balanced-brace walk -- models sometimes append a
    // self-critique block after the primary JSON, so we want the first
    // top-level object that parses cleanly.
  }

  for (const candidate of findJsonObjects(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }
  throw new Error(`Could not parse JSON; first 200 chars: ${text.slice(0, 200)}`);
}

function findJsonObjects(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "{") {
      i++;
      continue;
    }
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (; i < s.length; i++) {
      const ch = s[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          out.push(s.slice(start, i + 1));
          i++;
          break;
        }
      }
    }
    if (depth !== 0) break;
  }
  return out;
}
