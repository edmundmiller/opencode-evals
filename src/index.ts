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
import {
  generateHealthReport,
  formatHealthReport,
  detectSaturation,
} from "./analysis.js";
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
  .option("-p, --parallel", "Enable parallel execution")
  .option("-c, --concurrency <number>", "Max concurrent examples (default: 4)", parseInt)
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
        parallel: options.parallel,
        concurrency: options.concurrency,
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

// Health command - analyze eval health and saturation
program
  .command("health <file>")
  .description("Analyze eval health, saturation, and grader quality")
  .option("-f, --format <type>", "Output format (json|markdown)", "markdown")
  .option("-o, --output <path>", "Output to file instead of stdout")
  .option("--pass-threshold <number>", "Pass rate threshold for saturation warning (default: 0.95)", parseFloat)
  .option("--variance-threshold <number>", "Variance threshold for low variance warning (default: 0.05)", parseFloat)
  .action(async (file: string, options) => {
    const experiments: Experiment[] = JSON.parse(await readFile(file, "utf-8"));

    if (experiments.length === 0) {
      console.error("No experiments found in file");
      process.exit(1);
    }

    // Check for immediate saturation warnings
    const latestExp = experiments[experiments.length - 1];
    const warnings = detectSaturation(latestExp, {
      high_pass_rate: options.passThreshold,
      low_variance: options.varianceThreshold,
    });

    if (warnings.length > 0) {
      console.log("\n⚠️  Saturation Warnings Detected:");
      for (const w of warnings) {
        console.log(`   - ${w.type}: ${w.message}`);
      }
      console.log("");
    }

    // Generate full health report
    const report = generateHealthReport(experiments, {
      high_pass_rate: options.passThreshold,
      low_variance: options.varianceThreshold,
    });

    let output: string;
    if (options.format === "json") {
      output = JSON.stringify(report, null, 2);
    } else {
      output = formatHealthReport(report);
    }

    if (options.output) {
      await writeFile(options.output, output, "utf-8");
      console.log(`Health report written to: ${options.output}`);
    } else {
      console.log(output);
    }

    // Exit with warning code if health is poor
    if (report.health_score < 0.5) {
      process.exit(2);
    }
  });

// Difficulty command - analyze example difficulty
program
  .command("difficulty <file>")
  .description("Analyze example difficulty and discrimination")
  .option("-f, --format <type>", "Output format (json|markdown|csv)", "markdown")
  .option("-o, --output <path>", "Output to file instead of stdout")
  .option("--sort <by>", "Sort by: pass_rate, variance, difficulty", "pass_rate")
  .action(async (file: string, options) => {
    const experiments: Experiment[] = JSON.parse(await readFile(file, "utf-8"));

    if (experiments.length === 0) {
      console.error("No experiments found in file");
      process.exit(1);
    }

    const report = generateHealthReport(experiments);
    const difficulties = Object.values(report.difficulty_scores);

    // Sort
    if (options.sort === "pass_rate") {
      difficulties.sort((a, b) => a.pass_rate - b.pass_rate);
    } else if (options.sort === "variance") {
      difficulties.sort((a, b) => b.score_variance - a.score_variance);
    } else if (options.sort === "difficulty") {
      const order = { very_hard: 0, hard: 1, medium: 2, easy: 3 };
      difficulties.sort((a, b) => order[a.difficulty] - order[b.difficulty]);
    }

    let output: string;
    if (options.format === "json") {
      output = JSON.stringify(difficulties, null, 2);
    } else if (options.format === "csv") {
      const lines = ["example_id,pass_rate,avg_score,variance,difficulty,discriminating"];
      for (const d of difficulties) {
        lines.push(`${d.example_id},${d.pass_rate.toFixed(3)},${d.avg_score.toFixed(3)},${d.score_variance.toFixed(4)},${d.difficulty},${d.is_discriminating}`);
      }
      output = lines.join("\n");
    } else {
      const lines: string[] = [];
      lines.push("# Example Difficulty Analysis");
      lines.push("");
      lines.push("| Example | Pass Rate | Avg Score | Variance | Difficulty | Discriminating |");
      lines.push("|---------|-----------|-----------|----------|------------|----------------|");
      for (const d of difficulties) {
        const disc = d.is_discriminating ? "Yes" : "No";
        lines.push(`| ${d.example_id} | ${(d.pass_rate * 100).toFixed(0)}% | ${(d.avg_score * 100).toFixed(0)}% | ${d.score_variance.toFixed(3)} | ${d.difficulty} | ${disc} |`);
      }
      lines.push("");

      // Summary
      const easyCount = difficulties.filter(d => d.difficulty === "easy").length;
      const discCount = difficulties.filter(d => d.is_discriminating).length;
      lines.push(`**Summary:** ${difficulties.length} examples, ${easyCount} easy (${((easyCount/difficulties.length)*100).toFixed(0)}%), ${discCount} discriminating (${((discCount/difficulties.length)*100).toFixed(0)}%)`);

      output = lines.join("\n");
    }

    if (options.output) {
      await writeFile(options.output, output, "utf-8");
      console.log(`Difficulty analysis written to: ${options.output}`);
    } else {
      console.log(output);
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
