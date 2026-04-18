import Anthropic from "@anthropic-ai/sdk";
import { submitPlanTool, SUBMIT_PLAN_TOOL_NAME, type OperationalPlan } from "./tools";
import { OPUS_MODEL, PLAYBOOK_SYSTEM_PROMPT, buildPlaybookUserMessage, type PlaybookInput } from "./prompts";

export interface PlaybookTranslationResult {
  plan: OperationalPlan;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  };
  stopReason: string | null;
}

export function anthropic(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export async function translatePlaybook(env: Env, input: PlaybookInput): Promise<PlaybookTranslationResult> {
  const client = anthropic(env);
  const response = await client.messages.create({
    model: OPUS_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: [
      {
        type: "text",
        text: PLAYBOOK_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [submitPlanTool],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: buildPlaybookUserMessage(input) }],
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_PLAN_TOOL_NAME,
  );
  if (!toolBlock) {
    const textBlocks = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    throw new Error(
      `Opus did not call submit_plan. stop_reason=${response.stop_reason ?? "null"}. text: ${textBlocks.slice(0, 500)}`,
    );
  }
  const plan = toolBlock.input as OperationalPlan;

  return {
    plan,
    model: OPUS_MODEL,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? null,
    },
    stopReason: response.stop_reason,
  };
}
