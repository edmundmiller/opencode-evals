# opencode-evals

Lightweight evaluation framework for OpenCode plugins.

## Installation

```bash
bun add -D opencode-evals
```

## Usage

### Running Evals

```bash
# Run all evals in a directory
opencode-eval run evals/

# Run a specific eval file
opencode-eval run evals/my-eval.eval.json

# Run only a specific variant
opencode-eval run evals/ --variant jj

# Dry run (validate config only)
opencode-eval run evals/ --dry-run

# Output results to JSON
opencode-eval run evals/ --output results.json

# Run multiple trials per example (for non-deterministic agents)
opencode-eval run evals/ --trials 3

# Use pass^k criteria (all trials must pass)
opencode-eval run evals/ --trials 3 --pass-criteria all
```

### Validating Reference Outputs

```bash
# Validate reference outputs in evals
opencode-eval validate-references evals/

# Include LLM judge evaluators
opencode-eval validate-references evals/ --include-llm

# Fail if any eval lacks references
opencode-eval validate-references evals/ --require-references
```

### Comparing Results

```bash
opencode-eval compare results-baseline.json results-treatment.json
```

### Generating Reports

```bash
opencode-eval report results.json --format markdown
```

## Handling Non-Determinism

AI agents are inherently non-deterministic. Running the same task multiple times may produce different results. This framework supports multi-trial evaluation to handle this:

### Multi-Trial Configuration

```jsonc
{
  "name": "my-eval",
  "trials": 3,              // Run each example 3 times
  "save_transcripts": true, // Save full conversation logs
  "transcript_dir": ".evals/transcripts",
  // ... rest of config
}
```

### Pass Criteria

- **pass@k** (default): Example passes if *at least one* trial succeeds
- **pass^k**: Example passes only if *all* trials succeed

Use `--pass-criteria all` for stricter evaluation.

### Trial Metrics

When running multiple trials, you get additional metrics:

| Metric | Description |
|--------|-------------|
| pass@k | Fraction of examples where at least 1 trial passed |
| pass^k | Fraction of examples where ALL trials passed |
| Avg Trial Pass Rate | Average pass rate across all trials |
| Consistency Rate | Fraction of examples with consistent results |
| Inconsistent Examples | Count of examples where some trials pass, some fail |

### Best Practices

- **Start with 1 trial** for fast iteration during development
- **Use 3-5 trials** for final evaluation of non-deterministic agents
- **Use pass^k** when consistency is critical
- **Review transcripts** of inconsistent examples to understand failure modes

## Parallel Execution

Speed up eval runs by executing examples and trials concurrently:

```bash
# Enable parallel execution
opencode-eval run evals/ --parallel

# Set concurrency level (default: 4)
opencode-eval run evals/ --parallel --concurrency 8

# Combine with trials for fast non-determinism testing
opencode-eval run evals/ --parallel --trials 3
```

### Parallel Configuration

```jsonc
{
  "name": "my-eval",
  "parallel": {
    "enabled": true,
    "max_examples": 4,    // Max concurrent examples
    "max_trials": 2,      // Max concurrent trials per example
    "stagger_ms": 100     // Delay between task starts
  }
}
```

### Parallel Execution Tips

- **Resource contention**: Set `stagger_ms` to reduce simultaneous API calls
- **Rate limits**: Lower concurrency if hitting API rate limits
- **Debugging**: Disable parallel (`--parallel=false`) when investigating failures
- **CI/CD**: Use higher concurrency in CI where resources are abundant

## Eval Health & Saturation Detection

Monitor eval quality and detect when evals become too easy:

```bash
# Analyze eval health
opencode-eval health results.json

# Output as JSON
opencode-eval health results.json --format json

# Custom thresholds
opencode-eval health results.json --pass-threshold 0.90 --variance-threshold 0.10
```

### Saturation Warnings

The framework detects common eval issues:

| Warning | Description | Recommendation |
|---------|-------------|----------------|
| `high_pass_rate` | Pass rate exceeds threshold (default: 95%) | Add harder examples or stricter criteria |
| `low_variance` | Score variance too low | Add examples with varying difficulty |
| `non_discriminating` | All examples pass or all fail | Check grading logic, add edge cases |

### Health Report

The `health` command generates a comprehensive report including:

- **Overall health score** (0-100%)
- **Saturation warnings** with recommendations
- **Grader validation** (detects always-pass/fail graders)
- **Difficulty distribution** across examples

## Difficulty Analysis

Analyze example difficulty to balance your eval set:

```bash
# Markdown table of difficulty scores
opencode-eval difficulty results.json

# Sort by pass rate (easiest first)
opencode-eval difficulty results.json --sort pass_rate

# Export as CSV for spreadsheet analysis
opencode-eval difficulty results.json --format csv --output difficulty.csv
```

### Difficulty Metrics

| Metric | Description |
|--------|-------------|
| Pass Rate | Fraction of runs where example passed |
| Avg Score | Average normalized score across runs |
| Variance | Score variance (higher = more variable) |
| Difficulty | Label: easy/medium/hard/very_hard |
| Discriminating | Whether example separates good from bad outputs |

### Maintenance Best Practices

Based on [Anthropic's eval guidelines](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents):

1. **Monitor saturation**: Run `health` regularly; add harder examples when pass rate > 90%
2. **Balance difficulty**: Aim for mix of easy (sanity checks), medium, and hard examples
3. **Maximize discrimination**: Focus on examples where some approaches succeed and others fail
4. **Validate graders**: Check for graders that always pass or always fail
5. **Convert failures to evals**: When agents fail in production, add those cases as new examples

## Eval Config Format

```jsonc
{
  "name": "my-eval",
  "description": "Description of what this eval tests",
  "dataset": {
    "name": "my-dataset",
    "examples": [
      {
        "id": "example-1",
        "inputs": {
          "query": "The prompt to send to OpenCode",
          "files": {
            "src/app.ts": "// Initial file content"
          }
        }
      }
    ]
  },
  "variants": {
    "baseline": { "plugins": [] },
    "treatment": { "plugins": ["my-plugin"] }
  },
  "setup": {
    "template": "simple-ts",
    "commands": {
      "baseline": ["git init"],
      "treatment": ["jj git init"]
    }
  },
  "evaluators": [
    {
      "type": "code",
      "assertions": [
        { "type": "file_exists", "path": "src/app.ts" },
        { "type": "file_contains", "path": "src/app.ts", "pattern": "function" },
        { "type": "exit_code", "expected": 0 }
      ]
    },
    {
      "type": "llm-judge",
      "criteria": [
        "The function was implemented correctly",
        "Proper TypeScript types were used"
      ]
    }
  ],
  "error_handling": {
    "on_error": "continue",
    "retry_count": 1,
    "timeout_ms": 120000
  },
  // Multi-trial options (optional)
  "trials": 3,              // Number of trials per example (default: 1)
  "save_transcripts": true, // Save conversation logs for analysis
  "transcript_dir": ".evals/transcripts"
}
```

## VCS Setup

For evals that test git/version control workflows, use the `vcs` configuration to set up isolated repositories with commits, branches, and remotes.

### Basic Git Setup

```jsonc
{
  "setup": {
    "vcs": {
      "git": {
        "commits": [
          { "message": "Initial commit", "files": { "README.md": "# Hello" } }
        ]
      }
    }
  }
}
```

### Full Git Configuration

```jsonc
{
  "setup": {
    "vcs": {
      "git": {
        "defaultBranch": "main",
        "authorName": "Test User",
        "authorEmail": "test@example.com",
        "commits": [
          { "message": "Initial commit", "files": { "README.md": "# Project" } },
          { "message": "Add feature", "files": { "src/feature.ts": "export {}" } }
        ],
        "branches": ["develop", "feature/auth"],
        "checkout": "develop",
        "remote": {
          "name": "origin",
          "branches": ["main"]
        },
        "uncommitted": {
          "files": { "wip.txt": "work in progress" },
          "staged": true
        }
      }
    }
  }
}
```

### VCS Helper Functions

For advanced scenarios, import helper functions directly:

```typescript
import {
  initGitRepo,
  setupGitRemote,
  createCommitHistory,
  setupGitBranches,
  createUncommittedChanges,
  createMergeConflict,
  getGitStatus,
  getGitLog,
} from "opencode-evals/vcs-helpers";
```

### Git Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `init` | boolean | Initialize git repo (auto-detected if other options set) |
| `defaultBranch` | string | Default branch name (default: "main") |
| `authorName` | string | Commit author name (default: "Test User") |
| `authorEmail` | string | Commit author email (default: "test@example.com") |
| `commits` | array | Commits to create in order |
| `branches` | string[] | Branches to create |
| `checkout` | string | Branch to checkout after setup |
| `remote` | object | Remote repository configuration |
| `uncommitted` | object | Uncommitted changes to create |

## JJ (Jujutsu) Setup

For evals that test jj workflows, use the `vcs.jj` configuration to set up isolated jj repositories.

### Basic JJ Setup

```jsonc
{
  "setup": {
    "vcs": {
      "jj": {
        "changes": [
          { "description": "Initial commit", "files": { "README.md": "# Hello" } }
        ]
      }
    }
  }
}
```

### Full JJ Configuration

```jsonc
{
  "setup": {
    "vcs": {
      "jj": {
        "authorName": "Test User",
        "authorEmail": "test@example.com",
        "changes": [
          { "description": "Initial commit", "files": { "README.md": "# Project" }, "bookmark": "main" },
          { "description": "Add feature", "files": { "src/feature.ts": "export {}" } }
        ],
        "bookmarks": ["develop"],
        "remote": {
          "name": "origin",
          "bookmarks": ["main"]
        },
        "workingCopy": {
          "files": { "wip.txt": "work in progress" },
          "description": "WIP: Adding feature"
        }
      }
    }
  }
}
```

### Orphan Recovery Scenario

For testing jj orphan recovery workflows:

```jsonc
{
  "setup": {
    "vcs": {
      "jj": {
        "changes": [
          { "description": "Initial commit", "files": { "README.md": "# Test" }, "bookmark": "main" }
        ],
        "remote": { "name": "origin", "bookmarks": ["main"] },
        "orphan": {
          "description": "Important work that got orphaned",
          "files": { "src/important.ts": "// Important work" },
          "resetTo": "main@origin"
        }
      }
    }
  }
}
```

### JJ Helper Functions

For advanced scenarios, import helper functions directly:

```typescript
import {
  initJjRepo,
  setupJjRemote,
  createJjChanges,
  setupJjBookmarks,
  createJjWorkingCopyChanges,
  createOrphanScenario,
  getJjStatus,
  getJjLog,
  hasOrphanedCommits,
} from "opencode-evals/jj-helpers";
```

### JJ Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `init` | boolean | Initialize jj repo (auto-detected if other options set) |
| `authorName` | string | Change author name (default: "Test User") |
| `authorEmail` | string | Change author email (default: "test@example.com") |
| `changes` | array | Changes to create in order |
| `bookmarks` | string[] | Bookmarks to create |
| `newChange` | boolean | Start a new empty change after setup |
| `remote` | object | Remote repository configuration |
| `workingCopy` | object | Working copy changes to create |
| `orphan` | object | Orphan scenario configuration |

## Rubric-Based Grading

For nuanced evaluation, use structured rubrics instead of simple pass/fail criteria:

```jsonc
{
  "evaluators": [
    {
      "type": "llm-judge",
      "rubric": [
        {
          "name": "correctness",
          "description": "Does the code correctly implement the requested functionality?",
          "weight": 2.0,
          "levels": [
            { "score": 0, "label": "None", "description": "No attempt or completely wrong" },
            { "score": 1, "label": "Poor", "description": "Major bugs or missing functionality" },
            { "score": 2, "label": "Fair", "description": "Partial implementation with issues" },
            { "score": 3, "label": "Good", "description": "Works correctly with minor issues" },
            { "score": 4, "label": "Excellent", "description": "Fully correct and handles edge cases" }
          ]
        },
        {
          "name": "code_quality",
          "description": "Is the code clean, readable, and well-structured?",
          "weight": 1.0
        }
      ]
    }
  ]
}
```

### Rubric Features

- **Weighted scoring**: Assign different weights to criteria (e.g., correctness 2x more important than style)
- **Granular levels**: 0-4 scale with descriptions for consistent grading
- **Default levels**: If `levels` is omitted, uses standard None/Poor/Fair/Good/Excellent scale
- **Partial credit**: Scores are normalized and weighted for final aggregate score

## Assertion Types

### Basic Assertions

| Type | Description |
|------|-------------|
| `file_exists` | Check if a file exists |
| `file_contains` | Check if file matches a regex pattern |
| `file_not_contains` | Check if file does NOT match a pattern |
| `tool_called` | Check if a specific tool was invoked |
| `tool_not_called` | Check if a tool was NOT invoked |
| `exit_code` | Check the exit code |
| `environment_var` | Validate environment variables by name/value |
| `process_running` | Verify a process is running by name |

### Advanced Code Graders

| Type | Description |
|------|-------------|
| `no_lint_errors` | Run ESLint and check for errors |
| `no_type_errors` | Run TypeScript compiler and check for type errors |
| `no_security_issues` | Scan for hardcoded secrets, API keys, etc. |
| `tool_call_sequence` | Deprecated: avoid sequencing tools; use outcome-based assertions instead |
| `performance` | Check metrics like tool call count against thresholds |

`tool_call_sequence` is deprecated because it rewards specific tool ordering instead of results. Prefer assertions that validate end state (files, exit codes, performance) or rubric-based grading.

### Weighted Assertions

All assertions support an optional `weight` parameter for partial credit:

```jsonc
{
  "type": "code",
  "assertions": [
    { "type": "file_exists", "path": "src/index.ts", "weight": 1.0 },
    { "type": "no_type_errors", "weight": 2.0 },
    { "type": "no_lint_errors", "weight": 0.5 },
    { "type": "file_contains", "path": "README.md", "pattern": "Usage", "weight": 1.0 },
    { "type": "performance", "metric": "tool_calls", "max": 10, "weight": 0.5 }
  ]
}
```

## Human Grading Workflow

For high-stakes evaluations, combine LLM judges with human review:

### Export Tasks for Human Review

```bash
# Export all examples for review
opencode-eval export-review results.json --output-dir reviews/

# Export only failed examples
opencode-eval export-review results.json --failed-only

# Random sample for spot-checking
opencode-eval export-review results.json --sample 50 --seed 42

# Export as CSV for spreadsheet review
opencode-eval export-review results.json --format csv
```

### Import Human Reviews

```bash
# Import completed reviews and calculate agreement
opencode-eval import-review reviews/completed.json results.json

# Output as markdown report
opencode-eval import-review reviews/completed.json results.json -o agreement.md
```

### Calibrate LLM Judge

```bash
# Compare LLM grades against human grades
opencode-eval calibrate reviews/completed.json results.json

# Specify the judge model
opencode-eval calibrate reviews.json results.json --model claude-3-opus-20240229
```

### Inter-Rater Agreement Metrics

The framework calculates:

| Metric | Description | Good Value |
|--------|-------------|------------|
| Cohen's Kappa | Pass/fail agreement | > 0.6 |
| Score Correlation | Numeric score correlation | > 0.7 |
| Avg Score Difference | Mean absolute difference | < 0.5 |
| Exact Match Rate | Identical scores | > 50% |

### Best Practices

1. **Start with samples**: Export 20-50 examples for initial calibration
2. **Use multiple reviewers**: Calculate agreement before trusting a single reviewer
3. **Calibrate regularly**: Re-calibrate LLM judges when criteria change
4. **Document anchors**: Provide score-level descriptions for consistency

## Production Monitoring

Monitor production quality and convert failures to eval cases:

### Convert Failures to Evals

```bash
# Parse production logs and create eval examples from failures
opencode-eval failures-to-evals production.ndjson -o new-evals.json

# Only high-confidence failures
opencode-eval failures-to-evals production.ndjson --min-confidence 0.8

# Include abandoned sessions
opencode-eval failures-to-evals production.ndjson --include-abandoned

# Limit output
opencode-eval failures-to-evals production.ndjson --max-examples 100
```

### Detect Regressions

```bash
# Compare current results against baseline
opencode-eval regression baseline.json current.json

# Custom thresholds
opencode-eval regression baseline.json current.json \
  --warning-threshold 0.05 \
  --critical-threshold 0.15
```

Regression alerts:

| Alert Type | Trigger | Exit Code |
|------------|---------|-----------|
| `pass_rate_drop` | Pass rate decreases | 1 if critical |
| `score_decline` | Average score drops | 1 if critical |
| `latency_increase` | Response time increases | 1 if critical |
| `cost_increase` | Token costs increase | 1 if critical |

### Quality Dashboard

```bash
# Generate quality dashboard
opencode-eval dashboard results.json

# Last 7 days only
opencode-eval dashboard results.json --days 7

# Export as JSON for integration
opencode-eval dashboard results.json --format json -o dashboard.json
```

Dashboard includes:
- Summary metrics (success rate, avg score, latency, cost)
- Trend charts over time
- Active regression alerts
- Top failure categories

### CI/CD Integration

```yaml
# GitHub Actions example
- name: Run Evals
  run: opencode-eval run evals/ -o results.json

- name: Check for Regressions
  run: opencode-eval regression baseline.json results.json

- name: Update Baseline (on main)
  if: github.ref == 'refs/heads/main'
  run: cp results.json baseline.json
```

### Production Log Format

The `failures-to-evals` command expects NDJSON format:

```jsonc
{"sessionID": "abc123", "type": "user_message", "query": "Fix the bug", "timestamp": 1234567890}
{"sessionID": "abc123", "type": "tool_use", "name": "read", "timestamp": 1234567891}
{"sessionID": "abc123", "type": "user_feedback", "thumbs": "down", "timestamp": 1234567900}
```

## Plugin Usage

Add as a dev dependency to your plugin:

```jsonc
// package.json
{
  "devDependencies": {
    "opencode-evals": "^0.1.0"
  },
  "scripts": {
    "eval": "opencode-eval run evals/"
  }
}
```

Then run:

```bash
bun run eval
```

## Development

```bash
# Run unit tests
bun test

# Run example evals (dogfooding)
bun run eval

# Build
bun run build
```

## License

MIT
