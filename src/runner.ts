import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  EvalConfig,
  Dataset,
  Example,
  Experiment,
  ExampleResult,
  ExperimentSummary,
  Feedback,
  RunOptions,
} from "./types.js";
import { createSandbox, readDirectoryFiles, getFixturesDir } from "./sandbox.js";
import { runOpenCode } from "./capture.js";
import { runCodeEvaluator, runLLMJudge } from "./evaluators/index.js";

/**
 * Run an eval configuration and return experiment results.
 */
export async function runEval(
  evalPath: string,
  options: RunOptions = {}
): Promise<Experiment[]> {
  // Load eval config
  const configText = await readFile(evalPath, "utf-8");
  const config: EvalConfig = JSON.parse(configText);

  // Load dataset
  const dataset = await loadDataset(config.dataset, dirname(evalPath));

  // Determine which variants to run
  const variantNames = options.variant
    ? [options.variant]
    : Object.keys(config.variants);

  const experiments: Experiment[] = [];

  for (const variantName of variantNames) {
    const variantConfig = config.variants[variantName];
    if (!variantConfig) {
      throw new Error(`Variant not found: ${variantName}`);
    }

    console.log(`\n📊 Running variant: ${variantName}`);

    const results: ExampleResult[] = [];

    for (const example of dataset.examples) {
      console.log(`  🔄 Example: ${example.id}`);

      if (options.dryRun) {
        console.log(`    ⏭️  Skipped (dry run)`);
        continue;
      }

      try {
        const result = await runExample(
          example,
          variantName,
          variantConfig,
          config,
          options
        );
        results.push(result);

        const status = result.passed ? "✅" : "❌";
        console.log(`    ${status} ${result.passed ? "Passed" : "Failed"}`);
      } catch (error) {
        console.error(`    ❌ Error: ${error}`);

        // Handle based on error_handling config
        const errorHandling = config.error_handling?.on_error ?? "continue";

        if (errorHandling === "abort") {
          throw error;
        }

        // Create failed result
        results.push({
          example_id: example.id,
          inputs: example.inputs,
          outputs: {
            events: [],
            final_files: {},
            tool_calls: [],
            exit_code: -1,
            tokens_used: 0,
            cost: 0,
            duration_ms: 0,
          },
          feedback: [
            {
              key: "error",
              score: 0,
              passed: false,
              comment: String(error),
            },
          ],
          passed: false,
        });
      }
    }

    const summary = calculateSummary(results);

    experiments.push({
      id: `${config.name}-${variantName}-${Date.now()}`,
      eval_name: config.name,
      variant: variantName,
      timestamp: new Date().toISOString(),
      config,
      results,
      summary,
    });

    console.log(
      `\n  📈 Summary: ${summary.passed}/${summary.total_examples} passed (${(summary.pass_rate * 100).toFixed(1)}%)`
    );
  }

  return experiments;
}

async function loadDataset(
  datasetRef: string | Dataset,
  basePath: string
): Promise<Dataset> {
  if (typeof datasetRef === "object") {
    return datasetRef;
  }

  // Load from file
  const datasetPath = join(basePath, datasetRef);
  const text = await readFile(datasetPath, "utf-8");
  return JSON.parse(text);
}

async function runExample(
  example: Example,
  variantName: string,
  variantConfig: EvalConfig["variants"][string],
  config: EvalConfig,
  options: RunOptions
): Promise<ExampleResult> {
  // Merge example files with setup files
  const setupWithFiles: EvalConfig["setup"] = {
    ...config.setup,
    files: {
      ...config.setup?.files,
      ...example.inputs.files,
    },
  };

  // Create sandbox
  const sandbox = await createSandbox(
    setupWithFiles,
    variantName,
    getFixturesDir()
  );

  try {
    // Run OpenCode
    const captureResult = await runOpenCode(example.inputs.query, sandbox.path, {
      plugins: variantConfig.plugins,
      model: variantConfig.model,
      agent: variantConfig.agent,
      env: variantConfig.env,
      timeout_ms: config.error_handling?.timeout_ms,
    });

    // Read final file state
    const final_files = await readDirectoryFiles(sandbox.path);

    // Run evaluators
    const feedback: Feedback[] = [];

    for (const evaluator of config.evaluators) {
      if (evaluator.type === "code" && evaluator.assertions) {
        const codeResults = await runCodeEvaluator(
          evaluator.assertions,
          sandbox.path,
          captureResult.tool_calls,
          captureResult.exit_code
        );
        feedback.push(...codeResults);
      }

      if (evaluator.type === "llm-judge" && evaluator.criteria) {
        const judgeResults = await runLLMJudge(
          {
            criteria: evaluator.criteria,
            reference_free: evaluator.reference_free,
            model: config.judge_model,
          },
          example.inputs.query,
          captureResult.tool_calls,
          final_files,
          example.reference_outputs
        );
        feedback.push(...judgeResults);
      }
    }

    const passed = feedback.every((f) => f.passed);

    return {
      example_id: example.id,
      inputs: example.inputs,
      outputs: {
        events: captureResult.events,
        final_files,
        tool_calls: captureResult.tool_calls,
        exit_code: captureResult.exit_code,
        tokens_used: captureResult.tokens_used,
        cost: captureResult.cost,
        duration_ms: captureResult.duration_ms,
      },
      feedback,
      passed,
    };
  } finally {
    await sandbox.cleanup();
  }
}

function calculateSummary(results: ExampleResult[]): ExperimentSummary {
  const total_examples = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total_examples - passed;

  const allFeedback = results.flatMap((r) => r.feedback);
  const avg_score =
    allFeedback.length > 0
      ? allFeedback.reduce((sum, f) => sum + f.score, 0) / allFeedback.length
      : 0;

  const total_tokens = results.reduce((sum, r) => sum + r.outputs.tokens_used, 0);
  const total_cost = results.reduce((sum, r) => sum + r.outputs.cost, 0);
  const total_duration_ms = results.reduce(
    (sum, r) => sum + r.outputs.duration_ms,
    0
  );

  return {
    total_examples,
    passed,
    failed,
    pass_rate: total_examples > 0 ? passed / total_examples : 0,
    avg_score,
    total_tokens,
    total_cost,
    total_duration_ms,
  };
}
