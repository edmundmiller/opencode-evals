import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Feedback, ToolCall, Example, RubricItem, RubricLevel, DEFAULT_RUBRIC_LEVELS } from "../types.js";

const DEFAULT_MODEL = "minimax-m2.1-free";
const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen";
const AUTH_JSON_PATH = join(homedir(), ".local/share/opencode/auth.json");

/** Default rubric levels if not specified */
const DEFAULT_LEVELS: RubricLevel[] = [
  { score: 0, label: "None", description: "Criterion not addressed at all" },
  { score: 1, label: "Poor", description: "Minimal attempt, major issues" },
  { score: 2, label: "Fair", description: "Partial completion, some issues" },
  { score: 3, label: "Good", description: "Mostly complete, minor issues" },
  { score: 4, label: "Excellent", description: "Fully meets or exceeds expectations" },
];

export interface Criterion {
  name: string;
  description: string;
  weight?: number;
}

export interface LLMJudgeOptions {
  criteria?: (string | Criterion)[];
  rubric?: RubricItem[];
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
 * Supports both simple criteria (pass/fail) and rubric-based grading (0-4 scale).
 */
export async function runLLMJudge(
  options: LLMJudgeOptions,
  query: string,
  toolCalls: ToolCall[],
  finalFiles: Record<string, string>,
  referenceOutputs?: Example["reference_outputs"]
): Promise<Feedback[]> {
  const auth = getClient();
  
  // Determine items to evaluate
  const items = options.rubric ?? options.criteria ?? [];
  
  if (!auth) {
    console.warn("  ⚠️  No LLM auth available (tried OpenCode Zen, ANTHROPIC_API_KEY) - skipping LLM judge");
    return items.map((item) => {
      const name = typeof item === "string" ? item.slice(0, 30) : item.name;
      const weight = typeof item === "string" ? 1.0 : (item.weight ?? 1.0);
      return createFeedback(`llm_judge:${name}`, 0, weight, false, "Skipped: No LLM authentication available");
    });
  }

  const { client, source } = auth;
  const model = options.model ?? DEFAULT_MODEL;
  
  console.log(`  Using ${source} with model ${model}`);

  const feedback: Feedback[] = [];

  // Handle rubric-based grading
  if (options.rubric) {
    for (const rubricItem of options.rubric) {
      const result = await evaluateRubricItem(
        client,
        model,
        rubricItem,
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

  // Handle simple criteria (backward compatible)
  for (const criterion of options.criteria ?? []) {
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

/**
 * Helper to create properly structured Feedback objects.
 */
function createFeedback(
  key: string,
  score: number,
  weight: number,
  passed: boolean,
  comment?: string,
  rubric_level?: string,
  maxScore: number = 1
): Feedback {
  const normalized_score = maxScore > 0 ? score / maxScore : 0;
  return {
    key,
    score,
    normalized_score,
    weight,
    weighted_score: normalized_score * weight,
    passed,
    comment,
    rubric_level,
  };
}

/**
 * Evaluate a rubric item using structured 0-4 scoring.
 */
async function evaluateRubricItem(
  client: Anthropic,
  model: string,
  rubricItem: RubricItem,
  query: string,
  toolCalls: ToolCall[],
  finalFiles: Record<string, string>,
  referenceOutputs: Example["reference_outputs"] | undefined,
  referenceFree: boolean
): Promise<Feedback> {
  const key = `llm_judge:${rubricItem.name}`;
  const weight = rubricItem.weight ?? 1.0;
  const levels = rubricItem.levels ?? DEFAULT_LEVELS;
  const maxScore = Math.max(...levels.map(l => l.score));

  // Build context about what happened
  const toolCallSummary = toolCalls
    .map((t) => `- ${t.name}: ${JSON.stringify(t.args ?? {}).slice(0, 200)}`)
    .join("\n");

  const fileSummary = Object.entries(finalFiles)
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 1000)}\n\`\`\``)
    .join("\n\n");

  const levelDescriptions = levels
    .sort((a, b) => b.score - a.score)
    .map((l) => `  ${l.score} - ${l.label}: ${l.description}`)
    .join("\n");

  let prompt = `You are evaluating an AI coding assistant's work using a structured rubric.

## Original Query
${query}

## Tool Calls Made
${toolCallSummary || "No tool calls recorded"}

## Final Files
${fileSummary || "No files in workspace"}

## Rubric Criterion
**${rubricItem.name}**: ${rubricItem.description}

## Scoring Levels
${levelDescriptions}
`;

  if (!referenceFree && referenceOutputs) {
    prompt += `
## Expected Reference
${JSON.stringify(referenceOutputs, null, 2)}
`;
  }

  prompt += `
## Your Task
Evaluate the work against this rubric criterion. Select the most appropriate score level.
Respond with a JSON object:
{
  "score": <number 0-${maxScore}>,
  "level": "<label of the selected level>",
  "comment": "Brief explanation of why this score was chosen"
}

Respond ONLY with the JSON object, no other text.`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    let text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Strip markdown code fences if present
    text = text.trim();
    const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (fenceMatch) {
      text = fenceMatch[1].trim();
    }
    if (!text.startsWith("{")) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        text = jsonMatch[0];
      }
    }

    const result = JSON.parse(text.trim());
    const score = typeof result.score === "number" ? result.score : 0;
    // Pass if score is >= 60% of max (level 3+ on 0-4 scale)
    const passed = score >= maxScore * 0.6;

    return createFeedback(
      key,
      score,
      weight,
      passed,
      result.comment,
      result.level,
      maxScore
    );
  } catch (error) {
    return createFeedback(key, 0, weight, false, `LLM judge error: ${error}`, undefined, maxScore);
  }
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
    let text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Strip markdown code fences if present (some models wrap JSON in ```json...```)
    text = text.trim();
    // Handle various markdown fence formats
    const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (fenceMatch) {
      text = fenceMatch[1].trim();
    }
    // Also try to extract JSON object if there's extra text around it
    if (!text.startsWith("{")) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        text = jsonMatch[0];
      }
    }

    // Parse JSON response
    const result = JSON.parse(text.trim());
    const score = typeof result.score === "number" ? result.score : result.passed ? 1 : 0;

    return createFeedback(
      key,
      score,
      criterion.weight ?? 1.0,
      Boolean(result.passed),
      result.comment ?? undefined
    );
  } catch (error) {
    return createFeedback(
      key,
      0,
      criterion.weight ?? 1.0,
      false,
      `LLM judge error: ${error}`
    );
  }
}
