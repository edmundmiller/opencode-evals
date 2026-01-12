/**
 * Eval analysis and maintenance tooling.
 * Based on Anthropic's best practices for eval health monitoring.
 */

import type {
  Experiment,
  ExampleResult,
  SaturationWarning,
  EvalHealthReport,
  DifficultyScore,
  GraderValidation,
  GraderIssue,
  Feedback,
} from "./types.js";

// ============================================================================
// Saturation Detection
// ============================================================================

/**
 * Thresholds for saturation detection.
 */
export interface SaturationThresholds {
  /** Pass rate above which to warn (default: 0.95) */
  high_pass_rate: number;
  /** Variance below which to warn (default: 0.05) */
  low_variance: number;
  /** Minimum examples needed for reliable analysis (default: 10) */
  min_examples: number;
}

const DEFAULT_THRESHOLDS: SaturationThresholds = {
  high_pass_rate: 0.95,
  low_variance: 0.05,
  min_examples: 10,
};

/**
 * Analyze an experiment for saturation warnings.
 * Saturation occurs when evals become too easy and no longer discriminate.
 */
export function detectSaturation(
  experiment: Experiment,
  thresholds: Partial<SaturationThresholds> = {}
): SaturationWarning[] {
  const config = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const warnings: SaturationWarning[] = [];

  const { results, summary } = experiment;

  // Check for high pass rate
  if (summary.pass_rate >= config.high_pass_rate) {
    warnings.push({
      type: "high_pass_rate",
      message: `Pass rate of ${(summary.pass_rate * 100).toFixed(1)}% exceeds threshold of ${(config.high_pass_rate * 100).toFixed(0)}%`,
      metric: "pass_rate",
      value: summary.pass_rate,
      threshold: config.high_pass_rate,
      recommendation:
        "Consider adding harder examples or more stringent evaluation criteria. " +
        "High pass rates may indicate the eval is no longer discriminating between good and bad outputs.",
    });
  }

  // Check for low score variance (all examples getting similar scores)
  if (results.length >= config.min_examples) {
    const scores = results.flatMap(r => r.feedback.map(f => f.normalized_score));
    if (scores.length > 0) {
      const variance = calculateVariance(scores);
      if (variance < config.low_variance) {
        warnings.push({
          type: "low_variance",
          message: `Score variance of ${variance.toFixed(4)} is below threshold of ${config.low_variance}`,
          metric: "score_variance",
          value: variance,
          threshold: config.low_variance,
          recommendation:
            "Low variance suggests examples are too similar in difficulty. " +
            "Consider adding examples with varying complexity levels.",
        });
      }
    }
  }

  // Check for non-discriminating examples (all pass or all fail)
  const allPass = results.filter(r => r.passed).length === results.length;
  const allFail = results.filter(r => !r.passed).length === results.length;

  if (results.length >= config.min_examples && (allPass || allFail)) {
    warnings.push({
      type: "non_discriminating",
      message: allPass
        ? "All examples passed - eval may be too easy"
        : "All examples failed - eval may be too hard or broken",
      metric: "discrimination",
      value: allPass ? 1 : 0,
      threshold: 0.5,
      recommendation: allPass
        ? "Add harder examples or more stringent grading criteria."
        : "Check if grading criteria are correct. Consider adding easier examples to validate the eval works.",
    });
  }

  return warnings;
}

// ============================================================================
// Difficulty Scoring
// ============================================================================

/**
 * Calculate difficulty scores for each example based on historical results.
 */
export function calculateDifficultyScores(
  experiments: Experiment[]
): Record<string, DifficultyScore> {
  // Group results by example_id across all experiments
  const resultsByExample = new Map<string, ExampleResult[]>();

  for (const exp of experiments) {
    for (const result of exp.results) {
      const existing = resultsByExample.get(result.example_id) ?? [];
      existing.push(result);
      resultsByExample.set(result.example_id, existing);
    }
  }

  const scores: Record<string, DifficultyScore> = {};

  for (const [exampleId, results] of resultsByExample) {
    const passCount = results.filter(r => r.passed).length;
    const pass_rate = passCount / results.length;

    const allScores = results.flatMap(r =>
      r.feedback.map(f => f.normalized_score)
    );
    const avg_score =
      allScores.length > 0
        ? allScores.reduce((a, b) => a + b, 0) / allScores.length
        : 0;
    const score_variance = calculateVariance(allScores);

    // Determine difficulty label based on pass rate
    let difficulty: DifficultyScore["difficulty"];
    if (pass_rate >= 0.9) {
      difficulty = "easy";
    } else if (pass_rate >= 0.6) {
      difficulty = "medium";
    } else if (pass_rate >= 0.3) {
      difficulty = "hard";
    } else {
      difficulty = "very_hard";
    }

    // An example is discriminating if it has meaningful variance
    // (some runs pass, some fail)
    const is_discriminating = pass_rate > 0.1 && pass_rate < 0.9;

    scores[exampleId] = {
      example_id: exampleId,
      pass_rate,
      avg_score,
      score_variance,
      difficulty,
      is_discriminating,
    };
  }

  return scores;
}

// ============================================================================
// Grader Validation
// ============================================================================

/**
 * Validate graders by checking for common issues.
 */
export function validateGraders(experiments: Experiment[]): GraderValidation {
  // Group feedback by grader key across all experiments
  const feedbackByGrader = new Map<string, Feedback[]>();

  for (const exp of experiments) {
    for (const result of exp.results) {
      for (const fb of result.feedback) {
        const existing = feedbackByGrader.get(fb.key) ?? [];
        existing.push(fb);
        feedbackByGrader.set(fb.key, existing);
      }
    }
  }

  const issues: GraderIssue[] = [];
  let validGraders = 0;

  for (const [graderKey, feedbacks] of feedbackByGrader) {
    const hasIssue = checkGraderIssues(graderKey, feedbacks, issues);
    if (!hasIssue) {
      validGraders++;
    }
  }

  return {
    total_graders: feedbackByGrader.size,
    valid_graders: validGraders,
    issues,
  };
}

function checkGraderIssues(
  graderKey: string,
  feedbacks: Feedback[],
  issues: GraderIssue[]
): boolean {
  if (feedbacks.length < 3) {
    // Not enough data to validate
    return false;
  }

  const passCount = feedbacks.filter(f => f.passed).length;
  const passRate = passCount / feedbacks.length;

  // Check if grader always passes
  if (passRate === 1) {
    issues.push({
      grader_key: graderKey,
      type: "always_passes",
      message: `Grader '${graderKey}' passed all ${feedbacks.length} examples`,
      suggestion:
        "This grader may be too lenient. Consider tightening criteria or adding edge cases that should fail.",
    });
    return true;
  }

  // Check if grader always fails
  if (passRate === 0) {
    issues.push({
      grader_key: graderKey,
      type: "always_fails",
      message: `Grader '${graderKey}' failed all ${feedbacks.length} examples`,
      suggestion:
        "This grader may be broken or too strict. Verify the grading logic and consider adding examples that should pass.",
    });
    return true;
  }

  // Check for low variance in scores
  const scores = feedbacks.map(f => f.normalized_score);
  const variance = calculateVariance(scores);

  if (variance < 0.01 && passRate > 0 && passRate < 1) {
    issues.push({
      grader_key: graderKey,
      type: "low_variance",
      message: `Grader '${graderKey}' has very low score variance (${variance.toFixed(4)})`,
      suggestion:
        "Consider using more granular scoring levels. The grader may be too binary.",
    });
    return true;
  }

  // Check for inconsistent scoring (high variance with similar pass/fail)
  if (variance > 0.3) {
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const expectedPassRate = avgScore; // If scoring is consistent, these should correlate

    if (Math.abs(passRate - expectedPassRate) > 0.3) {
      issues.push({
        grader_key: graderKey,
        type: "inconsistent",
        message: `Grader '${graderKey}' shows inconsistent scoring (variance: ${variance.toFixed(2)}, pass rate: ${(passRate * 100).toFixed(0)}%, avg score: ${(avgScore * 100).toFixed(0)}%)`,
        suggestion:
          "Review the pass threshold logic. Scores and pass/fail decisions may not be aligned.",
      });
      return true;
    }
  }

  return false;
}

// ============================================================================
// Health Report Generation
// ============================================================================

/**
 * Generate a comprehensive health report for an eval.
 */
export function generateHealthReport(
  experiments: Experiment[],
  thresholds?: Partial<SaturationThresholds>
): EvalHealthReport {
  if (experiments.length === 0) {
    throw new Error("No experiments provided for health report");
  }

  const evalName = experiments[0].eval_name;

  // Aggregate saturation warnings from all experiments
  const allWarnings: SaturationWarning[] = [];
  for (const exp of experiments) {
    const warnings = detectSaturation(exp, thresholds);
    allWarnings.push(...warnings);
  }

  // Deduplicate warnings by type
  const uniqueWarnings = Array.from(
    new Map(allWarnings.map(w => [w.type, w])).values()
  );

  // Calculate difficulty scores
  const difficultyScores = calculateDifficultyScores(experiments);

  // Validate graders
  const graderValidation = validateGraders(experiments);

  // Calculate overall health score (0-1)
  let healthScore = 1.0;

  // Deduct for saturation warnings
  healthScore -= uniqueWarnings.length * 0.15;

  // Deduct for grader issues
  if (graderValidation.total_graders > 0) {
    const graderHealthRate =
      graderValidation.valid_graders / graderValidation.total_graders;
    healthScore -= (1 - graderHealthRate) * 0.3;
  }

  // Deduct for non-discriminating examples
  const discriminatingCount = Object.values(difficultyScores).filter(
    d => d.is_discriminating
  ).length;
  const totalExamples = Object.keys(difficultyScores).length;
  if (totalExamples > 0) {
    const discriminationRate = discriminatingCount / totalExamples;
    healthScore -= (1 - discriminationRate) * 0.2;
  }

  // Clamp to [0, 1]
  healthScore = Math.max(0, Math.min(1, healthScore));

  return {
    eval_name: evalName,
    timestamp: new Date().toISOString(),
    health_score: healthScore,
    warnings: uniqueWarnings,
    difficulty_scores: difficultyScores,
    grader_validation: graderValidation,
  };
}

/**
 * Format health report as markdown.
 */
export function formatHealthReport(report: EvalHealthReport): string {
  const lines: string[] = [];

  lines.push(`# Eval Health Report: ${report.eval_name}`);
  lines.push("");
  lines.push(`Generated: ${report.timestamp}`);
  lines.push("");

  // Health score with emoji
  const healthEmoji =
    report.health_score >= 0.8
      ? "🟢"
      : report.health_score >= 0.5
        ? "🟡"
        : "🔴";
  lines.push(
    `## Overall Health: ${healthEmoji} ${(report.health_score * 100).toFixed(0)}%`
  );
  lines.push("");

  // Saturation warnings
  if (report.warnings.length > 0) {
    lines.push("## Saturation Warnings");
    lines.push("");
    for (const warning of report.warnings) {
      lines.push(`### ⚠️ ${warning.type.replace(/_/g, " ").toUpperCase()}`);
      lines.push("");
      lines.push(warning.message);
      lines.push("");
      lines.push(`**Recommendation:** ${warning.recommendation}`);
      lines.push("");
    }
  } else {
    lines.push("## Saturation: No warnings");
    lines.push("");
  }

  // Grader validation
  if (report.grader_validation) {
    const gv = report.grader_validation;
    lines.push("## Grader Validation");
    lines.push("");
    lines.push(
      `${gv.valid_graders}/${gv.total_graders} graders passed validation`
    );
    lines.push("");

    if (gv.issues.length > 0) {
      lines.push("### Issues Found");
      lines.push("");
      for (const issue of gv.issues) {
        lines.push(`- **${issue.grader_key}** (${issue.type}): ${issue.message}`);
        lines.push(`  - ${issue.suggestion}`);
      }
      lines.push("");
    }
  }

  // Difficulty distribution
  const difficulties = Object.values(report.difficulty_scores);
  if (difficulties.length > 0) {
    lines.push("## Difficulty Distribution");
    lines.push("");

    const counts = {
      easy: difficulties.filter(d => d.difficulty === "easy").length,
      medium: difficulties.filter(d => d.difficulty === "medium").length,
      hard: difficulties.filter(d => d.difficulty === "hard").length,
      very_hard: difficulties.filter(d => d.difficulty === "very_hard").length,
    };

    lines.push(`| Difficulty | Count | Percentage |`);
    lines.push(`|------------|-------|------------|`);
    for (const [level, count] of Object.entries(counts)) {
      const pct = ((count / difficulties.length) * 100).toFixed(0);
      lines.push(`| ${level.replace("_", " ")} | ${count} | ${pct}% |`);
    }
    lines.push("");

    // Discrimination analysis
    const discriminating = difficulties.filter(d => d.is_discriminating).length;
    lines.push(
      `**Discriminating examples:** ${discriminating}/${difficulties.length} (${((discriminating / difficulties.length) * 100).toFixed(0)}%)`
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================================
// Helpers
// ============================================================================

function calculateVariance(values: number[]): number {
  if (values.length === 0) return 0;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
}
