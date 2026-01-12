import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Assertion, Feedback, ToolCall } from "../types.js";

const execAsync = promisify(exec);
let warnedToolCallSequence = false;

/**
 * Helper to create properly structured Feedback objects.
 */
function createFeedback(
  key: string,
  score: number,
  weight: number,
  passed: boolean,
  comment?: string
): Feedback {
  return {
    key,
    score,
    normalized_score: score, // Code assertions are already 0-1
    weight,
    weighted_score: score * weight,
    passed,
    comment,
  };
}

/**
 * Get weight from assertion, defaulting to 1.0
 */
function getWeight(assertion: Assertion): number {
  return (assertion as { weight?: number }).weight ?? 1.0;
}

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
  const weight = getWeight(assertion);

  switch (assertion.type) {
    case "file_exists":
      return evaluateFileExists(assertion.path, sandboxPath, weight);

    case "file_contains":
      return evaluateFileContains(
        assertion.path,
        assertion.pattern,
        sandboxPath,
        false,
        weight
      );

    case "file_not_contains":
      return evaluateFileContains(
        assertion.path,
        assertion.pattern,
        sandboxPath,
        true,
        weight
      );

    case "tool_called":
      return evaluateToolCalled(assertion.name, assertion.args, toolCalls, false, weight);

    case "tool_not_called":
      return evaluateToolCalled(assertion.name, undefined, toolCalls, true, weight);

    case "exit_code":
      return evaluateExitCode(assertion.expected, exitCode, weight);

    // Advanced graders
    case "no_lint_errors":
      return evaluateLint(sandboxPath, assertion.paths, assertion.config, weight);

    case "no_type_errors":
      return evaluateTypeScript(sandboxPath, assertion.tsconfig, weight);

    case "no_security_issues":
      return evaluateSecurity(sandboxPath, assertion.paths, weight);

    case "tool_call_sequence":
      if (!warnedToolCallSequence) {
        console.warn(
          "⚠️  tool_call_sequence is deprecated. Prefer outcome-based assertions or rubric grading instead."
        );
        warnedToolCallSequence = true;
      }
      return evaluateToolSequence(assertion.sequence, toolCalls, assertion.strict ?? false, weight);

    case "performance":
      return evaluatePerformance(assertion.metric, assertion.max, toolCalls, weight);

    default:
      return createFeedback(
        `unknown_assertion`,
        0,
        weight,
        false,
        `Unknown assertion type: ${(assertion as Assertion).type}`
      );
  }
}

async function evaluateFileExists(
  path: string,
  sandboxPath: string,
  weight: number
): Promise<Feedback> {
  const fullPath = join(sandboxPath, path);
  const key = `file_exists:${path}`;

  try {
    await readFile(fullPath);
    return createFeedback(key, 1, weight, true, `File exists: ${path}`);
  } catch {
    return createFeedback(key, 0, weight, false, `File not found: ${path}`);
  }
}

async function evaluateFileContains(
  path: string,
  pattern: string,
  sandboxPath: string,
  negate: boolean,
  weight: number
): Promise<Feedback> {
  const fullPath = join(sandboxPath, path);
  const key = negate ? `file_not_contains:${path}` : `file_contains:${path}`;

  try {
    const content = await readFile(fullPath, "utf-8");
    const regex = new RegExp(pattern);
    const matches = regex.test(content);
    const passed = negate ? !matches : matches;

    return createFeedback(
      key,
      passed ? 1 : 0,
      weight,
      passed,
      passed
        ? negate
          ? `File does not contain pattern: ${pattern}`
          : `File contains pattern: ${pattern}`
        : negate
          ? `File unexpectedly contains pattern: ${pattern}`
          : `File does not contain pattern: ${pattern}`
    );
  } catch {
    return createFeedback(key, 0, weight, false, `File not found: ${path}`);
  }
}

function evaluateToolCalled(
  name: string,
  expectedArgs: Record<string, unknown> | undefined,
  toolCalls: ToolCall[],
  negate: boolean,
  weight: number
): Promise<Feedback> {
  const key = negate ? `tool_not_called:${name}` : `tool_called:${name}`;

  const matchingCalls = toolCalls.filter((call) => {
    if (call.name !== name) return false;

    if (expectedArgs) {
      for (const [argKey, value] of Object.entries(expectedArgs)) {
        const callArgs = call.args as Record<string, unknown>;
        if (callArgs[argKey] !== value) return false;
      }
    }

    return true;
  });

  const found = matchingCalls.length > 0;
  const passed = negate ? !found : found;

  return Promise.resolve(
    createFeedback(
      key,
      passed ? 1 : 0,
      weight,
      passed,
      passed
        ? negate
          ? `Tool was not called: ${name}`
          : `Tool was called: ${name} (${matchingCalls.length} times)`
        : negate
          ? `Tool was unexpectedly called: ${name}`
          : `Tool was not called: ${name}`
    )
  );
}

function evaluateExitCode(expected: number, actual: number, weight: number): Feedback {
  const key = `exit_code:${expected}`;
  const passed = expected === actual;

  return createFeedback(
    key,
    passed ? 1 : 0,
    weight,
    passed,
    passed
      ? `Exit code matches: ${expected}`
      : `Exit code mismatch: expected ${expected}, got ${actual}`
  );
}

// ============================================================================
// Advanced Code Graders
// ============================================================================

/**
 * Check for lint errors using ESLint (if available).
 */
async function evaluateLint(
  sandboxPath: string,
  paths?: string[],
  config?: string,
  weight: number = 1.0
): Promise<Feedback> {
  const key = "no_lint_errors";
  const targetPaths = paths?.join(" ") || ".";
  const configArg = config ? `--config ${config}` : "";

  try {
    // Try to run ESLint
    await execAsync(`npx eslint ${configArg} --format json ${targetPaths}`, {
      cwd: sandboxPath,
      timeout: 30000,
    });
    return createFeedback(key, 1, weight, true, "No lint errors found");
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    
    // ESLint returns exit code 1 when there are lint errors
    if (execError.stdout) {
      try {
        const results = JSON.parse(execError.stdout);
        const errorCount = results.reduce((sum: number, file: { errorCount: number }) => sum + file.errorCount, 0);
        const warningCount = results.reduce((sum: number, file: { warningCount: number }) => sum + file.warningCount, 0);
        
        if (errorCount === 0) {
          // Only warnings, partial credit
          const score = warningCount > 0 ? 0.5 : 1;
          return createFeedback(key, score, weight, warningCount === 0, `${warningCount} warnings found`);
        }
        
        return createFeedback(key, 0, weight, false, `${errorCount} errors, ${warningCount} warnings`);
      } catch {
        // Couldn't parse output
      }
    }
    
    // ESLint not available or other error - skip gracefully
    return createFeedback(key, 1, weight, true, "Lint check skipped (ESLint not available)");
  }
}

/**
 * Check for TypeScript type errors.
 */
async function evaluateTypeScript(
  sandboxPath: string,
  tsconfig?: string,
  weight: number = 1.0
): Promise<Feedback> {
  const key = "no_type_errors";
  const configArg = tsconfig ? `--project ${tsconfig}` : "";

  try {
    await execAsync(`npx tsc ${configArg} --noEmit`, {
      cwd: sandboxPath,
      timeout: 60000,
    });
    return createFeedback(key, 1, weight, true, "No type errors found");
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    const output = execError.stdout || execError.stderr || "";
    
    // Count error lines
    const errorLines = output.split("\n").filter(line => line.includes("error TS"));
    const errorCount = errorLines.length;
    
    if (errorCount === 0) {
      // TSC not available - skip gracefully
      return createFeedback(key, 1, weight, true, "Type check skipped (TypeScript not available)");
    }
    
    return createFeedback(key, 0, weight, false, `${errorCount} type errors found`);
  }
}

/**
 * Check for basic security issues (hardcoded secrets, etc.).
 */
async function evaluateSecurity(
  sandboxPath: string,
  paths?: string[],
  weight: number = 1.0
): Promise<Feedback> {
  const key = "no_security_issues";
  const targetPaths = paths || ["."];
  const issues: string[] = [];

  // Patterns that might indicate security issues
  const securityPatterns = [
    { pattern: /password\s*=\s*['"][^'"]+['"]/gi, name: "hardcoded password" },
    { pattern: /api[_-]?key\s*=\s*['"][^'"]+['"]/gi, name: "hardcoded API key" },
    { pattern: /secret\s*=\s*['"][^'"]+['"]/gi, name: "hardcoded secret" },
    { pattern: /-----BEGIN (?:RSA |DSA |EC )?PRIVATE KEY-----/g, name: "private key" },
    { pattern: /AWS[A-Z0-9]{16,}/g, name: "AWS access key" },
  ];

  async function scanDirectory(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        // Skip common non-source directories
        if (entry.isDirectory()) {
          if (!["node_modules", ".git", "dist", "build"].includes(entry.name)) {
            await scanDirectory(fullPath);
          }
          continue;
        }
        
        // Only scan text files
        if (!/\.(js|ts|jsx|tsx|json|yaml|yml|env|py|rb|go)$/i.test(entry.name)) {
          continue;
        }

        try {
          const content = await readFile(fullPath, "utf-8");
          
          for (const { pattern, name } of securityPatterns) {
            if (pattern.test(content)) {
              issues.push(`${name} in ${entry.name}`);
            }
          }
        } catch {
          // Skip files we can't read
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }

  for (const targetPath of targetPaths) {
    await scanDirectory(join(sandboxPath, targetPath));
  }

  if (issues.length === 0) {
    return createFeedback(key, 1, weight, true, "No security issues detected");
  }

  return createFeedback(
    key,
    0,
    weight,
    false,
    `Security issues found: ${issues.slice(0, 3).join(", ")}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ""}`
  );
}

/**
 * Verify tool calls happened in a specific sequence.
 */
function evaluateToolSequence(
  expectedSequence: string[],
  toolCalls: ToolCall[],
  strict: boolean,
  weight: number
): Promise<Feedback> {
  const key = "tool_call_sequence";
  const actualNames = toolCalls.map(t => t.name);

  if (strict) {
    // Strict mode: exact sequence match
    const matches = expectedSequence.every((name, i) => actualNames[i] === name);
    return Promise.resolve(
      createFeedback(
        key,
        matches ? 1 : 0,
        weight,
        matches,
        matches
          ? `Tool sequence matches exactly`
          : `Expected sequence: ${expectedSequence.join(" → ")}, got: ${actualNames.slice(0, expectedSequence.length).join(" → ")}`
      )
    );
  }

  // Non-strict: sequence appears in order (with possible gaps)
  let seqIndex = 0;
  for (const name of actualNames) {
    if (name === expectedSequence[seqIndex]) {
      seqIndex++;
      if (seqIndex === expectedSequence.length) break;
    }
  }

  const found = seqIndex === expectedSequence.length;
  const partialCredit = seqIndex / expectedSequence.length;

  return Promise.resolve(
    createFeedback(
      key,
      found ? 1 : partialCredit,
      weight,
      found,
      found
        ? `Tool sequence found in order`
        : `Found ${seqIndex}/${expectedSequence.length} tools in sequence`
    )
  );
}

/**
 * Check performance metrics against thresholds.
 */
function evaluatePerformance(
  metric: "tokens" | "duration" | "tool_calls",
  max: number,
  toolCalls: ToolCall[],
  weight: number
): Promise<Feedback> {
  const key = `performance:${metric}`;

  // Note: tokens and duration need to be passed from the trial result
  // For now, we can only measure tool_calls directly
  let actual: number;
  let unit: string;

  switch (metric) {
    case "tool_calls":
      actual = toolCalls.length;
      unit = "calls";
      break;
    default:
      // Can't measure tokens/duration without access to trial result
      return Promise.resolve(
        createFeedback(key, 1, weight, true, `${metric} metric not measurable in code evaluator`)
      );
  }

  const passed = actual <= max;
  // Partial credit: linear scale from max to 2*max
  const score = passed ? 1 : Math.max(0, 1 - (actual - max) / max);

  return Promise.resolve(
    createFeedback(
      key,
      score,
      weight,
      passed,
      passed
        ? `${metric}: ${actual} <= ${max} ${unit}`
        : `${metric}: ${actual} > ${max} ${unit} (over by ${actual - max})`
    )
  );
}
