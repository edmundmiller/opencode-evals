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

## Assertion Types

| Type | Description |
|------|-------------|
| `file_exists` | Check if a file exists |
| `file_contains` | Check if file matches a regex pattern |
| `file_not_contains` | Check if file does NOT match a pattern |
| `tool_called` | Check if a specific tool was invoked |
| `tool_not_called` | Check if a tool was NOT invoked |
| `exit_code` | Check the exit code |

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
