#!/usr/bin/env bun
import { Command } from "commander";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runEval } from "./runner.js";
import {
  writeJSONReport,
  generateMarkdownReport,
  generateComparisonReport,
} from "./reporter.js";
import { getFixturesDir } from "./sandbox.js";
import type { Experiment } from "./types.js";

const program = new Command();

program
  .name("opencode-eval")
  .description("Lightweight evaluation framework for OpenCode plugins")
  .version("0.1.0");

// Run command
program
  .command("run <path>")
  .description("Run eval(s) from a file or directory")
  .option("-v, --variant <name>", "Run only this variant")
  .option("-d, --dry-run", "Validate config without running OpenCode")
  .option("-o, --output <path>", "Output results to JSON file")
  .option("--verbose", "Show detailed output")
  .option("-t, --trials <number>", "Number of trials per example (overrides config)", parseInt)
  .option("--pass-criteria <type>", "Pass criteria: 'any' (pass@k) or 'all' (pass^k)", "any")
  .action(async (path: string, options) => {
    const resolvedPath = resolve(path);
    const evalFiles = await findEvalFiles(resolvedPath);

    if (evalFiles.length === 0) {
      console.error(`No eval files found at: ${resolvedPath}`);
      process.exit(1);
    }

    console.log(`🚀 Running ${evalFiles.length} eval(s)...`);

    const allExperiments: Experiment[] = [];

    for (const evalFile of evalFiles) {
      console.log(`\n📁 ${evalFile}`);
      const experiments = await runEval(evalFile, {
        variant: options.variant,
        dryRun: options.dryRun,
        verbose: options.verbose,
        trials: options.trials,
        pass_criteria: options.passCriteria as 'any' | 'all',
      });
      allExperiments.push(...experiments);
    }

    // Output results
    if (options.output) {
      await writeJSONReport(allExperiments, options.output);
      console.log(`\n📝 Results written to: ${options.output}`);
    }

    // Print final summary
    console.log("\n" + "=".repeat(50));
    console.log("📊 Final Summary");
    console.log("=".repeat(50));

    for (const exp of allExperiments) {
      const icon = exp.summary.pass_rate === 1 ? "✅" : "❌";
      let line = `${icon} ${exp.eval_name} [${exp.variant}]: ${exp.summary.passed}/${exp.summary.total_examples} passed`;
      
      // Add trial metrics if available
      if (exp.summary.trial_metrics) {
        const tm = exp.summary.trial_metrics;
        line += ` | pass@${tm.trials_per_example}: ${(tm.pass_at_k * 100).toFixed(0)}%`;
        line += ` | pass^${tm.trials_per_example}: ${(tm.pass_all_k * 100).toFixed(0)}%`;
        line += ` | consistency: ${(tm.consistency_rate * 100).toFixed(0)}%`;
      }
      
      console.log(line);
    }

    const totalPassed = allExperiments.reduce(
      (sum, e) => sum + e.summary.passed,
      0
    );
    const totalExamples = allExperiments.reduce(
      (sum, e) => sum + e.summary.total_examples,
      0
    );

    console.log("");
    console.log(`Total: ${totalPassed}/${totalExamples} passed`);

    // Exit with error if any failed
    if (totalPassed < totalExamples) {
      process.exit(1);
    }
  });

// Compare command
program
  .command("compare <file1> <file2>")
  .description("Compare two experiment result files")
  .option("-f, --format <type>", "Output format (json|markdown)", "markdown")
  .option("-o, --output <path>", "Output to file instead of stdout")
  .action(async (file1: string, file2: string, options) => {
    const exp1: Experiment[] = JSON.parse(await readFile(file1, "utf-8"));
    const exp2: Experiment[] = JSON.parse(await readFile(file2, "utf-8"));

    if (exp1.length === 0 || exp2.length === 0) {
      console.error("Both files must contain at least one experiment");
      process.exit(1);
    }

    // Compare first experiments from each file
    const report = generateComparisonReport(exp1[0], exp2[0]);

    if (options.output) {
      await writeFile(options.output, report, "utf-8");
      console.log(`Report written to: ${options.output}`);
    } else {
      console.log(report);
    }
  });

// Report command
program
  .command("report <file>")
  .description("Generate a report from experiment results")
  .option("-f, --format <type>", "Output format (json|markdown)", "markdown")
  .option("-o, --output <path>", "Output to file instead of stdout")
  .action(async (file: string, options) => {
    const experiments: Experiment[] = JSON.parse(await readFile(file, "utf-8"));

    let output: string;

    if (options.format === "json") {
      output = JSON.stringify(experiments, null, 2);
    } else {
      output = generateMarkdownReport(experiments);
    }

    if (options.output) {
      await writeFile(options.output, output, "utf-8");
      console.log(`Report written to: ${options.output}`);
    } else {
      console.log(output);
    }
  });

// Fixtures command
program
  .command("fixtures")
  .description("List available fixture templates")
  .action(async () => {
    const fixturesDir = getFixturesDir();

    try {
      const entries = await readdir(fixturesDir);
      console.log("Available fixtures:");
      for (const entry of entries) {
        console.log(`  - ${entry}`);
      }
    } catch {
      console.log("No fixtures directory found");
    }
  });

// Find eval files (*.eval.json)
async function findEvalFiles(path: string): Promise<string[]> {
  const stats = await stat(path);

  if (stats.isFile()) {
    if (path.endsWith(".eval.json")) {
      return [path];
    }
    return [];
  }

  if (stats.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = join(path, entry.name);

      if (entry.isFile() && entry.name.endsWith(".eval.json")) {
        files.push(fullPath);
      } else if (entry.isDirectory()) {
        const subFiles = await findEvalFiles(fullPath);
        files.push(...subFiles);
      }
    }

    return files;
  }

  return [];
}

program.parse();
