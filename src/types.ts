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
}

export interface ErrorHandlingConfig {
  on_error: "continue" | "abort" | "retry";
  retry_count?: number; // Default: 0
  timeout_ms?: number; // Default: 120000
}

// ============================================================================
// Evaluators
// ============================================================================

export interface EvaluatorConfig {
  type: "code" | "llm-judge";
  // Code evaluator options
  assertions?: Assertion[];
  // LLM-judge options
  criteria?: string[];
  reference_free?: boolean; // Default: true
}

export type Assertion =
  | { type: "file_exists"; path: string }
  | { type: "file_contains"; path: string; pattern: string }
  | { type: "file_not_contains"; path: string; pattern: string }
  | { type: "tool_called"; name: string; args?: Record<string, unknown> }
  | { type: "tool_not_called"; name: string }
  | { type: "exit_code"; expected: number };

// ============================================================================
// OpenCode Event Stream (from opencode run --format json)
// ============================================================================

export interface OpenCodeEvent {
  type: "step_start" | "tool_use" | "text" | "step_finish";
  timestamp: number;
  sessionID: string;
  part: OpenCodeEventPart;
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

export interface ExampleResult {
  example_id: string;
  inputs: Example["inputs"];
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
}

export interface Feedback {
  key: string;
  score: number; // 0-1
  passed: boolean;
  comment?: string;
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
}

// ============================================================================
// CLI Options
// ============================================================================

export interface RunOptions {
  variant?: string;
  dryRun?: boolean;
  output?: string;
  verbose?: boolean;
}

export interface CompareOptions {
  format?: "json" | "markdown";
  output?: string;
}

export interface ReportOptions {
  format?: "json" | "markdown";
  output?: string;
}
