import { writeFile } from "node:fs/promises";
import type { Experiment, ExampleResult } from "./types.js";

/**
 * Output experiment results as JSON.
 */
export async function writeJSONReport(
  experiments: Experiment[],
  outputPath: string
): Promise<void> {
  const json = JSON.stringify(experiments, null, 2);
  await writeFile(outputPath, json, "utf-8");
}

/**
 * Generate a markdown report for experiments.
 */
export function generateMarkdownReport(experiments: Experiment[]): string {
  const lines: string[] = [];

  lines.push("# Evaluation Report");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  for (const exp of experiments) {
    lines.push(`## ${exp.eval_name} - ${exp.variant}`);
    lines.push("");
    lines.push(`**ID:** ${exp.id}`);
    lines.push(`**Timestamp:** ${exp.timestamp}`);
    lines.push("");

    // Summary
    lines.push("### Summary");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Examples | ${exp.summary.total_examples} |`);
    lines.push(`| Passed | ${exp.summary.passed} |`);
    lines.push(`| Failed | ${exp.summary.failed} |`);
    lines.push(`| Pass Rate | ${(exp.summary.pass_rate * 100).toFixed(1)}% |`);
    lines.push(`| Avg Score | ${exp.summary.avg_score.toFixed(3)} |`);
    lines.push(`| Total Tokens | ${exp.summary.total_tokens.toLocaleString()} |`);
    lines.push(`| Total Cost | $${exp.summary.total_cost.toFixed(4)} |`);
    lines.push(
      `| Total Duration | ${(exp.summary.total_duration_ms / 1000).toFixed(1)}s |`
    );
    lines.push("");

    // Trial metrics (if multi-trial)
    if (exp.summary.trial_metrics) {
      const tm = exp.summary.trial_metrics;
      lines.push("### Trial Metrics");
      lines.push("");
      lines.push(`*${tm.trials_per_example} trials per example*`);
      lines.push("");
      lines.push("| Metric | Value |");
      lines.push("|--------|-------|");
      lines.push(`| pass@${tm.trials_per_example} | ${(tm.pass_at_k * 100).toFixed(1)}% |`);
      lines.push(`| pass^${tm.trials_per_example} | ${(tm.pass_all_k * 100).toFixed(1)}% |`);
      lines.push(`| Avg Trial Pass Rate | ${(tm.avg_trial_pass_rate * 100).toFixed(1)}% |`);
      lines.push(`| Pass Rate Std Dev | ${(tm.pass_rate_std_dev * 100).toFixed(1)}% |`);
      lines.push(`| Inconsistent Examples | ${tm.inconsistent_examples} |`);
      lines.push(`| Consistency Rate | ${(tm.consistency_rate * 100).toFixed(1)}% |`);
      lines.push("");
    }

    // Results
    lines.push("### Results");
    lines.push("");

    for (const result of exp.results) {
      const icon = result.passed ? "✅" : "❌";
      const trialInfo = result.trials_total > 1 
        ? ` (${result.trials_passed}/${result.trials_total} trials)`
        : "";
      lines.push(`#### ${icon} ${result.example_id}${trialInfo}`);
      lines.push("");
      lines.push(`**Query:** ${result.inputs.query}`);
      lines.push("");

      if (result.feedback.length > 0) {
        lines.push("**Feedback:**");
        lines.push("");
        for (const fb of result.feedback) {
          const fbIcon = fb.passed ? "✓" : "✗";
          const scoreInfo = fb.weight !== 1 
            ? ` (score: ${fb.normalized_score.toFixed(2)}, weight: ${fb.weight.toFixed(1)})`
            : fb.normalized_score < 1 && fb.normalized_score > 0
              ? ` (score: ${fb.normalized_score.toFixed(2)})`
              : "";
          const levelInfo = fb.rubric_level ? ` [${fb.rubric_level}]` : "";
          lines.push(`- ${fbIcon} \`${fb.key}\`${levelInfo}${scoreInfo}: ${fb.comment ?? ""}`);
        }
        lines.push("");
        
        // Show weighted total if there are weighted criteria
        const hasWeights = result.feedback.some(f => f.weight !== 1);
        if (hasWeights) {
          const totalWeight = result.feedback.reduce((sum, f) => sum + f.weight, 0);
          const weightedSum = result.feedback.reduce((sum, f) => sum + f.weighted_score, 0);
          const weightedAvg = totalWeight > 0 ? weightedSum / totalWeight : 0;
          lines.push(`**Weighted Score:** ${(weightedAvg * 100).toFixed(1)}%`);
          lines.push("");
        }
      }

      if (result.outputs.tool_calls.length > 0) {
        lines.push(
          `**Tool Calls:** ${result.outputs.tool_calls.map((t) => t.name).join(", ")}`
        );
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

/**
 * Generate a comparison report between two experiments.
 */
export function generateComparisonReport(
  baseline: Experiment,
  treatment: Experiment
): string {
  const lines: string[] = [];

  lines.push("# Comparison Report");
  lines.push("");
  lines.push(`**Baseline:** ${baseline.variant}`);
  lines.push(`**Treatment:** ${treatment.variant}`);
  lines.push("");

  lines.push("## Summary Comparison");
  lines.push("");
  lines.push("| Metric | Baseline | Treatment | Δ |");
  lines.push("|--------|----------|-----------|---|");

  const metrics = [
    {
      name: "Pass Rate",
      b: baseline.summary.pass_rate,
      t: treatment.summary.pass_rate,
      format: (v: number) => `${(v * 100).toFixed(1)}%`,
      delta: (b: number, t: number) =>
        `${t > b ? "+" : ""}${((t - b) * 100).toFixed(1)}%`,
    },
    {
      name: "Avg Score",
      b: baseline.summary.avg_score,
      t: treatment.summary.avg_score,
      format: (v: number) => v.toFixed(3),
      delta: (b: number, t: number) => `${t > b ? "+" : ""}${(t - b).toFixed(3)}`,
    },
    {
      name: "Tokens",
      b: baseline.summary.total_tokens,
      t: treatment.summary.total_tokens,
      format: (v: number) => v.toLocaleString(),
      delta: (b: number, t: number) =>
        `${t > b ? "+" : ""}${(t - b).toLocaleString()}`,
    },
    {
      name: "Cost",
      b: baseline.summary.total_cost,
      t: treatment.summary.total_cost,
      format: (v: number) => `$${v.toFixed(4)}`,
      delta: (b: number, t: number) =>
        `${t > b ? "+" : ""}$${(t - b).toFixed(4)}`,
    },
    {
      name: "Duration",
      b: baseline.summary.total_duration_ms,
      t: treatment.summary.total_duration_ms,
      format: (v: number) => `${(v / 1000).toFixed(1)}s`,
      delta: (b: number, t: number) =>
        `${t > b ? "+" : ""}${((t - b) / 1000).toFixed(1)}s`,
    },
  ];

  for (const m of metrics) {
    lines.push(
      `| ${m.name} | ${m.format(m.b)} | ${m.format(m.t)} | ${m.delta(m.b, m.t)} |`
    );
  }

  lines.push("");

  // Per-example comparison
  lines.push("## Per-Example Comparison");
  lines.push("");
  lines.push("| Example | Baseline | Treatment |");
  lines.push("|---------|----------|-----------|");

  const baselineResults = new Map(baseline.results.map((r) => [r.example_id, r]));
  const treatmentResults = new Map(
    treatment.results.map((r) => [r.example_id, r])
  );

  const allExamples = new Set([
    ...baselineResults.keys(),
    ...treatmentResults.keys(),
  ]);

  for (const exampleId of allExamples) {
    const bResult = baselineResults.get(exampleId);
    const tResult = treatmentResults.get(exampleId);

    const bStatus = bResult ? (bResult.passed ? "✅" : "❌") : "—";
    const tStatus = tResult ? (tResult.passed ? "✅" : "❌") : "—";

    lines.push(`| ${exampleId} | ${bStatus} | ${tStatus} |`);
  }

  lines.push("");

  return lines.join("\n");
}
