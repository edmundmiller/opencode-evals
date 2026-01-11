import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createSandbox } from "../src/sandbox.js";
import { join } from "node:path";
import { mkdir, rm, readFile } from "node:fs/promises";
import { JJ_ISOLATED_ENV, getJjStatus, getJjLog } from "../src/jj-helpers.js";

const TEST_FIXTURES_DIR = join(import.meta.dir, "fixtures");

// Helper to run jj commands
async function runJj(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["jj", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...JJ_ISOLATED_ENV },
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { stdout, stderr, exitCode };
}

describe("jj sandbox integration", () => {
  beforeAll(async () => {
    await mkdir(TEST_FIXTURES_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_FIXTURES_DIR, { recursive: true, force: true });
  });

  describe("declarative jj setup via createSandbox", () => {
    test("creates jj repo with basic init", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            jj: {
              init: true,
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // Verify jj repo exists
      const result = await runJj(["status"], sandbox.path);
      expect(result.exitCode).toBe(0);

      await sandbox.cleanup();
    });

    test("creates jj repo with custom author", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            jj: {
              authorName: "Eval Author",
              authorEmail: "eval@test.com",
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // Check repo config file directly
      const configPath = join(sandbox.path, ".jj/repo/config.toml");
      const config = await readFile(configPath, "utf-8");
      expect(config).toContain("Eval Author");

      await sandbox.cleanup();
    });

    test("creates jj repo with changes", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            jj: {
              changes: [
                {
                  description: "Initial commit",
                  files: { "README.md": "# Test Project" },
                },
                {
                  description: "Add configuration",
                  files: { "config.json": '{"key": "value"}' },
                },
              ],
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // Verify files exist
      const readme = await readFile(join(sandbox.path, "README.md"), "utf-8");
      expect(readme).toBe("# Test Project");

      const config = await readFile(join(sandbox.path, "config.json"), "utf-8");
      expect(config).toBe('{"key": "value"}');

      // Verify changes in log
      const log = await getJjLog(sandbox.path);
      const descriptions = log.map((c) => c.description);
      expect(descriptions).toContain("Add configuration");
      expect(descriptions).toContain("Initial commit");

      await sandbox.cleanup();
    });

    test("creates jj repo with bookmarks", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            jj: {
              changes: [
                {
                  description: "Initial commit",
                  files: { "README.md": "# Test" },
                  bookmark: "main",
                },
              ],
              bookmarks: ["develop", "feature/test"],
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      const result = await runJj(["bookmark", "list"], sandbox.path);
      expect(result.stdout).toContain("main");
      expect(result.stdout).toContain("develop");
      expect(result.stdout).toContain("feature/test");

      await sandbox.cleanup();
    });

    test("creates jj repo with remote", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            jj: {
              changes: [
                {
                  description: "Initial commit",
                  files: { "README.md": "# Test" },
                  bookmark: "main",
                },
              ],
              remote: {
                name: "origin",
                bookmarks: ["main"],
              },
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // Verify remote exists
      const remoteResult = await runJj(["git", "remote", "list"], sandbox.path);
      expect(remoteResult.stdout).toContain("origin");

      // Verify bookmark was pushed (shows @origin: on separate line in jj)
      const bookmarkResult = await runJj(
        ["bookmark", "list", "--all"],
        sandbox.path
      );
      expect(bookmarkResult.stdout).toContain("@origin:");

      await sandbox.cleanup();
    });

    test("creates jj repo with working copy changes", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            jj: {
              changes: [
                {
                  description: "Initial commit",
                  files: { "README.md": "# Test" },
                },
              ],
              workingCopy: {
                files: { "wip.txt": "work in progress" },
                description: "WIP: Adding feature",
              },
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // Verify working copy file exists
      const wip = await readFile(join(sandbox.path, "wip.txt"), "utf-8");
      expect(wip).toBe("work in progress");

      // Verify current change description
      const status = await getJjStatus(sandbox.path);
      expect(status.description).toBe("WIP: Adding feature");

      await sandbox.cleanup();
    });

    test("creates jj repo with orphan scenario", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            jj: {
              changes: [
                {
                  description: "Initial commit",
                  files: { "README.md": "# Test" },
                  bookmark: "main",
                },
              ],
              remote: {
                name: "origin",
                bookmarks: ["main"],
              },
              orphan: {
                description: "Orphaned work",
                files: { "orphan.txt": "orphaned content" },
                resetTo: "main@origin",
              },
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // After orphan scenario, we should be on a new empty change
      const status = await getJjStatus(sandbox.path);
      expect(status.description).toBe("");

      // The orphan file should exist from when it was created
      // (the orphan scenario creates the file, describes the change,
      // then resets to main@origin)
      // Actually, after reset, the orphan file won't be in working copy

      await sandbox.cleanup();
    });

    test("combines files and vcs setup", async () => {
      const sandbox = await createSandbox(
        {
          files: {
            "src/index.ts": 'console.log("hello");',
            "package.json": '{"name": "test"}',
          },
          vcs: {
            jj: {
              changes: [
                {
                  description: "Add source files",
                  files: { "src/lib.ts": "export const x = 1;" },
                },
              ],
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // Both files from setup.files and setup.vcs should exist
      const index = await readFile(join(sandbox.path, "src/index.ts"), "utf-8");
      expect(index).toBe('console.log("hello");');

      const lib = await readFile(join(sandbox.path, "src/lib.ts"), "utf-8");
      expect(lib).toBe("export const x = 1;");

      await sandbox.cleanup();
    });

    test("creates orphan-recovery scenario matching opencode-jj eval", async () => {
      // This matches the setup from opencode-jj/evals/orphan-recovery.eval.json
      const sandbox = await createSandbox(
        {
          files: {
            "src/feature.ts": "export function feature() {}",
          },
          vcs: {
            jj: {
              authorName: "Test User",
              authorEmail: "test@example.com",
              changes: [
                {
                  description: "Initial setup with feature",
                  files: { "README.md": "# Orphan Recovery Test" },
                  bookmark: "main",
                },
              ],
              remote: {
                name: "origin",
                bookmarks: ["main"],
              },
              orphan: {
                description: "Important work that got orphaned",
                files: { "src/important.ts": "// Important work" },
                resetTo: "main@origin",
              },
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // Verify the setup matches what opencode-jj evals expect
      const remoteResult = await runJj(["git", "remote", "list"], sandbox.path);
      expect(remoteResult.stdout).toContain("origin");

      const bookmarkResult = await runJj(
        ["bookmark", "list", "--all"],
        sandbox.path
      );
      expect(bookmarkResult.stdout).toContain("@origin:");

      // We're on a fresh change based on main@origin
      const status = await getJjStatus(sandbox.path);
      expect(status.description).toBe("");

      await sandbox.cleanup();
    });
  });
});
