import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Feedback, ToolCall, Example } from "../types.js";

const DEFAULT_MODEL = "minimax-m2.1-free";
const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen";
const AUTH_JSON_PATH = join(homedir(), ".local/share/opencode/auth.json");

export interface Criterion {
  name: string;
  description: string;
  weight?: number;
}

export interface LLMJudgeOptions {
  criteria: (string | Criterion)[];
  reference_free?: boolean;
  model?: string;
}

interface AuthJson {
  opencode?: {
    type: string;
    key: string;
  };
  anthropic?: {
    type: string;
    access?: string;
  };
}

/**
 * Get Anthropic client with auth.
 * Priority:
 * 1. OpenCode Zen (from auth.json) - uses minimax-m2.1-free
 * 2. ANTHROPIC_API_KEY env var - uses claude models
 * 3. null if neither available
 */
function getClient(): { client: Anthropic; source: string } | null {
  // Try OpenCode Zen first
  if (existsSync(AUTH_JSON_PATH)) {
    try {
      const authJson: AuthJson = JSON.parse(readFileSync(AUTH_JSON_PATH, "utf-8"));
      if (authJson.opencode?.key) {
        const client = new Anthropic({
          apiKey: authJson.opencode.key,
          baseURL: OPENCODE_ZEN_BASE_URL,
        });
        return { client, source: "OpenCode Zen" };
      }
    } catch {
      // Fall through to next option
    }
  }

  // Fallback to ANTHROPIC_API_KEY env var
  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic();
    return { client, source: "ANTHROPIC_API_KEY" };
  }

  return null;
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
  const auth = getClient();
  
  if (!auth) {
    console.warn("  ⚠️  No LLM auth available (tried OpenCode Zen, ANTHROPIC_API_KEY) - skipping LLM judge");
    return options.criteria.map((c) => {
      const name = typeof c === "string" ? c.slice(0, 30) : c.name;
      return {
        key: `llm_judge:${name}`,
        score: 0,
        passed: false,
        comment: "Skipped: No LLM authentication available",
      };
    });
  }

  const { client, source } = auth;
  const model = options.model ?? DEFAULT_MODEL;
  
  console.log(`  Using ${source} with model ${model}`);

  const feedback: Feedback[] = [];

  for (const criterion of options.criteria) {
    // Normalize criterion to object format
    const normalized: Criterion = typeof criterion === "string"
      ? { name: criterion.slice(0, 30), description: criterion, weight: 1.0 }
      : criterion;
    
    const result = await evaluateCriterion(
      client,
      model,
      normalized,
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
  criterion: Criterion,
  query: string,
  toolCalls: ToolCall[],
  finalFiles: Record<string, string>,
  referenceOutputs: Example["reference_outputs"] | undefined,
  referenceFree: boolean
): Promise<Feedback> {
  const key = `llm_judge:${criterion.name}`;

  // Build context about what happened
  const toolCallSummary = toolCalls
    .map((t) => `- ${t.name}: ${JSON.stringify(t.args ?? {}).slice(0, 200)}`)
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
**${criterion.name}**: ${criterion.description}
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
