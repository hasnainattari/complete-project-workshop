import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage, type ToolSet } from "ai";
import { createLovableAiGatewayRunIdFetch, getLovableAiGatewayRunId } from "./run-id.server";

export const AI_MODEL = "openai/gpt-6-astra";
export const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1";

/**
 * One Responses API call through Lovable AI Gateway. Streams server-side and
 * resolves to the final text. Tools run through the SDK's step loop.
 */
export async function runAiCall(opts: {
  request: Request;
  messages: ModelMessage[];
  instructions?: string;
  tools?: ToolSet;
  maxSteps?: number;
}): Promise<{ text: string; tokens: number }> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("AI is not configured in this project.");
  const runIdFetch = createLovableAiGatewayRunIdFetch(getLovableAiGatewayRunId(opts.request));
  const provider = createOpenAI({
    baseURL: GATEWAY_URL,
    apiKey,
    headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: runIdFetch.fetch,
  });
  const result = streamText({
    model: provider.responses(AI_MODEL),
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
    messages: opts.messages,
    ...(opts.tools && Object.keys(opts.tools).length
      ? { tools: opts.tools, stopWhen: stepCount(opts.maxSteps ?? 6) }
      : {}),
    providerOptions: {
      openai: {
        store: false,
        forceReasoning: true,
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
  });
  const [text, usage] = await Promise.all([result.text, result.usage]);
  return { text, tokens: usage?.totalTokens ?? 0 };
}

function stepCount(max: number) {
  // local helper to avoid importing experiment helpers
  let steps = 0;
  return async () => {
    steps += 1;
    return steps >= max;
  };
}
