import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../claude/client";
import { HAIKU_MODEL } from "../claude/prompts";

export interface HeadlineScore {
  headlineId: number;
  symbol: string;
  score: number;
  label: "bullish" | "bearish" | "neutral" | "mixed";
  rationale: string;
  scoredAt: string;
  scoredByModel: string;
}

const SENTIMENT_SYSTEM = `You are a financial news sentiment classifier.

Read each headline (and optional summary) and judge its likely directional impact on the named stock's near-term price.

OUTPUT: call the \`score_headline\` tool exactly once per headline.
- score: number in [-1, 1]. -1 = strongly bearish, 0 = neutral, +1 = strongly bullish.
- label: "bullish" | "bearish" | "neutral" | "mixed". Use "mixed" only when the headline contains conflicting signals.
- rationale: one short sentence (<=150 chars) explaining the call. No hedging.

Calibration:
- Earnings beat / raised guidance / new contract / approval / upgrade => bullish (0.4 to 0.9).
- Earnings miss / lowered guidance / lawsuit / probe / downgrade / layoffs => bearish (-0.4 to -0.9).
- Generic coverage, analyst opinion without target change, sector commentary => neutral (-0.2 to 0.2).
- Be skeptical of clickbait. "Could", "may", "potential" usually means lower confidence.
- Macro headlines that affect the named stock indirectly: scale to [-0.3, 0.3] unless very direct.`;

const scoreHeadlineTool: Anthropic.Tool = {
  name: "score_headline",
  description: "Return a directional sentiment score and label for the headline.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["score", "label", "rationale"],
    properties: {
      score: { type: "number", minimum: -1, maximum: 1 },
      label: { type: "string", enum: ["bullish", "bearish", "neutral", "mixed"] },
      rationale: { type: "string", maxLength: 200 },
    },
  },
};

const HEADLINE_TTL_SECONDS = 7 * 24 * 60 * 60;

function cacheKey(headlineId: number, symbol: string): string {
  return `sentiment:headline:${symbol.toUpperCase()}:${headlineId}:v1`;
}

export interface ClassifyInput {
  headlineId: number;
  symbol: string;
  headline: string;
  summary?: string;
}

export async function classifyHeadline(env: Env, input: ClassifyInput): Promise<HeadlineScore | null> {
  const cached = await env.CACHE.get<HeadlineScore>(cacheKey(input.headlineId, input.symbol), "json");
  if (cached) return cached;

  const userText = input.summary && input.summary.trim().length > 0
    ? `Symbol: ${input.symbol}\nHeadline: ${input.headline}\nSummary: ${input.summary.trim().slice(0, 1500)}`
    : `Symbol: ${input.symbol}\nHeadline: ${input.headline}`;

  let response: Anthropic.Message;
  try {
    const client = anthropic(env);
    response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 400,
      system: [{ type: "text", text: SENTIMENT_SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [scoreHeadlineTool],
      tool_choice: { type: "tool", name: "score_headline" },
      messages: [{ role: "user", content: userText }],
    });
  } catch (err) {
    console.warn("sentiment classify failed", { headlineId: input.headlineId, symbol: input.symbol, err: String(err) });
    return null;
  }

  const tool = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "score_headline",
  );
  if (!tool) return null;

  const raw = tool.input as { score?: unknown; label?: unknown; rationale?: unknown };
  const score = typeof raw.score === "number" && Number.isFinite(raw.score) ? Math.max(-1, Math.min(1, raw.score)) : 0;
  const label = (["bullish", "bearish", "neutral", "mixed"] as const).find((l) => l === raw.label) ?? "neutral";
  const rationale = typeof raw.rationale === "string" ? raw.rationale.slice(0, 200) : "";

  const result: HeadlineScore = {
    headlineId: input.headlineId,
    symbol: input.symbol.toUpperCase(),
    score,
    label,
    rationale,
    scoredAt: new Date().toISOString(),
    scoredByModel: HAIKU_MODEL,
  };
  await env.CACHE.put(cacheKey(input.headlineId, input.symbol), JSON.stringify(result), {
    expirationTtl: HEADLINE_TTL_SECONDS,
  });
  return result;
}

export async function classifyHeadlinesBatch(
  env: Env,
  inputs: ClassifyInput[],
  options: { concurrency?: number } = {},
): Promise<HeadlineScore[]> {
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 4));
  const results: HeadlineScore[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < inputs.length) {
      const idx = cursor++;
      const input = inputs[idx];
      if (!input) return;
      const score = await classifyHeadline(env, input);
      if (score) results.push(score);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

export interface SymbolSentimentSummary {
  symbol: string;
  scoredCount: number;
  averageScore: number | null;
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  mixedCount: number;
  topHeadlines: Array<{ headline: string; score: number; label: HeadlineScore["label"]; rationale: string }>;
}

export function summarizeScores(
  symbol: string,
  scores: Array<HeadlineScore & { headline: string }>,
): SymbolSentimentSummary {
  const sym = symbol.toUpperCase();
  if (scores.length === 0) {
    return {
      symbol: sym,
      scoredCount: 0,
      averageScore: null,
      bullishCount: 0,
      bearishCount: 0,
      neutralCount: 0,
      mixedCount: 0,
      topHeadlines: [],
    };
  }
  const avg = scores.reduce((s, x) => s + x.score, 0) / scores.length;
  const bullishCount = scores.filter((s) => s.label === "bullish").length;
  const bearishCount = scores.filter((s) => s.label === "bearish").length;
  const neutralCount = scores.filter((s) => s.label === "neutral").length;
  const mixedCount = scores.filter((s) => s.label === "mixed").length;
  const topHeadlines = [...scores]
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 5)
    .map((s) => ({ headline: s.headline, score: s.score, label: s.label, rationale: s.rationale }));
  return {
    symbol: sym,
    scoredCount: scores.length,
    averageScore: Number(avg.toFixed(3)),
    bullishCount,
    bearishCount,
    neutralCount,
    mixedCount,
    topHeadlines,
  };
}
