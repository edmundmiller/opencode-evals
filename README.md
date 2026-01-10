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
```

### Comparing Results

```bash
opencode-eval compare results-baseline.json results-treatment.json
```

### Generating Reports

```bash
opencode-eval report results.json --format markdown
```

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
  }
}
```

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
