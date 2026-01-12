import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Dataset, EvalConfig, Example, Feedback, ToolCall } from "./types.js";
import { createSandbox, readDirectoryFiles, getFixturesDir } from "./sandbox.js";
import { runCodeEvaluator } from "./evaluators/code.js";
import { runLLMJudge } from "./evaluators/llm-judge.js";

export interface ReferenceValidationOptions {
  include_llm?: boolean;
  verbose?: boolean;
}

export interface ReferenceValidationSummary {
  eval_path: string;
  total_examples: number;
  reference_examples: number;
  failed_references: number;
  skipped_examples: number;
  skipped_llm: boolean;
}

export async function validateReferences(
  evalPath: string,
  options: ReferenceValidationOptions = {}
): Promise<ReferenceValidationSummary> {
  const configText = await readFile(evalPath, "utf-8");
  const config: EvalConfig = JSON.parse(configText);
  const dataset = await loadDataset(config.dataset, dirname(evalPath));
  const variantNames = Object.keys(config.variants);

  let referenceExamples = 0;
  let failedReferences = 0;
  let skippedExamples = 0;
  let skippedLLM = false;

  for (const variantName of variantNames) {
    for (const example of dataset.examples) {
      if (!example.reference_outputs) {
        skippedExamples++;
        continue;
      }

      referenceExamples++;

      const result = await evaluateReferenceExample(
        example,
        config,
        variantName,
        options.include_llm ?? false
      );

      if (result.skipped_llm) {
        skippedLLM = true;
      }

      if (!result.passed) {
        failedReferences++;
        const header = `  ❌ ${example.id} (${variantName})`;
        console.log(header);
        for (const issue of result.failed_feedback) {
          console.log(`     - ${issue.key}: ${issue.comment ?? "failed"}`);
        }
      } else if (options.verbose) {
        console.log(`  ✅ ${example.id} (${variantName})`);
      }
    }
  }

  return {
    eval_path: evalPath,
    total_examples: dataset.examples.length * Math.max(variantNames.length, 1),
    reference_examples: referenceExamples,
    failed_references: failedReferences,
    skipped_examples: skippedExamples,
    skipped_llm: skippedLLM,
  };
}

async function loadDataset(
  datasetRef: string | Dataset,
  basePath: string
): Promise<Dataset> {
  if (typeof datasetRef === "object") {
    return datasetRef;
  }

  const datasetPath = join(basePath, datasetRef);
  const text = await readFile(datasetPath, "utf-8");
  return JSON.parse(text);
}

async function evaluateReferenceExample(
  example: Example,
  config: EvalConfig,
  variantName: string,
  includeLlm: boolean
): Promise<{ passed: boolean; failed_feedback: Feedback[]; skipped_llm: boolean }> {
  const setupWithFiles: EvalConfig["setup"] = {
    ...config.setup,
    files: {
      ...config.setup?.files,
      ...example.inputs.files,
    },
  };

  const sandbox = await createSandbox(
    setupWithFiles,
    variantName,
    getFixturesDir()
  );

  let skippedLLM = false;

  try {
    if (example.reference_outputs?.files) {
      await writeReferenceFiles(sandbox.path, example.reference_outputs.files);
    }

    const finalFiles = await readDirectoryFiles(sandbox.path);
    const toolCalls = buildToolCalls(example.reference_outputs?.tool_calls ?? []);
    const exitCode = 0;

    const feedback: Feedback[] = [];

    for (const evaluator of config.evaluators) {
      if (evaluator.type === "code" && evaluator.assertions) {
        const codeResults = await runCodeEvaluator(
          evaluator.assertions,
          sandbox.path,
          toolCalls,
          exitCode
        );
        feedback.push(...codeResults);
      }

      if (evaluator.type === "llm-judge") {
        if (!includeLlm) {
          skippedLLM = true;
          continue;
        }

        const judgeResults = await runLLMJudge(
          {
            criteria: evaluator.criteria,
            rubric: evaluator.rubric,
            reference_free: evaluator.reference_free,
            model: config.judge_model,
          },
          example.inputs.query,
          toolCalls,
          finalFiles,
          example.reference_outputs
        );
        feedback.push(...judgeResults);
      }
    }

    const failedFeedback = feedback.filter((item) => !item.passed);

    return {
      passed: failedFeedback.length === 0,
      failed_feedback: failedFeedback,
      skipped_llm: skippedLLM,
    };
  } finally {
    await sandbox.cleanup();
  }
}

async function writeReferenceFiles(
  sandboxPath: string,
  files: Record<string, string>
): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(sandboxPath, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
}

function buildToolCalls(toolCalls: string[]): ToolCall[] {
  return toolCalls.map((name, index) => ({
    name,
    callID: `reference-${index + 1}`,
    args: {},
    output: null,
    timestamp: 0,
    duration_ms: 0,
  }));
}
