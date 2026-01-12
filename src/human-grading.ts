/**
 * Human grading workflow module.
 * Supports exporting tasks for human review, importing grades,
 * and calibrating LLM judges against human judgments.
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type {
  Experiment,
  ExampleResult,
  HumanReviewTask,
  HumanGradingCriteria,
  HumanReview,
  HumanGrade,
  InterRaterAgreement,
  JudgeCalibration,
  JudgeBias,
  EvaluatorConfig,
  RubricItem,
} from "./types.js";

// ============================================================================
// Export Tasks for Human Review
// ============================================================================

export interface ExportOptions {
  /** Output directory for review tasks */
  outputDir: string;
  /** Format for export (json or csv) */
  format: "json" | "csv";
  /** Include only failed examples */
  failedOnly?: boolean;
  /** Sample size (if less than total) */
  sampleSize?: number;
  /** Random seed for sampling */
  seed?: number;
  /** Assignee to pre-assign tasks to */
  assignee?: string;
}

/**
 * Export experiment results as human review tasks.
 */
export async function exportForHumanReview(
  experiments: Experiment[],
  options: ExportOptions
): Promise<{ tasks: HumanReviewTask[]; outputPath: string }> {
  const tasks: HumanReviewTask[] = [];

  for (const exp of experiments) {
    const criteria = extractCriteriaFromConfig(exp.config.evaluators);

    for (const result of exp.results) {
      // Skip passed examples if failedOnly is set
      if (options.failedOnly && result.passed) {
        continue;
      }

      // Create task for each trial or just the main result
      const trialsToExport =
        result.trials.length > 1 ? result.trials : [{ trial_number: 1 }];

      for (const trial of trialsToExport) {
        const task = createReviewTask(
          exp.eval_name,
          result,
          trial.trial_number,
          criteria,
          options.assignee
        );
        tasks.push(task);
      }
    }
  }

  // Sample if needed
  let finalTasks = tasks;
  if (options.sampleSize && options.sampleSize < tasks.length) {
    finalTasks = sampleTasks(tasks, options.sampleSize, options.seed);
  }

  // Ensure output directory exists
  await mkdir(options.outputDir, { recursive: true });

  // Write output
  const outputPath = join(
    options.outputDir,
    `review-tasks.${options.format}`
  );

  if (options.format === "json") {
    await writeFile(outputPath, JSON.stringify(finalTasks, null, 2));
  } else {
    const csv = tasksToCSV(finalTasks);
    await writeFile(outputPath, csv);
  }

  return { tasks: finalTasks, outputPath };
}

function createReviewTask(
  evalName: string,
  result: ExampleResult,
  trialNumber: number,
  criteria: HumanGradingCriteria[],
  assignee?: string
): HumanReviewTask {
  const trial = result.trials.find((t) => t.trial_number === trialNumber);
  const outputs = trial?.outputs ?? result.outputs;

  // Summarize tool calls
  const toolCallsSummary = outputs.tool_calls.map(
    (tc) => `${tc.name}(${JSON.stringify(tc.args).slice(0, 100)}...)`
  );

  // Get files changed
  const filesChanged = Object.keys(outputs.final_files);

  // Build response summary from events
  const response = summarizeResponse(outputs.events);

  return {
    id: `${evalName}-${result.example_id}-t${trialNumber}`,
    eval_name: evalName,
    example_id: result.example_id,
    trial_number: trialNumber,
    query: result.inputs.query,
    response,
    tool_calls_summary: toolCallsSummary,
    files_changed: filesChanged,
    criteria,
    status: "pending",
    assignee,
    created_at: new Date().toISOString(),
  };
}

function extractCriteriaFromConfig(
  evaluators: EvaluatorConfig[]
): HumanGradingCriteria[] {
  const criteria: HumanGradingCriteria[] = [];

  for (const evaluator of evaluators) {
    if (evaluator.type === "llm-judge") {
      // Convert rubric items to grading criteria
      if (evaluator.rubric) {
        for (const item of evaluator.rubric) {
          criteria.push(rubricToCriteria(item));
        }
      } else if (evaluator.criteria) {
        // Simple criteria become pass/fail questions
        for (const criterion of evaluator.criteria) {
          criteria.push({
            name: criterion.slice(0, 50),
            description: criterion,
            scale: { min: 0, max: 4 },
            anchors: {
              0: "Not addressed",
              1: "Poor",
              2: "Fair",
              3: "Good",
              4: "Excellent",
            },
          });
        }
      }
    }
  }

  // Add default criteria if none found
  if (criteria.length === 0) {
    criteria.push({
      name: "Overall Quality",
      description: "How well did the agent complete the task?",
      scale: { min: 0, max: 4 },
      anchors: {
        0: "Failed completely",
        1: "Major issues",
        2: "Partial success",
        3: "Mostly successful",
        4: "Complete success",
      },
    });
  }

  return criteria;
}

function rubricToCriteria(rubric: RubricItem): HumanGradingCriteria {
  const anchors: Record<number, string> = {};

  if (rubric.levels) {
    for (const level of rubric.levels) {
      anchors[level.score] = `${level.label}: ${level.description}`;
    }
  }

  return {
    name: rubric.name,
    description: rubric.description,
    scale: { min: 0, max: 4 },
    anchors,
  };
}

function summarizeResponse(events: unknown[]): string {
  // Extract text responses from events
  const textParts: string[] = [];

  for (const event of events) {
    const e = event as { type?: string; part?: { type?: string; text?: string } };
    if (e.part?.type === "text" && e.part.text) {
      textParts.push(e.part.text);
    }
  }

  const response = textParts.join("\n\n");
  // Truncate if too long
  if (response.length > 5000) {
    return response.slice(0, 5000) + "\n\n[Truncated...]";
  }
  return response;
}

function sampleTasks(
  tasks: HumanReviewTask[],
  size: number,
  seed?: number
): HumanReviewTask[] {
  // Simple Fisher-Yates shuffle with optional seed
  const shuffled = [...tasks];
  const random = seed ? seededRandom(seed) : Math.random;

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled.slice(0, size);
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function tasksToCSV(tasks: HumanReviewTask[]): string {
  const headers = [
    "id",
    "eval_name",
    "example_id",
    "trial_number",
    "query",
    "response",
    "tool_calls",
    "files_changed",
    "status",
    "assignee",
  ];

  const rows = tasks.map((task) => [
    task.id,
    task.eval_name,
    task.example_id,
    String(task.trial_number ?? 1),
    escapeCSV(task.query),
    escapeCSV(task.response),
    escapeCSV(task.tool_calls_summary.join("; ")),
    escapeCSV(task.files_changed.join("; ")),
    task.status,
    task.assignee ?? "",
  ]);

  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ============================================================================
// Import Human Reviews
// ============================================================================

/**
 * Import completed human reviews from file.
 */
export async function importHumanReviews(
  filePath: string
): Promise<HumanReview[]> {
  const content = await readFile(filePath, "utf-8");

  if (filePath.endsWith(".csv")) {
    return parseReviewsCSV(content);
  } else {
    return JSON.parse(content);
  }
}

function parseReviewsCSV(content: string): HumanReview[] {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(",");
  const reviews: HumanReview[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const review = csvRowToReview(headers, values);
    if (review) {
      reviews.push(review);
    }
  }

  return reviews;
}

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);

  return values;
}

function csvRowToReview(
  headers: string[],
  values: string[]
): HumanReview | null {
  const get = (key: string) => {
    const idx = headers.indexOf(key);
    return idx >= 0 ? values[idx] : undefined;
  };

  const taskId = get("task_id");
  const reviewer = get("reviewer");
  const passed = get("passed");

  if (!taskId || !reviewer) return null;

  // Parse grades from criterion_* columns
  const grades: HumanGrade[] = [];
  for (const header of headers) {
    if (header.startsWith("criterion_")) {
      const criterion = header.replace("criterion_", "");
      const scoreStr = get(header);
      if (scoreStr) {
        grades.push({
          criterion,
          score: parseFloat(scoreStr),
          comment: get(`comment_${criterion}`),
        });
      }
    }
  }

  return {
    task_id: taskId,
    reviewer,
    grades,
    passed: passed === "true" || passed === "1",
    notes: get("notes"),
    reviewed_at: get("reviewed_at") ?? new Date().toISOString(),
    total_time_s: get("time_spent_s") ? parseFloat(get("time_spent_s")!) : undefined,
  };
}

// ============================================================================
// Inter-Rater Agreement
// ============================================================================

/**
 * Calculate inter-rater agreement metrics from multiple reviews of the same tasks.
 */
export function calculateInterRaterAgreement(
  reviews: HumanReview[]
): InterRaterAgreement {
  // Group reviews by task_id
  const reviewsByTask = new Map<string, HumanReview[]>();
  for (const review of reviews) {
    const existing = reviewsByTask.get(review.task_id) ?? [];
    existing.push(review);
    reviewsByTask.set(review.task_id, existing);
  }

  // Only consider tasks with multiple reviews
  const overlappingTasks = Array.from(reviewsByTask.entries()).filter(
    ([, revs]) => revs.length >= 2
  );

  if (overlappingTasks.length === 0) {
    return {
      overlapping_examples: 0,
      cohens_kappa: 0,
      score_correlation: 0,
      avg_score_difference: 0,
      exact_match_rate: 0,
      per_criterion: {},
    };
  }

  // Calculate pass/fail agreement (Cohen's Kappa)
  const passFails: [boolean, boolean][] = [];
  for (const [, revs] of overlappingTasks) {
    // Compare first two reviewers
    passFails.push([revs[0].passed, revs[1].passed]);
  }
  const cohensKappa = calculateCohensKappa(passFails);

  // Calculate score correlation and differences
  const allScorePairs: [number, number][] = [];
  const perCriterionPairs = new Map<string, [number, number][]>();

  for (const [, revs] of overlappingTasks) {
    const r1 = revs[0];
    const r2 = revs[1];

    for (const g1 of r1.grades) {
      const g2 = r2.grades.find((g) => g.criterion === g1.criterion);
      if (g2) {
        allScorePairs.push([g1.score, g2.score]);

        const pairs = perCriterionPairs.get(g1.criterion) ?? [];
        pairs.push([g1.score, g2.score]);
        perCriterionPairs.set(g1.criterion, pairs);
      }
    }
  }

  const scoreCorrelation = calculatePearsonCorrelation(allScorePairs);
  const avgScoreDifference = calculateAvgDifference(allScorePairs);
  const exactMatchRate = calculateExactMatchRate(allScorePairs);

  // Per-criterion metrics
  const perCriterion: Record<string, { kappa: number; correlation: number }> = {};
  for (const [criterion, pairs] of perCriterionPairs) {
    const binaryPairs: [boolean, boolean][] = pairs.map(([a, b]) => [
      a >= 2.5,
      b >= 2.5,
    ]);
    perCriterion[criterion] = {
      kappa: calculateCohensKappa(binaryPairs),
      correlation: calculatePearsonCorrelation(pairs),
    };
  }

  return {
    overlapping_examples: overlappingTasks.length,
    cohens_kappa: cohensKappa,
    score_correlation: scoreCorrelation,
    avg_score_difference: avgScoreDifference,
    exact_match_rate: exactMatchRate,
    per_criterion: perCriterion,
  };
}

function calculateCohensKappa(pairs: [boolean, boolean][]): number {
  if (pairs.length === 0) return 0;

  let a = 0, b = 0, c = 0, d = 0;
  for (const [r1, r2] of pairs) {
    if (r1 && r2) a++;
    else if (r1 && !r2) b++;
    else if (!r1 && r2) c++;
    else d++;
  }

  const n = pairs.length;
  const po = (a + d) / n; // Observed agreement
  const pe = ((a + b) * (a + c) + (c + d) * (b + d)) / (n * n); // Expected agreement

  if (pe === 1) return 1;
  return (po - pe) / (1 - pe);
}

function calculatePearsonCorrelation(pairs: [number, number][]): number {
  if (pairs.length < 2) return 0;

  const n = pairs.length;
  const sumX = pairs.reduce((s, [x]) => s + x, 0);
  const sumY = pairs.reduce((s, [, y]) => s + y, 0);
  const sumXY = pairs.reduce((s, [x, y]) => s + x * y, 0);
  const sumX2 = pairs.reduce((s, [x]) => s + x * x, 0);
  const sumY2 = pairs.reduce((s, [, y]) => s + y * y, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  if (denominator === 0) return 0;
  return numerator / denominator;
}

function calculateAvgDifference(pairs: [number, number][]): number {
  if (pairs.length === 0) return 0;
  const diffs = pairs.map(([a, b]) => Math.abs(a - b));
  return diffs.reduce((s, d) => s + d, 0) / diffs.length;
}

function calculateExactMatchRate(pairs: [number, number][]): number {
  if (pairs.length === 0) return 0;
  const matches = pairs.filter(([a, b]) => a === b).length;
  return matches / pairs.length;
}

// ============================================================================
// LLM Judge Calibration
// ============================================================================

/**
 * Calibrate LLM judge against human reviews.
 */
export function calibrateLLMJudge(
  experiments: Experiment[],
  humanReviews: HumanReview[],
  judgeModel: string
): JudgeCalibration {
  // Map human reviews by task ID
  const humanByTask = new Map<string, HumanReview>();
  for (const review of humanReviews) {
    humanByTask.set(review.task_id, review);
  }

  // Collect pairs of LLM and human judgments
  const passPairs: [boolean, boolean][] = [];
  const scorePairs: [number, number][] = [];

  for (const exp of experiments) {
    for (const result of exp.results) {
      const taskId = `${exp.eval_name}-${result.example_id}-t1`;
      const humanReview = humanByTask.get(taskId);

      if (humanReview) {
        // Compare pass/fail
        passPairs.push([result.passed, humanReview.passed]);

        // Compare scores
        for (const feedback of result.feedback) {
          const humanGrade = humanReview.grades.find(
            (g) => g.criterion === feedback.key
          );
          if (humanGrade) {
            scorePairs.push([feedback.normalized_score * 4, humanGrade.score]);
          }
        }
      }
    }
  }

  if (passPairs.length === 0) {
    return {
      judge_model: judgeModel,
      calibration_examples: 0,
      agreement: {
        pass_fail_accuracy: 0,
        score_correlation: 0,
        avg_score_difference: 0,
      },
      biases: [],
      recommendations: ["No overlapping examples found. Export more tasks for human review."],
    };
  }

  // Calculate agreement metrics
  const passFailAccuracy =
    passPairs.filter(([a, b]) => a === b).length / passPairs.length;
  const scoreCorrelation = calculatePearsonCorrelation(scorePairs);
  const avgScoreDifference = calculateAvgDifference(scorePairs);

  // Detect biases
  const biases = detectBiases(passPairs, scorePairs);

  // Generate recommendations
  const recommendations = generateCalibrationRecommendations(
    passFailAccuracy,
    scoreCorrelation,
    avgScoreDifference,
    biases
  );

  return {
    judge_model: judgeModel,
    calibration_examples: passPairs.length,
    agreement: {
      pass_fail_accuracy: passFailAccuracy,
      score_correlation: scoreCorrelation,
      avg_score_difference: avgScoreDifference,
    },
    biases,
    recommendations,
  };
}

function detectBiases(
  passPairs: [boolean, boolean][],
  scorePairs: [number, number][]
): JudgeBias[] {
  const biases: JudgeBias[] = [];

  // Check for systematic leniency/harshness
  if (scorePairs.length >= 5) {
    const avgLLM = scorePairs.reduce((s, [a]) => s + a, 0) / scorePairs.length;
    const avgHuman = scorePairs.reduce((s, [, b]) => s + b, 0) / scorePairs.length;
    const diff = avgLLM - avgHuman;

    if (diff > 0.5) {
      biases.push({
        type: "lenient",
        description: `LLM judge scores ${diff.toFixed(2)} points higher than humans on average`,
        magnitude: diff,
      });
    } else if (diff < -0.5) {
      biases.push({
        type: "harsh",
        description: `LLM judge scores ${Math.abs(diff).toFixed(2)} points lower than humans on average`,
        magnitude: Math.abs(diff),
      });
    }
  }

  // Check for inconsistency (high variance in disagreement)
  if (scorePairs.length >= 10) {
    const diffs = scorePairs.map(([a, b]) => a - b);
    const meanDiff = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const variance =
      diffs.reduce((s, d) => s + Math.pow(d - meanDiff, 2), 0) / diffs.length;

    if (variance > 1.5) {
      biases.push({
        type: "inconsistent",
        description: `High variance in score differences (${variance.toFixed(2)}) suggests inconsistent judging`,
        magnitude: variance,
      });
    }
  }

  return biases;
}

function generateCalibrationRecommendations(
  passFailAccuracy: number,
  scoreCorrelation: number,
  avgScoreDifference: number,
  biases: JudgeBias[]
): string[] {
  const recommendations: string[] = [];

  if (passFailAccuracy < 0.8) {
    recommendations.push(
      "Pass/fail accuracy is below 80%. Consider adjusting the pass threshold or refining criteria."
    );
  }

  if (scoreCorrelation < 0.7) {
    recommendations.push(
      "Score correlation is below 0.7. The LLM judge may need more detailed rubric definitions."
    );
  }

  if (avgScoreDifference > 1) {
    recommendations.push(
      "Average score difference exceeds 1 point. Consider recalibrating the scoring scale."
    );
  }

  for (const bias of biases) {
    if (bias.type === "lenient") {
      recommendations.push(
        "LLM judge is systematically lenient. Add examples of failures to the prompt or tighten criteria."
      );
    } else if (bias.type === "harsh") {
      recommendations.push(
        "LLM judge is systematically harsh. Add examples of acceptable outputs to the prompt."
      );
    } else if (bias.type === "inconsistent") {
      recommendations.push(
        "LLM judge is inconsistent. Provide more explicit scoring examples in the rubric."
      );
    }
  }

  if (recommendations.length === 0) {
    recommendations.push(
      "LLM judge is well-calibrated with human reviewers. Continue monitoring over time."
    );
  }

  return recommendations;
}

// ============================================================================
// Format Reports
// ============================================================================

/**
 * Format inter-rater agreement as markdown.
 */
export function formatAgreementReport(agreement: InterRaterAgreement): string {
  const lines: string[] = [];

  lines.push("# Inter-Rater Agreement Report");
  lines.push("");
  lines.push(`Overlapping examples: ${agreement.overlapping_examples}`);
  lines.push("");

  lines.push("## Overall Metrics");
  lines.push("");
  lines.push(`| Metric | Value | Interpretation |`);
  lines.push(`|--------|-------|----------------|`);
  lines.push(
    `| Cohen's Kappa | ${agreement.cohens_kappa.toFixed(3)} | ${interpretKappa(agreement.cohens_kappa)} |`
  );
  lines.push(
    `| Score Correlation | ${agreement.score_correlation.toFixed(3)} | ${interpretCorrelation(agreement.score_correlation)} |`
  );
  lines.push(
    `| Avg Score Difference | ${agreement.avg_score_difference.toFixed(2)} | ${agreement.avg_score_difference < 0.5 ? "Good" : "Needs attention"} |`
  );
  lines.push(
    `| Exact Match Rate | ${(agreement.exact_match_rate * 100).toFixed(1)}% | - |`
  );
  lines.push("");

  if (Object.keys(agreement.per_criterion).length > 0) {
    lines.push("## Per-Criterion Agreement");
    lines.push("");
    lines.push(`| Criterion | Kappa | Correlation |`);
    lines.push(`|-----------|-------|-------------|`);
    for (const [criterion, metrics] of Object.entries(agreement.per_criterion)) {
      lines.push(
        `| ${criterion} | ${metrics.kappa.toFixed(3)} | ${metrics.correlation.toFixed(3)} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function interpretKappa(kappa: number): string {
  if (kappa < 0) return "Poor (less than chance)";
  if (kappa < 0.2) return "Slight";
  if (kappa < 0.4) return "Fair";
  if (kappa < 0.6) return "Moderate";
  if (kappa < 0.8) return "Substantial";
  return "Almost perfect";
}

function interpretCorrelation(r: number): string {
  const abs = Math.abs(r);
  if (abs < 0.3) return "Weak";
  if (abs < 0.5) return "Moderate";
  if (abs < 0.7) return "Strong";
  return "Very strong";
}

/**
 * Format judge calibration as markdown.
 */
export function formatCalibrationReport(calibration: JudgeCalibration): string {
  const lines: string[] = [];

  lines.push(`# LLM Judge Calibration Report`);
  lines.push("");
  lines.push(`Judge Model: ${calibration.judge_model}`);
  lines.push(`Calibration Examples: ${calibration.calibration_examples}`);
  lines.push("");

  lines.push("## Agreement with Human Reviewers");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(
    `| Pass/Fail Accuracy | ${(calibration.agreement.pass_fail_accuracy * 100).toFixed(1)}% |`
  );
  lines.push(
    `| Score Correlation | ${calibration.agreement.score_correlation.toFixed(3)} |`
  );
  lines.push(
    `| Avg Score Difference | ${calibration.agreement.avg_score_difference.toFixed(2)} |`
  );
  lines.push("");

  if (calibration.biases.length > 0) {
    lines.push("## Detected Biases");
    lines.push("");
    for (const bias of calibration.biases) {
      lines.push(`- **${bias.type}**: ${bias.description}`);
    }
    lines.push("");
  }

  lines.push("## Recommendations");
  lines.push("");
  for (const rec of calibration.recommendations) {
    lines.push(`- ${rec}`);
  }
  lines.push("");

  return lines.join("\n");
}
