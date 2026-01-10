import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Assertion, Feedback, ToolCall } from "../types.js";

/**
 * Run code-based assertions against the sandbox state.
 */
export async function runCodeEvaluator(
  assertions: Assertion[],
  sandboxPath: string,
  toolCalls: ToolCall[],
  exitCode: number
): Promise<Feedback[]> {
  const feedback: Feedback[] = [];

  for (const assertion of assertions) {
    const result = await evaluateAssertion(
      assertion,
      sandboxPath,
      toolCalls,
      exitCode
    );
    feedback.push(result);
  }

  return feedback;
}

async function evaluateAssertion(
  assertion: Assertion,
  sandboxPath: string,
  toolCalls: ToolCall[],
  exitCode: number
): Promise<Feedback> {
  switch (assertion.type) {
    case "file_exists":
      return evaluateFileExists(assertion.path, sandboxPath);

    case "file_contains":
      return evaluateFileContains(
        assertion.path,
        assertion.pattern,
        sandboxPath,
        false
      );

    case "file_not_contains":
      return evaluateFileContains(
        assertion.path,
        assertion.pattern,
        sandboxPath,
        true
      );

    case "tool_called":
      return evaluateToolCalled(assertion.name, assertion.args, toolCalls, false);

    case "tool_not_called":
      return evaluateToolCalled(assertion.name, undefined, toolCalls, true);

    case "exit_code":
      return evaluateExitCode(assertion.expected, exitCode);

    default:
      return {
        key: `unknown_assertion`,
        score: 0,
        passed: false,
        comment: `Unknown assertion type: ${(assertion as Assertion).type}`,
      };
  }
}

async function evaluateFileExists(
  path: string,
  sandboxPath: string
): Promise<Feedback> {
  const fullPath = join(sandboxPath, path);
  const key = `file_exists:${path}`;

  try {
    await readFile(fullPath);
    return {
      key,
      score: 1,
      passed: true,
      comment: `File exists: ${path}`,
    };
  } catch {
    return {
      key,
      score: 0,
      passed: false,
      comment: `File not found: ${path}`,
    };
  }
}

async function evaluateFileContains(
  path: string,
  pattern: string,
  sandboxPath: string,
  negate: boolean
): Promise<Feedback> {
  const fullPath = join(sandboxPath, path);
  const key = negate ? `file_not_contains:${path}` : `file_contains:${path}`;

  try {
    const content = await readFile(fullPath, "utf-8");
    const regex = new RegExp(pattern);
    const matches = regex.test(content);

    const passed = negate ? !matches : matches;

    return {
      key,
      score: passed ? 1 : 0,
      passed,
      comment: passed
        ? negate
          ? `File does not contain pattern: ${pattern}`
          : `File contains pattern: ${pattern}`
        : negate
          ? `File unexpectedly contains pattern: ${pattern}`
          : `File does not contain pattern: ${pattern}`,
    };
  } catch {
    return {
      key,
      score: 0,
      passed: false,
      comment: `File not found: ${path}`,
    };
  }
}

function evaluateToolCalled(
  name: string,
  expectedArgs: Record<string, unknown> | undefined,
  toolCalls: ToolCall[],
  negate: boolean
): Promise<Feedback> {
  const key = negate ? `tool_not_called:${name}` : `tool_called:${name}`;

  const matchingCalls = toolCalls.filter((call) => {
    if (call.name !== name) return false;

    if (expectedArgs) {
      // Check if args match (partial match)
      for (const [key, value] of Object.entries(expectedArgs)) {
        const callArgs = call.args as Record<string, unknown>;
        if (callArgs[key] !== value) return false;
      }
    }

    return true;
  });

  const found = matchingCalls.length > 0;
  const passed = negate ? !found : found;

  return Promise.resolve({
    key,
    score: passed ? 1 : 0,
    passed,
    comment: passed
      ? negate
        ? `Tool was not called: ${name}`
        : `Tool was called: ${name} (${matchingCalls.length} times)`
      : negate
        ? `Tool was unexpectedly called: ${name}`
        : `Tool was not called: ${name}`,
  });
}

function evaluateExitCode(expected: number, actual: number): Feedback {
  const key = `exit_code:${expected}`;
  const passed = expected === actual;

  return {
    key,
    score: passed ? 1 : 0,
    passed,
    comment: passed
      ? `Exit code matches: ${expected}`
      : `Exit code mismatch: expected ${expected}, got ${actual}`,
  };
}
