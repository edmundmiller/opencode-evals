/**
 * Production monitoring module.
 * Converts production sessions to eval examples, detects regressions,
 * and provides quality dashboards.
 */

import { writeFile, readFile } from "fs/promises";
import type {
  ProductionSession,
  ProductionOutcome,
  FailureToEvalConfig,
  Example,
  Dataset,
  Experiment,
  RegressionAlert,
  QualityDashboard,
  ABTestConfig,
  ABTestResults,
  ABVariantResult,
  ABComparison,
  OpenCodeEvent,
} from "./types.js";

// ============================================================================
// Failure to Eval Conversion
// ============================================================================

const DEFAULT_FAILURE_CONFIG: FailureToEvalConfig = {
  min_confidence: 0.7,
  include_abandoned: false,
  reference_generation: "none",
};

/**
 * Convert production failures to eval examples.
 * Based on Anthropic's best practice of mining failures for new test cases.
 */
export function convertFailuresToEvals(
  sessions: ProductionSession[],
  config: Partial<FailureToEvalConfig> = {}
): Dataset {
  const cfg = { ...DEFAULT_FAILURE_CONFIG, ...config };

  // Filter to failures
  let failures = sessions.filter((s) => {
    if (s.outcome.confidence < cfg.min_confidence) return false;
    if (s.outcome.status === "success") return false;
    if (s.outcome.status === "abandoned" && !cfg.include_abandoned) return false;

    // Category filters
    if (cfg.include_categories && s.outcome.failure_category) {
      if (!cfg.include_categories.includes(s.outcome.failure_category)) {
        return false;
      }
    }
    if (cfg.exclude_categories && s.outcome.failure_category) {
      if (cfg.exclude_categories.includes(s.outcome.failure_category)) {
        return false;
      }
    }

    return true;
  });

  // Limit if needed
  if (cfg.max_examples && failures.length > cfg.max_examples) {
    failures = failures.slice(0, cfg.max_examples);
  }

  // Convert to examples
  const examples: Example[] = failures.map((session) =>
    sessionToExample(session, cfg)
  );

  return {
    name: `production-failures-${new Date().toISOString().split("T")[0]}`,
    description: `Eval examples generated from ${examples.length} production failures`,
    examples,
  };
}

function sessionToExample(
  session: ProductionSession,
  config: FailureToEvalConfig
): Example {
  const example: Example = {
    id: `prod-${session.id}`,
    inputs: {
      query: session.query,
      files: session.files,
    },
    metadata: {
      source: "production",
      original_session_id: session.id,
      failure_category: session.outcome.failure_category,
      timestamp: session.metadata.timestamp,
      model: session.metadata.model,
      outcome_status: session.outcome.status,
      user_feedback: session.outcome.user_feedback,
    },
  };

  // Add reference output if configured
  if (config.reference_generation === "from_retry") {
    // Would need access to retry data - placeholder
    example.metadata!.needs_reference = true;
  }

  return example;
}

/**
 * Parse production sessions from log files (NDJSON format).
 */
export async function parseProductionLogs(
  logPath: string
): Promise<ProductionSession[]> {
  const content = await readFile(logPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  const sessions = new Map<string, ProductionSession>();

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as OpenCodeEvent & {
        sessionID?: string;
        query?: string;
        outcome?: ProductionOutcome;
      };

      if (!event.sessionID) continue;

      // Initialize session if new
      if (!sessions.has(event.sessionID)) {
        sessions.set(event.sessionID, {
          id: event.sessionID,
          query: "",
          events: [],
          files: {},
          outcome: {
            status: "unknown",
            classified_by: "heuristic",
            confidence: 0.5,
          },
          metadata: {
            timestamp: new Date(event.timestamp ?? Date.now()).toISOString(),
            session_duration_ms: 0,
            model: "unknown",
          },
        });
      }

      const session = sessions.get(event.sessionID)!;
      session.events.push(event);

      // Extract query from first user message
      if (event.type === "user_message" && event.query && !session.query) {
        session.query = event.query;
      }

      // Extract outcome if present
      if (event.outcome) {
        session.outcome = event.outcome;
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Post-process sessions
  for (const session of sessions.values()) {
    // Calculate duration
    if (session.events.length >= 2) {
      const first = session.events[0].timestamp ?? 0;
      const last = session.events[session.events.length - 1].timestamp ?? 0;
      session.metadata.session_duration_ms = last - first;
    }

    // Classify outcome if not already classified
    if (session.outcome.status === "unknown") {
      session.outcome = classifyOutcome(session);
    }
  }

  return Array.from(sessions.values());
}

/**
 * Heuristically classify session outcome.
 */
function classifyOutcome(session: ProductionSession): ProductionOutcome {
  const events = session.events;

  // Check for explicit failure events
  const hasError = events.some(
    (e) =>
      e.type === "error" ||
      (e.part?.type === "tool_use" && e.part.state?.status === "error")
  );

  // Check for successful completion
  const hasCompletion = events.some(
    (e) => e.type === "session_complete" || e.part?.reason === "end_turn"
  );

  // Check for user feedback
  const feedback = events.find((e) => e.type === "user_feedback") as
    | { rating?: number; thumbs?: "up" | "down" }
    | undefined;

  if (feedback?.thumbs === "down" || (feedback?.rating && feedback.rating <= 2)) {
    return {
      status: "failure",
      classified_by: "user_feedback",
      confidence: 0.9,
      user_feedback: {
        rating: feedback.rating,
        thumbs: feedback.thumbs,
      },
    };
  }

  if (feedback?.thumbs === "up" || (feedback?.rating && feedback.rating >= 4)) {
    return {
      status: "success",
      classified_by: "user_feedback",
      confidence: 0.9,
      user_feedback: {
        rating: feedback.rating,
        thumbs: feedback.thumbs,
      },
    };
  }

  if (hasError) {
    return {
      status: "failure",
      classified_by: "heuristic",
      confidence: 0.7,
      failure_category: "error",
    };
  }

  if (hasCompletion) {
    return {
      status: "success",
      classified_by: "heuristic",
      confidence: 0.6,
    };
  }

  // Short sessions without completion are likely abandoned
  if (session.metadata.session_duration_ms < 30000 && events.length < 10) {
    return {
      status: "abandoned",
      classified_by: "heuristic",
      confidence: 0.5,
    };
  }

  return {
    status: "unknown",
    classified_by: "heuristic",
    confidence: 0.3,
  };
}

// ============================================================================
// Regression Detection
// ============================================================================

export interface RegressionConfig {
  /** Minimum change to trigger warning */
  warning_threshold: number;
  /** Minimum change to trigger critical alert */
  critical_threshold: number;
  /** Minimum samples for comparison */
  min_samples: number;
  /** Metrics to monitor */
  metrics: ("pass_rate" | "avg_score" | "latency" | "cost")[];
}

const DEFAULT_REGRESSION_CONFIG: RegressionConfig = {
  warning_threshold: 0.1,
  critical_threshold: 0.2,
  min_samples: 10,
  metrics: ["pass_rate", "avg_score", "latency", "cost"],
};

/**
 * Detect regressions by comparing recent results to baseline.
 */
export function detectRegressions(
  baseline: Experiment[],
  current: Experiment[],
  config: Partial<RegressionConfig> = {}
): RegressionAlert[] {
  const cfg = { ...DEFAULT_REGRESSION_CONFIG, ...config };
  const alerts: RegressionAlert[] = [];

  // Aggregate metrics
  const baselineMetrics = aggregateMetrics(baseline);
  const currentMetrics = aggregateMetrics(current);

  // Check sample size
  if (baselineMetrics.count < cfg.min_samples || currentMetrics.count < cfg.min_samples) {
    return alerts;
  }

  // Check pass rate
  if (cfg.metrics.includes("pass_rate")) {
    const change = baselineMetrics.pass_rate - currentMetrics.pass_rate;
    if (change > 0) {
      const changePercent = change / baselineMetrics.pass_rate;
      if (changePercent >= cfg.critical_threshold) {
        alerts.push({
          type: "pass_rate_drop",
          severity: "critical",
          metric: "pass_rate",
          baseline_value: baselineMetrics.pass_rate,
          current_value: currentMetrics.pass_rate,
          change_percent: changePercent * 100,
          detected_at: new Date().toISOString(),
          recommendation: "Investigate recent changes. Consider rolling back if critical.",
        });
      } else if (changePercent >= cfg.warning_threshold) {
        alerts.push({
          type: "pass_rate_drop",
          severity: "warning",
          metric: "pass_rate",
          baseline_value: baselineMetrics.pass_rate,
          current_value: currentMetrics.pass_rate,
          change_percent: changePercent * 100,
          detected_at: new Date().toISOString(),
          recommendation: "Monitor closely. Review failed examples for patterns.",
        });
      }
    }
  }

  // Check average score
  if (cfg.metrics.includes("avg_score")) {
    const change = baselineMetrics.avg_score - currentMetrics.avg_score;
    if (change > 0) {
      const changePercent = change / baselineMetrics.avg_score;
      if (changePercent >= cfg.critical_threshold) {
        alerts.push({
          type: "score_decline",
          severity: "critical",
          metric: "avg_score",
          baseline_value: baselineMetrics.avg_score,
          current_value: currentMetrics.avg_score,
          change_percent: changePercent * 100,
          detected_at: new Date().toISOString(),
          recommendation: "Score decline detected. Review grading criteria and outputs.",
        });
      } else if (changePercent >= cfg.warning_threshold) {
        alerts.push({
          type: "score_decline",
          severity: "warning",
          metric: "avg_score",
          baseline_value: baselineMetrics.avg_score,
          current_value: currentMetrics.avg_score,
          change_percent: changePercent * 100,
          detected_at: new Date().toISOString(),
          recommendation: "Slight score decline. Review low-scoring examples.",
        });
      }
    }
  }

  // Check latency increase
  if (cfg.metrics.includes("latency")) {
    const change = currentMetrics.avg_latency - baselineMetrics.avg_latency;
    if (change > 0) {
      const changePercent = change / baselineMetrics.avg_latency;
      if (changePercent >= cfg.critical_threshold) {
        alerts.push({
          type: "latency_increase",
          severity: "critical",
          metric: "avg_latency_ms",
          baseline_value: baselineMetrics.avg_latency,
          current_value: currentMetrics.avg_latency,
          change_percent: changePercent * 100,
          detected_at: new Date().toISOString(),
          recommendation: "Significant latency increase. Check for inefficient tool usage.",
        });
      } else if (changePercent >= cfg.warning_threshold) {
        alerts.push({
          type: "latency_increase",
          severity: "warning",
          metric: "avg_latency_ms",
          baseline_value: baselineMetrics.avg_latency,
          current_value: currentMetrics.avg_latency,
          change_percent: changePercent * 100,
          detected_at: new Date().toISOString(),
          recommendation: "Latency trending up. Monitor for further increases.",
        });
      }
    }
  }

  // Check cost increase
  if (cfg.metrics.includes("cost")) {
    const change = currentMetrics.avg_cost - baselineMetrics.avg_cost;
    if (change > 0) {
      const changePercent = change / baselineMetrics.avg_cost;
      if (changePercent >= cfg.critical_threshold) {
        alerts.push({
          type: "cost_increase",
          severity: "critical",
          metric: "avg_cost",
          baseline_value: baselineMetrics.avg_cost,
          current_value: currentMetrics.avg_cost,
          change_percent: changePercent * 100,
          detected_at: new Date().toISOString(),
          recommendation: "Cost increased significantly. Review token usage patterns.",
        });
      } else if (changePercent >= cfg.warning_threshold) {
        alerts.push({
          type: "cost_increase",
          severity: "warning",
          metric: "avg_cost",
          baseline_value: baselineMetrics.avg_cost,
          current_value: currentMetrics.avg_cost,
          change_percent: changePercent * 100,
          detected_at: new Date().toISOString(),
          recommendation: "Cost trending up. Consider prompt optimization.",
        });
      }
    }
  }

  return alerts;
}

interface AggregatedMetrics {
  count: number;
  pass_rate: number;
  avg_score: number;
  avg_latency: number;
  avg_cost: number;
}

function aggregateMetrics(experiments: Experiment[]): AggregatedMetrics {
  let totalExamples = 0;
  let totalPassed = 0;
  let totalScore = 0;
  let totalLatency = 0;
  let totalCost = 0;

  for (const exp of experiments) {
    for (const result of exp.results) {
      totalExamples++;
      if (result.passed) totalPassed++;

      // Average score from feedback
      if (result.feedback.length > 0) {
        const avgFeedback =
          result.feedback.reduce((s, f) => s + f.normalized_score, 0) /
          result.feedback.length;
        totalScore += avgFeedback;
      }

      totalLatency += result.outputs.duration_ms;
      totalCost += result.outputs.cost;
    }
  }

  if (totalExamples === 0) {
    return { count: 0, pass_rate: 0, avg_score: 0, avg_latency: 0, avg_cost: 0 };
  }

  return {
    count: totalExamples,
    pass_rate: totalPassed / totalExamples,
    avg_score: totalScore / totalExamples,
    avg_latency: totalLatency / totalExamples,
    avg_cost: totalCost / totalExamples,
  };
}

// ============================================================================
// A/B Testing
// ============================================================================

/**
 * Analyze A/B test results from experiments.
 */
export function analyzeABTest(
  experiments: Experiment[],
  config: ABTestConfig
): ABTestResults {
  // Group experiments by variant
  const byVariant = new Map<string, Experiment[]>();
  for (const exp of experiments) {
    if (config.variants.includes(exp.variant)) {
      const existing = byVariant.get(exp.variant) ?? [];
      existing.push(exp);
      byVariant.set(exp.variant, existing);
    }
  }

  // Calculate per-variant results
  const variantResults: Record<string, ABVariantResult> = {};

  for (const variant of config.variants) {
    const exps = byVariant.get(variant) ?? [];
    variantResults[variant] = calculateVariantResult(variant, exps, config.metrics);
  }

  // Calculate comparisons
  const comparisons: ABComparison[] = [];

  for (let i = 0; i < config.variants.length - 1; i++) {
    for (let j = i + 1; j < config.variants.length; j++) {
      const varA = config.variants[i];
      const varB = config.variants[j];

      for (const metric of config.metrics) {
        const comparison = compareVariants(
          variantResults[varA],
          variantResults[varB],
          metric.name,
          config.significance_level
        );
        comparisons.push(comparison);
      }
    }
  }

  // Generate recommendation
  const recommendation = generateRecommendation(
    variantResults,
    comparisons,
    config
  );

  return {
    config,
    variants: variantResults,
    comparisons,
    recommendation,
  };
}

function calculateVariantResult(
  variant: string,
  experiments: Experiment[],
  metrics: ABTestConfig["metrics"]
): ABVariantResult {
  const aggregated = aggregateMetrics(experiments);

  const metricsResult: Record<string, { value: number; ci_lower: number; ci_upper: number }> = {};

  for (const metric of metrics) {
    let value = 0;
    if (metric.name === "pass_rate" || metric.type === "rate") {
      value = aggregated.pass_rate;
    } else if (metric.name === "avg_score") {
      value = aggregated.avg_score;
    } else if (metric.name === "latency") {
      value = aggregated.avg_latency;
    } else if (metric.name === "cost") {
      value = aggregated.avg_cost;
    }

    // Simple confidence interval (would need proper stats for production)
    const margin = value * 0.1; // 10% margin as placeholder
    metricsResult[metric.name] = {
      value,
      ci_lower: value - margin,
      ci_upper: value + margin,
    };
  }

  return {
    variant,
    sample_size: aggregated.count,
    metrics: metricsResult,
  };
}

function compareVariants(
  resultA: ABVariantResult,
  resultB: ABVariantResult,
  metric: string,
  significanceLevel: number
): ABComparison {
  const valueA = resultA.metrics[metric]?.value ?? 0;
  const valueB = resultB.metrics[metric]?.value ?? 0;
  const difference = valueA - valueB;

  // Simplified p-value calculation (placeholder - would need proper stats)
  const pooledStdErr = Math.abs(difference) * 0.2;
  const zScore = pooledStdErr > 0 ? Math.abs(difference) / pooledStdErr : 0;
  const pValue = Math.exp(-0.5 * zScore * zScore); // Approximation

  const effectSize = valueB !== 0 ? difference / valueB : 0;

  return {
    variant_a: resultA.variant,
    variant_b: resultB.variant,
    metric,
    difference,
    p_value: pValue,
    significant: pValue < significanceLevel,
    effect_size: effectSize,
  };
}

function generateRecommendation(
  variants: Record<string, ABVariantResult>,
  comparisons: ABComparison[],
  config: ABTestConfig
): ABTestResults["recommendation"] {
  // Check if we have enough samples
  for (const variant of Object.values(variants)) {
    if (variant.sample_size < config.min_samples) {
      return {
        confidence: 0,
        summary: `Insufficient samples. Need at least ${config.min_samples} per variant.`,
      };
    }
  }

  // Find significant improvements
  const significantComparisons = comparisons.filter((c) => c.significant);

  if (significantComparisons.length === 0) {
    return {
      confidence: 0.5,
      summary: "No statistically significant differences detected between variants.",
    };
  }

  // Simple winner detection based on most significant improvements
  const winCounts: Record<string, number> = {};
  for (const variant of config.variants) {
    winCounts[variant] = 0;
  }

  for (const comp of significantComparisons) {
    if (comp.difference > 0) {
      winCounts[comp.variant_a]++;
    } else {
      winCounts[comp.variant_b]++;
    }
  }

  const [winner, wins] = Object.entries(winCounts).reduce((a, b) =>
    b[1] > a[1] ? b : a
  );

  const confidence = wins / significantComparisons.length;

  return {
    winner,
    confidence,
    summary: `${winner} shows significant improvements in ${wins}/${significantComparisons.length} comparisons.`,
  };
}

// ============================================================================
// Quality Dashboard
// ============================================================================

/**
 * Generate quality dashboard from experiments.
 */
export function generateDashboard(
  experiments: Experiment[],
  timeRange?: { start: Date; end: Date }
): QualityDashboard {
  // Filter by time range if specified
  let filtered = experiments;
  if (timeRange) {
    filtered = experiments.filter((exp) => {
      const ts = new Date(exp.timestamp);
      return ts >= timeRange.start && ts <= timeRange.end;
    });
  }

  // Calculate summary
  const metrics = aggregateMetrics(filtered);

  // Calculate trends (group by day)
  const byDay = new Map<string, Experiment[]>();
  for (const exp of filtered) {
    const day = exp.timestamp.split("T")[0];
    const existing = byDay.get(day) ?? [];
    existing.push(exp);
    byDay.set(day, existing);
  }

  const trends = Array.from(byDay.entries())
    .map(([date, exps]) => {
      const dayMetrics = aggregateMetrics(exps);
      return {
        date,
        success_rate: dayMetrics.pass_rate,
        avg_score: dayMetrics.avg_score,
        session_count: dayMetrics.count,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Categorize failures
  const failureCategories = new Map<string, { count: number; examples: string[] }>();
  for (const exp of filtered) {
    for (const result of exp.results) {
      if (!result.passed) {
        const category =
          (result.feedback.find((f) => !f.passed)?.key ?? "unknown");
        const existing = failureCategories.get(category) ?? { count: 0, examples: [] };
        existing.count++;
        if (existing.examples.length < 5) {
          existing.examples.push(result.example_id);
        }
        failureCategories.set(category, existing);
      }
    }
  }

  const topFailures = Array.from(failureCategories.entries())
    .map(([category, data]) => ({ category, ...data }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    time_range: {
      start: timeRange?.start.toISOString() ?? filtered[0]?.timestamp ?? "",
      end: timeRange?.end.toISOString() ?? filtered[filtered.length - 1]?.timestamp ?? "",
    },
    summary: {
      total_sessions: metrics.count,
      success_rate: metrics.pass_rate,
      avg_score: metrics.avg_score,
      avg_latency_ms: metrics.avg_latency,
      avg_cost: metrics.avg_cost,
    },
    trends,
    alerts: [], // Would be populated by detectRegressions
    top_failures: topFailures,
  };
}

/**
 * Format dashboard as markdown.
 */
export function formatDashboard(dashboard: QualityDashboard): string {
  const lines: string[] = [];

  lines.push("# Quality Dashboard");
  lines.push("");
  lines.push(`Time Range: ${dashboard.time_range.start} to ${dashboard.time_range.end}`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Sessions | ${dashboard.summary.total_sessions} |`);
  lines.push(`| Success Rate | ${(dashboard.summary.success_rate * 100).toFixed(1)}% |`);
  lines.push(`| Avg Score | ${(dashboard.summary.avg_score * 100).toFixed(1)}% |`);
  lines.push(`| Avg Latency | ${(dashboard.summary.avg_latency_ms / 1000).toFixed(1)}s |`);
  lines.push(`| Avg Cost | $${dashboard.summary.avg_cost.toFixed(4)} |`);
  lines.push("");

  if (dashboard.alerts.length > 0) {
    lines.push("## Active Alerts");
    lines.push("");
    for (const alert of dashboard.alerts) {
      const icon = alert.severity === "critical" ? "🔴" : "🟡";
      lines.push(`${icon} **${alert.type}**: ${alert.metric} changed by ${alert.change_percent.toFixed(1)}%`);
      lines.push(`   ${alert.recommendation}`);
    }
    lines.push("");
  }

  if (dashboard.top_failures.length > 0) {
    lines.push("## Top Failure Categories");
    lines.push("");
    lines.push(`| Category | Count | Examples |`);
    lines.push(`|----------|-------|----------|`);
    for (const failure of dashboard.top_failures.slice(0, 5)) {
      lines.push(`| ${failure.category} | ${failure.count} | ${failure.examples.slice(0, 3).join(", ")} |`);
    }
    lines.push("");
  }

  if (dashboard.trends.length > 1) {
    lines.push("## Trends (Last 7 Days)");
    lines.push("");
    lines.push(`| Date | Sessions | Success Rate | Avg Score |`);
    lines.push(`|------|----------|--------------|-----------|`);
    for (const day of dashboard.trends.slice(-7)) {
      lines.push(`| ${day.date} | ${day.session_count} | ${(day.success_rate * 100).toFixed(1)}% | ${(day.avg_score * 100).toFixed(1)}% |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Export dataset to file.
 */
export async function exportDataset(
  dataset: Dataset,
  outputPath: string
): Promise<void> {
  await writeFile(outputPath, JSON.stringify(dataset, null, 2));
}
