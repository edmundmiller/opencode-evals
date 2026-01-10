import Anthropic from "@anthropic-ai/sdk";
import type { Feedback, ToolCall, Example } from "../types.js";

const DEFAULT_MODEL = "claude-3-haiku-20240307";

export interface LLMJudgeOptions {
  criteria: string[];
  reference_free?: boolean;
  model?: string;
}

/**
 * Use an LLM to evaluate whether criteria were met.
 */
export async function runLLMJudge(
  options: LLMJudgeOptions,
  query: string,
  toolCalls: ToolCall[],
  finalFiles: Record<string, string>,
  referenceOutputs?: Example["reference_outputs"]
): Promise<Feedback[]> {
  const client = new Anthropic();
  const model = options.model ?? DEFAULT_MODEL;

  const feedback: Feedback[] = [];

  for (const criterion of options.criteria) {
    const result = await evaluateCriterion(
      client,
      model,
      criterion,
      query,
      toolCalls,
      finalFiles,
      referenceOutputs,
      options.reference_free ?? true
    );
    feedback.push(result);
  }

  return feedback;
}

async function evaluateCriterion(
  client: Anthropic,
  model: string,
  criterion: string,
  query: string,
  toolCalls: ToolCall[],
  finalFiles: Record<string, string>,
  referenceOutputs: Example["reference_outputs"] | undefined,
  referenceFree: boolean
): Promise<Feedback> {
  const key = `llm_judge:${criterion.slice(0, 50)}`;

  // Build context about what happened
  const toolCallSummary = toolCalls
    .map((t) => `- ${t.name}: ${JSON.stringify(t.args).slice(0, 200)}`)
    .join("\n");

  const fileSummary = Object.entries(finalFiles)
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 1000)}\n\`\`\``)
    .join("\n\n");

  let prompt = `You are evaluating whether an AI coding assistant successfully met a criterion.

## Original Query
${query}

## Tool Calls Made
${toolCallSummary || "No tool calls recorded"}

## Final Files
${fileSummary || "No files in workspace"}

## Criterion to Evaluate
${criterion}
`;

  if (!referenceFree && referenceOutputs) {
    prompt += `
## Expected Reference
${JSON.stringify(referenceOutputs, null, 2)}
`;
  }

  prompt += `
## Your Task
Evaluate whether the criterion was met. Respond with a JSON object:
{
  "passed": true or false,
  "score": 0.0 to 1.0 (confidence/quality score),
  "comment": "Brief explanation of your judgment"
}

Respond ONLY with the JSON object, no other text.`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    // Extract text from response
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Parse JSON response
    const result = JSON.parse(text.trim());

    return {
      key,
      score: typeof result.score === "number" ? result.score : result.passed ? 1 : 0,
      passed: Boolean(result.passed),
      comment: result.comment ?? undefined,
    };
  } catch (error) {
    return {
      key,
      score: 0,
      passed: false,
      comment: `LLM judge error: ${error}`,
    };
  }
}
