// ============================================================================
// Dataset & Examples
// ============================================================================

export interface Dataset {
  name: string;
  description?: string;
  examples: Example[];
}

export interface Example {
  id: string;
  inputs: {
    query: string;
    files?: Record<string, string>;
  };
  reference_outputs?: {
    files?: Record<string, string>;
    tool_calls?: string[];
  };
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Eval Configuration
// ============================================================================

export interface EvalConfig {
  name: string;
  description?: string;
  dataset: string | Dataset;
  variants: Record<string, VariantConfig>;
  setup?: SetupConfig;
  evaluators: EvaluatorConfig[];
  judge_model?: string; // Default: claude-3-haiku-20240307
  error_handling?: ErrorHandlingConfig;
  /** Number of trials to run per example (default: 1) */
  trials?: number;
  /** Save full transcripts for analysis (default: false) */
  save_transcripts?: boolean;
  /** Directory to save transcripts (default: .evals/transcripts) */
  transcript_dir?: string;
  /** Parallel execution configuration */
  parallel?: ParallelConfig;
}

export interface VariantConfig {
  plugins: string[];
  model?: string;
  agent?: string;
  env?: Record<string, string>;
}

export interface SetupConfig {
  template?: string;
  files?: Record<string, string>;
  commands?: string[] | Record<string, string[]>;
  /** VCS (Version Control System) setup configuration */
  vcs?: VcsSetup;
}

// ============================================================================
// VCS Setup Configuration
// ============================================================================

/**
 * Configuration for setting up VCS state in sandboxes.
 * Supports git and jj (Jujutsu).
 */
export interface VcsSetup {
  git?: GitSetup;
  jj?: JjSetup;
}

/**
 * Git repository setup configuration.
 */
export interface GitSetup {
  /** Initialize as a git repository (default: true if any git options specified) */
  init?: boolean;
  /** Default branch name (default: "main") */
  defaultBranch?: string;
  /** Author name for commits (default: "Test User") */
  authorName?: string;
  /** Author email for commits (default: "test@example.com") */
  authorEmail?: string;
  /** Remote repository configuration */
  remote?: GitRemoteSetup;
  /** Commits to create in order */
  commits?: GitCommitSetup[];
  /** Branches to create */
  branches?: string[];
  /** Branch to checkout after setup */
  checkout?: string;
  /** Uncommitted changes to create */
  uncommitted?: {
    files: Record<string, string>;
    staged?: boolean;
  };
}

/**
 * Git remote repository setup.
 */
export interface GitRemoteSetup {
  /** Remote name (default: "origin") */
  name?: string;
  /** Create as bare repository (default: true) */
  bare?: boolean;
  /** Branches to push to the remote */
  branches?: string[];
}

/**
 * Git commit setup.
 */
export interface GitCommitSetup {
  /** Commit message */
  message: string;
  /** Files to create/modify before committing */
  files?: Record<string, string>;
  /** Branch to commit on (switches to this branch first) */
  branch?: string;
  /** Author name override */
  authorName?: string;
  /** Author email override */
  authorEmail?: string;
}

// ============================================================================
// JJ (Jujutsu) Setup Configuration
// ============================================================================

/**
 * JJ repository setup configuration.
 * JJ is a Git-compatible VCS with features like automatic change tracking.
 */
export interface JjSetup {
  /** Initialize as a jj repository (default: true if any jj options specified) */
  init?: boolean;
  /** Author name for changes (default: "Test User") */
  authorName?: string;
  /** Author email for changes (default: "test@example.com") */
  authorEmail?: string;
  /** Remote repository configuration */
  remote?: JjRemoteSetup;
  /** Changes to create in order */
  changes?: JjChangeSetup[];
  /** Bookmarks to create */
  bookmarks?: string[];
  /** Whether to start a new empty change after setup (default: true) */
  newChange?: boolean;
  /** Working copy changes to create (after all changes/bookmarks) */
  workingCopy?: {
    files: Record<string, string>;
    description?: string;
  };
  /** Create an orphan scenario for testing orphan recovery */
  orphan?: JjOrphanSetup;
}

/**
 * JJ remote repository setup.
 */
export interface JjRemoteSetup {
  /** Remote name (default: "origin") */
  name?: string;
  /** Create as bare repository (default: true) */
  bare?: boolean;
  /** Bookmarks to push to the remote */
  bookmarks?: string[];
}

/**
 * JJ change setup.
 */
export interface JjChangeSetup {
  /** Change description */
  description: string;
  /** Files to create/modify in this change */
  files?: Record<string, string>;
  /** Bookmark to set on this change */
  bookmark?: string;
  /** Author name override */
  authorName?: string;
  /** Author email override */
  authorEmail?: string;
}

/**
 * JJ orphan scenario setup for testing orphan recovery.
 */
export interface JjOrphanSetup {
  /** Description for the orphaned change */
  description: string;
  /** Files in the orphaned change */
  files: Record<string, string>;
  /** Remote bookmark to reset to (default: "main@origin") */
  resetTo?: string;
}

export interface ErrorHandlingConfig {
  on_error: "continue" | "abort" | "retry";
  retry_count?: number; // Default: 0
  timeout_ms?: number; // Default: 120000
}

// ============================================================================
// Parallel Execution Configuration
// ============================================================================

/**
 * Configuration for parallel execution of examples and trials.
 * Based on Anthropic's eval best practices for faster iteration.
 */
export interface ParallelConfig {
  /** Enable parallel execution (default: false) */
  enabled?: boolean;
  /** Maximum concurrent examples (default: 4) */
  max_examples?: number;
  /** Maximum concurrent trials per example (default: 2) */
  max_trials?: number;
  /** Delay between starting parallel tasks in ms (default: 100) */
  stagger_ms?: number;
}

// ============================================================================
// Eval Saturation & Maintenance
// ============================================================================

/**
 * Warning generated when an eval shows signs of saturation.
 */
export interface SaturationWarning {
  type: "high_pass_rate" | "low_variance" | "non_discriminating";
  message: string;
  metric: string;
  value: number;
  threshold: number;
  recommendation: string;
}

/**
 * Analysis of eval health and maintenance needs.
 */
export interface EvalHealthReport {
  eval_name: string;
  timestamp: string;
  /** Overall health score (0-1) */
  health_score: number;
  /** Saturation warnings */
  warnings: SaturationWarning[];
  /** Per-example difficulty scores */
  difficulty_scores: Record<string, DifficultyScore>;
  /** Grader validation results */
  grader_validation?: GraderValidation;
}

/**
 * Difficulty score for an individual example.
 */
export interface DifficultyScore {
  example_id: string;
  /** Pass rate across all runs (0-1) */
  pass_rate: number;
  /** Average score across runs */
  avg_score: number;
  /** Variance in scores */
  score_variance: number;
  /** Suggested difficulty label */
  difficulty: "easy" | "medium" | "hard" | "very_hard";
  /** Whether this example is discriminating (separates good from bad) */
  is_discriminating: boolean;
}

/**
 * Grader validation results.
 */
export interface GraderValidation {
  /** Total graders checked */
  total_graders: number;
  /** Graders that passed validation */
  valid_graders: number;
  /** Issues found during validation */
  issues: GraderIssue[];
}

/**
 * Issue found during grader validation.
 */
export interface GraderIssue {
  grader_key: string;
  type: "always_passes" | "always_fails" | "low_variance" | "inconsistent";
  message: string;
  suggestion: string;
}

// ============================================================================
// Evaluators
// ============================================================================

export interface EvaluatorConfig {
  type: "code" | "llm-judge";
  /** Weight for this evaluator in overall score (default: 1.0) */
  weight?: number;
  // Code evaluator options
  assertions?: Assertion[];
  // LLM-judge options
  criteria?: string[];
  /** Structured rubric for detailed grading (alternative to criteria) */
  rubric?: RubricItem[];
  reference_free?: boolean; // Default: true
}

/**
 * A rubric item defines a grading criterion with scoring levels.
 * Based on Anthropic's eval best practices for structured grading.
 */
export interface RubricItem {
  /** Short identifier for this criterion */
  name: string;
  /** Full description of what this criterion measures */
  description: string;
  /** Weight in overall score (default: 1.0) */
  weight?: number;
  /** Scoring levels from 0-4, each with description */
  levels?: RubricLevel[];
}

/**
 * A scoring level within a rubric item.
 * Default scale: 0=None, 1=Poor, 2=Fair, 3=Good, 4=Excellent
 */
export interface RubricLevel {
  /** Score value (0-4) */
  score: number;
  /** Label for this level (e.g., "Excellent", "Good", "Fair") */
  label: string;
  /** Description of what this score means */
  description: string;
}

/** Default rubric levels if not specified */
export const DEFAULT_RUBRIC_LEVELS: RubricLevel[] = [
  { score: 0, label: "None", description: "Criterion not addressed at all" },
  { score: 1, label: "Poor", description: "Minimal attempt, major issues" },
  { score: 2, label: "Fair", description: "Partial completion, some issues" },
  { score: 3, label: "Good", description: "Mostly complete, minor issues" },
  { score: 4, label: "Excellent", description: "Fully meets or exceeds expectations" },
];

export type Assertion =
  | { type: "file_exists"; path: string; weight?: number }
  | { type: "file_contains"; path: string; pattern: string; weight?: number }
  | { type: "file_not_contains"; path: string; pattern: string; weight?: number }
  | { type: "tool_called"; name: string; args?: Record<string, unknown>; weight?: number }
  | { type: "tool_not_called"; name: string; weight?: number }
  | { type: "exit_code"; expected: number; weight?: number }
  | { type: "environment_var"; name: string; value?: string; exists?: boolean; weight?: number }
  | { type: "process_running"; name: string; match?: "exact" | "contains"; weight?: number }
  | {
      type: "database_query_result";
      connection: string;
      query: string;
      expected: unknown;
      weight?: number;
    }
  // Advanced code graders
  | { type: "no_lint_errors"; paths?: string[]; config?: string; weight?: number }
  | { type: "no_type_errors"; tsconfig?: string; weight?: number }
  | { type: "no_security_issues"; paths?: string[]; weight?: number }
  /** @deprecated Use outcome-based assertions or rubrics instead. */
  | { type: "tool_call_sequence"; sequence: string[]; strict?: boolean; weight?: number }
  | { type: "performance"; metric: "tokens" | "duration" | "tool_calls"; max: number; weight?: number };

// ============================================================================
// OpenCode Event Stream (from opencode run --format json)
// ============================================================================

/**
 * Raw NDJSON event from opencode. Loosely typed since format may vary.
 */
export interface OpenCodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: OpenCodeEventPart;
  [key: string]: unknown;
}

export interface OpenCodeEventPart {
  id: string;
  type: string;
  // tool_use specific
  tool?: string;
  callID?: string;
  state?: {
    status: string;
    input: unknown;
    output: unknown;
    time: { start: number; end: number };
  };
  // text specific
  text?: string;
  // step_finish specific
  reason?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

export interface ToolCall {
  name: string;
  callID: string;
  args: unknown;
  output: unknown;
  timestamp: number;
  duration_ms: number;
}

// ============================================================================
// Results & Experiments
// ============================================================================

export interface Experiment {
  id: string;
  eval_name: string;
  variant: string;
  timestamp: string;
  config: EvalConfig;
  results: ExampleResult[];
  summary: ExperimentSummary;
}

/**
 * Result of a single trial execution.
 * Multiple trials may be run per example to handle non-determinism.
 */
export interface TrialResult {
  trial_number: number;
  outputs: {
    events: OpenCodeEvent[];
    final_files: Record<string, string>;
    tool_calls: ToolCall[];
    exit_code: number;
    tokens_used: number;
    cost: number;
    duration_ms: number;
  };
  feedback: Feedback[];
  passed: boolean;
  /** Path to saved transcript file, if save_transcripts enabled */
  transcript_path?: string;
}

export interface ExampleResult {
  example_id: string;
  inputs: Example["inputs"];
  /** Individual trial results (when trials > 1) */
  trials: TrialResult[];
  /** Aggregated outputs from all trials (backward compatible) */
  outputs: {
    events: OpenCodeEvent[];
    final_files: Record<string, string>;
    tool_calls: ToolCall[];
    exit_code: number;
    tokens_used: number;
    cost: number;
    duration_ms: number;
  };
  feedback: Feedback[];
  /** True if passed based on configured pass criteria */
  passed: boolean;
  /** Number of trials that passed */
  trials_passed: number;
  /** Total number of trials run */
  trials_total: number;
}

export interface Feedback {
  key: string;
  /** Raw score (0-1 for simple, 0-4 for rubric-based, null if insufficient info) */
  score: number | null;
  /** Normalized score (0-1) for aggregation */
  normalized_score: number;
  /** Weight applied to this feedback (default: 1.0) */
  weight: number;
  /** Weighted contribution to overall score */
  weighted_score: number;
  passed: boolean;
  comment?: string;
  /** Rubric level selected (if rubric-based grading) */
  rubric_level?: string;
}

export interface ExperimentSummary {
  total_examples: number;
  passed: number;
  failed: number;
  pass_rate: number;
  avg_score: number;
  total_tokens: number;
  total_cost: number;
  total_duration_ms: number;
  /** Multi-trial metrics (when trials > 1) */
  trial_metrics?: TrialMetrics;
}

/**
 * Metrics for multi-trial evaluation.
 * See: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
 */
export interface TrialMetrics {
  /** Number of trials per example */
  trials_per_example: number;
  /** pass@k: fraction of examples where at least 1 trial passed */
  pass_at_k: number;
  /** pass^k: fraction of examples where ALL trials passed */
  pass_all_k: number;
  /** Average pass rate across all trials */
  avg_trial_pass_rate: number;
  /** Standard deviation of pass rates across examples */
  pass_rate_std_dev: number;
  /** Examples with inconsistent results (some trials pass, some fail) */
  inconsistent_examples: number;
  /** Consistency rate: fraction of examples with consistent results */
  consistency_rate: number;
}

// ============================================================================
// Human Grading Workflow
// ============================================================================

/**
 * A task exported for human review.
 * Based on Anthropic's eval best practices for human-in-the-loop grading.
 */
export interface HumanReviewTask {
  id: string;
  eval_name: string;
  example_id: string;
  trial_number?: number;
  /** The original query/prompt */
  query: string;
  /** Agent's response/output for review */
  response: string;
  /** Tool calls made (summarized) */
  tool_calls_summary: string[];
  /** Files created/modified */
  files_changed: string[];
  /** Reference output if available */
  reference?: string;
  /** Grading criteria to evaluate */
  criteria: HumanGradingCriteria[];
  /** Current status */
  status: "pending" | "in_progress" | "completed" | "skipped";
  /** Assigned reviewer */
  assignee?: string;
  /** Creation timestamp */
  created_at: string;
  /** Completion timestamp */
  completed_at?: string;
}

/**
 * A grading criterion for human reviewers.
 */
export interface HumanGradingCriteria {
  name: string;
  description: string;
  /** Scoring scale (default: 0-4) */
  scale: { min: number; max: number };
  /** Optional anchor descriptions for each score level */
  anchors?: Record<number, string>;
}

/**
 * Human-provided grade for a single criterion.
 */
export interface HumanGrade {
  criterion: string;
  score: number;
  comment?: string;
  /** Time spent grading in seconds */
  time_spent_s?: number;
}

/**
 * Completed human review with all grades.
 */
export interface HumanReview {
  task_id: string;
  reviewer: string;
  grades: HumanGrade[];
  /** Overall pass/fail judgment */
  passed: boolean;
  /** Free-form notes */
  notes?: string;
  /** Timestamp of review */
  reviewed_at: string;
  /** Total time spent in seconds */
  total_time_s?: number;
}

/**
 * Inter-rater agreement metrics.
 */
export interface InterRaterAgreement {
  /** Number of examples with multiple reviews */
  overlapping_examples: number;
  /** Cohen's Kappa for pass/fail agreement */
  cohens_kappa: number;
  /** Pearson correlation for numeric scores */
  score_correlation: number;
  /** Average absolute score difference */
  avg_score_difference: number;
  /** Percentage of exact score matches */
  exact_match_rate: number;
  /** Per-criterion agreement */
  per_criterion: Record<string, { kappa: number; correlation: number }>;
}

/**
 * LLM judge calibration results.
 */
export interface JudgeCalibration {
  /** LLM judge model being calibrated */
  judge_model: string;
  /** Number of examples with both human and LLM grades */
  calibration_examples: number;
  /** Agreement between LLM and human graders */
  agreement: {
    pass_fail_accuracy: number;
    score_correlation: number;
    avg_score_difference: number;
  };
  /** Systematic biases detected */
  biases: JudgeBias[];
  /** Recommended adjustments */
  recommendations: string[];
}

/**
 * Detected bias in LLM judge.
 */
export interface JudgeBias {
  type: "lenient" | "harsh" | "criterion_specific" | "inconsistent";
  description: string;
  magnitude: number;
  affected_criterion?: string;
}

// ============================================================================
// Production Monitoring
// ============================================================================

/**
 * A production conversation/session that can be converted to an eval example.
 */
export interface ProductionSession {
  id: string;
  /** Original user query */
  query: string;
  /** Conversation events/transcript */
  events: OpenCodeEvent[];
  /** Files in the workspace */
  files: Record<string, string>;
  /** Outcome of the session */
  outcome: ProductionOutcome;
  /** Metadata about the session */
  metadata: {
    timestamp: string;
    user_id?: string;
    session_duration_ms: number;
    model: string;
    variant?: string;
  };
}

/**
 * Outcome classification for production sessions.
 */
export interface ProductionOutcome {
  /** How the session ended */
  status: "success" | "failure" | "abandoned" | "unknown";
  /** Classification method */
  classified_by: "user_feedback" | "heuristic" | "manual" | "llm";
  /** Confidence in classification (0-1) */
  confidence: number;
  /** Specific failure category if failed */
  failure_category?: string;
  /** User feedback if available */
  user_feedback?: {
    rating?: number;
    comment?: string;
    thumbs?: "up" | "down";
  };
}

/**
 * Configuration for converting production failures to eval examples.
 */
export interface FailureToEvalConfig {
  /** Minimum confidence to include */
  min_confidence: number;
  /** Failure categories to include */
  include_categories?: string[];
  /** Failure categories to exclude */
  exclude_categories?: string[];
  /** Whether to include abandoned sessions */
  include_abandoned: boolean;
  /** Maximum examples to generate */
  max_examples?: number;
  /** How to generate reference outputs */
  reference_generation: "none" | "from_retry" | "manual" | "llm_generated";
}

/**
 * A/B test configuration for comparing variants.
 */
export interface ABTestConfig {
  name: string;
  /** Variants being compared */
  variants: string[];
  /** Metrics to track */
  metrics: ABMetric[];
  /** Minimum sample size per variant */
  min_samples: number;
  /** Statistical significance threshold */
  significance_level: number;
}

/**
 * Metric tracked in A/B test.
 */
export interface ABMetric {
  name: string;
  type: "rate" | "average" | "percentile";
  /** For rate metrics, what counts as success */
  success_condition?: string;
  /** For percentile metrics, which percentile */
  percentile?: number;
}

/**
 * Results of an A/B test.
 */
export interface ABTestResults {
  config: ABTestConfig;
  /** Per-variant results */
  variants: Record<string, ABVariantResult>;
  /** Statistical comparisons */
  comparisons: ABComparison[];
  /** Overall recommendation */
  recommendation?: {
    winner?: string;
    confidence: number;
    summary: string;
  };
}

/**
 * Results for a single variant in A/B test.
 */
export interface ABVariantResult {
  variant: string;
  sample_size: number;
  metrics: Record<string, { value: number; ci_lower: number; ci_upper: number }>;
}

/**
 * Statistical comparison between two variants.
 */
export interface ABComparison {
  variant_a: string;
  variant_b: string;
  metric: string;
  difference: number;
  p_value: number;
  significant: boolean;
  effect_size: number;
}

/**
 * Regression detection result.
 */
export interface RegressionAlert {
  type: "pass_rate_drop" | "score_decline" | "latency_increase" | "cost_increase";
  severity: "warning" | "critical";
  metric: string;
  baseline_value: number;
  current_value: number;
  change_percent: number;
  detected_at: string;
  affected_examples?: string[];
  recommendation: string;
}

/**
 * Quality monitoring dashboard data.
 */
export interface QualityDashboard {
  /** Time range for the dashboard */
  time_range: { start: string; end: string };
  /** Overall metrics */
  summary: {
    total_sessions: number;
    success_rate: number;
    avg_score: number;
    avg_latency_ms: number;
    avg_cost: number;
  };
  /** Trend over time */
  trends: {
    date: string;
    success_rate: number;
    avg_score: number;
    session_count: number;
  }[];
  /** Active regression alerts */
  alerts: RegressionAlert[];
  /** Top failure categories */
  top_failures: { category: string; count: number; examples: string[] }[];
}

// ============================================================================
// CLI Options
// ============================================================================

export interface RunOptions {
  variant?: string;
  dryRun?: boolean;
  output?: string;
  verbose?: boolean;
  /** Override number of trials from config */
  trials?: number;
  /** Pass criteria: 'any' (pass@k) or 'all' (pass^k). Default: 'any' */
  pass_criteria?: 'any' | 'all';
  /** Override parallel execution from config */
  parallel?: boolean;
  /** Override max concurrent examples */
  concurrency?: number;
}

export interface CompareOptions {
  format?: "json" | "markdown";
  output?: string;
}

export interface ReportOptions {
  format?: "json" | "markdown";
  output?: string;
}
