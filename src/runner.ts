import { readFile, writeFile, mkdir } from "node:fs/promises";
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
  TrialResult,
  TrialMetrics,
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

    const numTrials = options.trials ?? config.trials ?? 1;
    const passCriteria = options.pass_criteria ?? 'any';

    for (const example of dataset.examples) {
      console.log(`  🔄 Example: ${example.id}${numTrials > 1 ? ` (${numTrials} trials)` : ''}`);

      if (options.dryRun) {
        console.log(`    ⏭️  Skipped (dry run)`);
        continue;
      }

      try {
        const result = await runExampleWithTrials(
          example,
          variantName,
          variantConfig,
          config,
          options,
          numTrials,
          passCriteria
        );
        results.push(result);

        const status = result.passed ? "✅" : "❌";
        const trialInfo = numTrials > 1 ? ` (${result.trials_passed}/${result.trials_total} trials)` : '';
        console.log(`    ${status} ${result.passed ? "Passed" : "Failed"}${trialInfo}`);
      } catch (error) {
        console.error(`    ❌ Error: ${error}`);

        // Handle based on error_handling config
        const errorHandling = config.error_handling?.on_error ?? "continue";

        if (errorHandling === "abort") {
          throw error;
        }

        // Create failed result with empty trials
        const emptyTrial: TrialResult = {
          trial_number: 1,
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
              normalized_score: 0,
              weight: 1,
              weighted_score: 0,
              passed: false,
              comment: String(error),
            },
          ],
          passed: false,
        };

        results.push({
          example_id: example.id,
          inputs: example.inputs,
          trials: [emptyTrial],
          outputs: emptyTrial.outputs,
          feedback: emptyTrial.feedback,
          passed: false,
          trials_passed: 0,
          trials_total: 1,
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

/**
 * Run an example with multiple trials, aggregating results.
 */
async function runExampleWithTrials(
  example: Example,
  variantName: string,
  variantConfig: EvalConfig["variants"][string],
  config: EvalConfig,
  options: RunOptions,
  numTrials: number,
  passCriteria: 'any' | 'all'
): Promise<ExampleResult> {
  const trials: TrialResult[] = [];

  for (let trialNum = 1; trialNum <= numTrials; trialNum++) {
    if (numTrials > 1 && options.verbose) {
      console.log(`      Trial ${trialNum}/${numTrials}...`);
    }

    const trialResult = await runSingleTrial(
      example,
      variantName,
      variantConfig,
      config,
      options,
      trialNum
    );

    // Save transcript if enabled
    if (config.save_transcripts) {
      const transcriptPath = await saveTranscript(
        config,
        variantName,
        example.id,
        trialNum,
        trialResult
      );
      trialResult.transcript_path = transcriptPath;
    }

    trials.push(trialResult);
  }

  // Aggregate results
  const trials_passed = trials.filter(t => t.passed).length;
  const trials_total = trials.length;

  // Determine overall pass based on criteria
  const passed = passCriteria === 'any'
    ? trials_passed > 0  // pass@k: at least one passed
    : trials_passed === trials_total;  // pass^k: all passed

  // Use first trial's outputs for backward compatibility
  // (or the first passing trial if any passed)
  const representativeTrial = trials.find(t => t.passed) ?? trials[0];

  // Aggregate feedback across all trials
  const aggregatedFeedback = aggregateTrialFeedback(trials);

  return {
    example_id: example.id,
    inputs: example.inputs,
    trials,
    outputs: representativeTrial.outputs,
    feedback: aggregatedFeedback,
    passed,
    trials_passed,
    trials_total,
  };
}

/**
 * Run a single trial of an example.
 */
async function runSingleTrial(
  example: Example,
  variantName: string,
  variantConfig: EvalConfig["variants"][string],
  config: EvalConfig,
  options: RunOptions,
  trialNumber: number
): Promise<TrialResult> {
  // Merge example files with setup files
  const setupWithFiles: EvalConfig["setup"] = {
    ...config.setup,
    files: {
      ...config.setup?.files,
      ...example.inputs.files,
    },
  };

  // Create sandbox (fresh for each trial to ensure isolation)
  const sandbox = await createSandbox(
    setupWithFiles,
    `${variantName}-trial${trialNumber}`,
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
      trial_number: trialNumber,
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

/**
 * Save transcript to file for later analysis.
 */
async function saveTranscript(
  config: EvalConfig,
  variantName: string,
  exampleId: string,
  trialNumber: number,
  trial: TrialResult
): Promise<string> {
  const transcriptDir = config.transcript_dir ?? '.evals/transcripts';
  const dir = join(transcriptDir, config.name, variantName);
  
  await mkdir(dir, { recursive: true });

  const filename = `${exampleId}-trial${trialNumber}.jsonl`;
  const filepath = join(dir, filename);

  // Write events as JSONL
  const lines = trial.outputs.events.map(e => JSON.stringify(e)).join('\n');
  await writeFile(filepath, lines + '\n');

  return filepath;
}

/**
 * Aggregate feedback from multiple trials.
 * Returns averaged scores with min/max annotations.
 */
function aggregateTrialFeedback(trials: TrialResult[]): Feedback[] {
  if (trials.length === 0) return [];
  if (trials.length === 1) return trials[0].feedback;

  // Group feedback by key
  const feedbackByKey = new Map<string, Feedback[]>();
  for (const trial of trials) {
    for (const fb of trial.feedback) {
      const existing = feedbackByKey.get(fb.key) ?? [];
      existing.push(fb);
      feedbackByKey.set(fb.key, existing);
    }
  }

  // Aggregate each key
  const aggregated: Feedback[] = [];
  for (const [key, feedbacks] of feedbackByKey) {
    const scores = feedbacks.map(f => f.normalized_score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const passCount = feedbacks.filter(f => f.passed).length;
    const avgWeight = feedbacks.reduce((sum, f) => sum + f.weight, 0) / feedbacks.length;

    aggregated.push({
      key,
      score: avgScore,
      normalized_score: avgScore,
      weight: avgWeight,
      weighted_score: avgScore * avgWeight,
      passed: passCount > 0, // Pass if any trial passed this criterion
      comment: trials.length > 1
        ? `Avg: ${avgScore.toFixed(2)} (${passCount}/${feedbacks.length} passed, range: ${minScore.toFixed(2)}-${maxScore.toFixed(2)})`
        : feedbacks[0].comment,
    });
  }

  return aggregated;
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

  // Sum tokens/cost/duration across ALL trials
  const total_tokens = results.reduce(
    (sum, r) => sum + r.trials.reduce((ts, t) => ts + t.outputs.tokens_used, 0),
    0
  );
  const total_cost = results.reduce(
    (sum, r) => sum + r.trials.reduce((ts, t) => ts + t.outputs.cost, 0),
    0
  );
  const total_duration_ms = results.reduce(
    (sum, r) => sum + r.trials.reduce((ts, t) => ts + t.outputs.duration_ms, 0),
    0
  );

  // Calculate trial metrics if we have multi-trial results
  const hasMultipleTrials = results.some(r => r.trials_total > 1);
  const trial_metrics = hasMultipleTrials
    ? calculateTrialMetrics(results)
    : undefined;

  return {
    total_examples,
    passed,
    failed,
    pass_rate: total_examples > 0 ? passed / total_examples : 0,
    avg_score,
    total_tokens,
    total_cost,
    total_duration_ms,
    trial_metrics,
  };
}

/**
 * Calculate multi-trial metrics: pass@k, pass^k, consistency, etc.
 */
function calculateTrialMetrics(results: ExampleResult[]): TrialMetrics {
  if (results.length === 0) {
    return {
      trials_per_example: 0,
      pass_at_k: 0,
      pass_all_k: 0,
      avg_trial_pass_rate: 0,
      pass_rate_std_dev: 0,
      inconsistent_examples: 0,
      consistency_rate: 0,
    };
  }

  const trials_per_example = results[0].trials_total;

  // pass@k: fraction where at least 1 trial passed
  const pass_at_k = results.filter(r => r.trials_passed > 0).length / results.length;

  // pass^k: fraction where ALL trials passed
  const pass_all_k = results.filter(r => r.trials_passed === r.trials_total).length / results.length;

  // Per-example pass rates
  const passRates = results.map(r => r.trials_passed / r.trials_total);
  const avg_trial_pass_rate = passRates.reduce((a, b) => a + b, 0) / passRates.length;

  // Standard deviation of pass rates
  const variance = passRates.reduce(
    (sum, rate) => sum + Math.pow(rate - avg_trial_pass_rate, 2),
    0
  ) / passRates.length;
  const pass_rate_std_dev = Math.sqrt(variance);

  // Inconsistent examples: some trials pass, some fail (not all same result)
  const inconsistent_examples = results.filter(
    r => r.trials_passed > 0 && r.trials_passed < r.trials_total
  ).length;

  const consistency_rate = 1 - (inconsistent_examples / results.length);

  return {
    trials_per_example,
    pass_at_k,
    pass_all_k,
    avg_trial_pass_rate,
    pass_rate_std_dev,
    inconsistent_examples,
    consistency_rate,
  };
}
