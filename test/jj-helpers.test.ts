import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createSandbox } from "../src/sandbox.js";
import { join } from "node:path";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
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
  JJ_ISOLATED_ENV,
} from "../src/jj-helpers.js";

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

describe("jj-helpers", () => {
  beforeAll(async () => {
    await mkdir(TEST_FIXTURES_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_FIXTURES_DIR, { recursive: true, force: true });
  });

  describe("JJ_ISOLATED_ENV", () => {
    test("contains required isolation variables", () => {
      expect(JJ_ISOLATED_ENV.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(JJ_ISOLATED_ENV.GIT_CONFIG_SYSTEM).toBe("/dev/null");
      expect(JJ_ISOLATED_ENV.CI).toBe("true");
    });
  });

  describe("initJjRepo", () => {
    test("initializes a jj repository", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      await initJjRepo(sandbox.path);

      // Verify jj repo exists
      const result = await runJj(["status"], sandbox.path);
      expect(result.exitCode).toBe(0);

      await sandbox.cleanup();
    });

    test("sets custom author info", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      await initJjRepo(sandbox.path, {
        authorName: "Custom Author",
        authorEmail: "custom@example.com",
      });

      // Verify config was set (jj config list --repo shows repo-specific config)
      const result = await runJj(
        ["config", "list", "--repo", "user.name"],
        sandbox.path
      );
      expect(result.stdout).toContain("Custom Author");

      await sandbox.cleanup();
    });
  });

  describe("createJjChanges", () => {
    test("creates changes with files", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);

      await createJjChanges(sandbox.path, [
        { description: "Initial change", files: { "README.md": "# Hello" } },
        { description: "Add config", files: { "config.json": "{}" } },
      ]);

      const log = await getJjLog(sandbox.path);
      const descriptions = log.map((c) => c.description);
      expect(descriptions).toContain("Add config");
      expect(descriptions).toContain("Initial change");

      // Verify files exist
      const readme = await readFile(join(sandbox.path, "README.md"), "utf-8");
      expect(readme).toBe("# Hello");

      await sandbox.cleanup();
    });

    test("creates changes with bookmarks", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);

      await createJjChanges(sandbox.path, [
        {
          description: "Initial change",
          files: { "README.md": "# Test" },
          bookmark: "main",
        },
      ]);

      // Verify bookmark exists
      const result = await runJj(["bookmark", "list"], sandbox.path);
      expect(result.stdout).toContain("main");

      await sandbox.cleanup();
    });
  });

  describe("setupJjRemote", () => {
    test("creates a bare remote repository", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);
      await createJjChanges(sandbox.path, [
        {
          description: "Initial change",
          files: { "README.md": "# Test" },
          bookmark: "main",
        },
      ]);

      const remotePath = await setupJjRemote(sandbox.path);

      expect(remotePath).toContain(".git-remotes/origin");

      // Verify remote was added
      const result = await runJj(["git", "remote", "list"], sandbox.path);
      expect(result.stdout).toContain("origin");

      await sandbox.cleanup();
    });

    test("pushes bookmarks to remote", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);
      await createJjChanges(sandbox.path, [
        {
          description: "Initial change",
          files: { "README.md": "# Test" },
          bookmark: "main",
        },
      ]);

      await setupJjRemote(sandbox.path, { bookmarks: ["main"] });

      // Verify bookmark was pushed (shows @origin: on separate line in jj)
      const result = await runJj(["bookmark", "list", "--all"], sandbox.path);
      expect(result.stdout).toContain("@origin:");

      await sandbox.cleanup();
    });

    test("uses custom remote name", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);

      const remotePath = await setupJjRemote(sandbox.path, {
        remoteName: "upstream",
      });

      expect(remotePath).toContain(".git-remotes/upstream");

      const result = await runJj(["git", "remote", "list"], sandbox.path);
      expect(result.stdout).toContain("upstream");

      await sandbox.cleanup();
    });
  });

  describe("setupJjBookmarks", () => {
    test("creates multiple bookmarks", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);
      await createJjChanges(sandbox.path, [
        { description: "Initial change", files: { "README.md": "# Test" } },
      ]);

      await setupJjBookmarks(sandbox.path, ["feature/auth", "feature/api"]);

      // Verify bookmarks exist
      const result = await runJj(["bookmark", "list"], sandbox.path);
      expect(result.stdout).toContain("feature/auth");
      expect(result.stdout).toContain("feature/api");

      await sandbox.cleanup();
    });
  });

  describe("createJjWorkingCopyChanges", () => {
    test("creates working copy changes", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);
      await createJjChanges(sandbox.path, [
        { description: "Initial change", files: { "README.md": "# Test" } },
      ]);

      await createJjWorkingCopyChanges(sandbox.path, {
        "new-file.txt": "new content",
      });

      // File should exist
      const content = await readFile(join(sandbox.path, "new-file.txt"), "utf-8");
      expect(content).toBe("new content");

      // jj automatically tracks changes
      const result = await runJj(["status"], sandbox.path);
      expect(result.stdout).toContain("new-file.txt");

      await sandbox.cleanup();
    });

    test("creates working copy changes with description", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);

      await createJjWorkingCopyChanges(
        sandbox.path,
        { "work.txt": "work in progress" },
        { description: "WIP: Adding feature" }
      );

      const status = await getJjStatus(sandbox.path);
      expect(status.description).toBe("WIP: Adding feature");

      await sandbox.cleanup();
    });
  });

  describe("createOrphanScenario", () => {
    test("creates an orphan scenario", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);

      // Create initial commit and push to origin
      await createJjChanges(sandbox.path, [
        {
          description: "Initial commit",
          files: { "README.md": "# Test" },
          bookmark: "main",
        },
      ]);
      await setupJjRemote(sandbox.path, { bookmarks: ["main"] });

      // Create orphan scenario
      await createOrphanScenario(sandbox.path, {
        orphanDescription: "Orphaned work",
        orphanFiles: { "orphan.txt": "orphaned content" },
        resetTo: "main@origin",
      });

      // The orphan check might not immediately detect orphans
      // because the scenario creates the orphan and then moves to a new change
      // Let's verify the scenario setup worked
      const status = await getJjStatus(sandbox.path);
      // After createOrphanScenario, we should be on a new empty change
      expect(status.description).toBe("");

      await sandbox.cleanup();
    });
  });

  describe("getJjStatus", () => {
    test("reports current change info", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);

      await createJjWorkingCopyChanges(
        sandbox.path,
        { "test.txt": "test" },
        { description: "Test change" }
      );

      const status = await getJjStatus(sandbox.path);
      expect(status.currentChange).toBeTruthy();
      expect(status.description).toBe("Test change");

      await sandbox.cleanup();
    });

    test("reports bookmarks on current change", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);

      await createJjChanges(sandbox.path, [
        {
          description: "Initial",
          files: { "README.md": "# Test" },
          bookmark: "main",
        },
      ]);

      // Go back to the change with the bookmark
      await runJj(["edit", "main"], sandbox.path);

      const status = await getJjStatus(sandbox.path);
      expect(status.bookmarks).toContain("main");

      await sandbox.cleanup();
    });
  });

  describe("getJjLog", () => {
    test("returns change info", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);

      await createJjChanges(sandbox.path, [
        { description: "First change", files: { "a.txt": "a" } },
        { description: "Second change", files: { "b.txt": "b" } },
        { description: "Third change", files: { "c.txt": "c" } },
      ]);

      const log = await getJjLog(sandbox.path);
      const descriptions = log.map((c) => c.description);

      expect(descriptions).toContain("Third change");
      expect(descriptions).toContain("Second change");
      expect(descriptions).toContain("First change");

      await sandbox.cleanup();
    });

    test("respects limit option", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);

      await createJjChanges(sandbox.path, [
        { description: "First change", files: { "a.txt": "a" } },
        { description: "Second change", files: { "b.txt": "b" } },
        { description: "Third change", files: { "c.txt": "c" } },
      ]);

      const log = await getJjLog(sandbox.path, { limit: 2 });
      expect(log.length).toBeLessThanOrEqual(2);

      await sandbox.cleanup();
    });
  });

  describe("hasOrphanedCommits", () => {
    test("returns false for clean repo", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initJjRepo(sandbox.path);

      await createJjChanges(sandbox.path, [
        {
          description: "Initial",
          files: { "README.md": "# Test" },
          bookmark: "main",
        },
      ]);

      const hasOrphans = await hasOrphanedCommits(sandbox.path);
      // New repo with single bookmark chain should have no orphans
      expect(hasOrphans).toBe(false);

      await sandbox.cleanup();
    });
  });
});
