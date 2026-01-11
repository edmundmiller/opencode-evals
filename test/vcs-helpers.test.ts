import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createSandbox } from "../src/sandbox.js";
import { join } from "node:path";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import {
  initGitRepo,
  setupGitRemote,
  createCommitHistory,
  setupGitBranches,
  createUncommittedChanges,
  createMergeConflict,
  getGitStatus,
  getGitLog,
  GIT_ISOLATED_ENV,
} from "../src/vcs-helpers.js";

const TEST_FIXTURES_DIR = join(import.meta.dir, "fixtures");

describe("vcs-helpers", () => {
  beforeAll(async () => {
    await mkdir(TEST_FIXTURES_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_FIXTURES_DIR, { recursive: true, force: true });
  });

  describe("GIT_ISOLATED_ENV", () => {
    test("contains required isolation variables", () => {
      expect(GIT_ISOLATED_ENV.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(GIT_ISOLATED_ENV.GIT_CONFIG_SYSTEM).toBe("/dev/null");
      expect(GIT_ISOLATED_ENV.GIT_TERMINAL_PROMPT).toBe("0");
      expect(GIT_ISOLATED_ENV.CI).toBe("true");
    });
  });

  describe("initGitRepo", () => {
    test("initializes a git repository", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      await initGitRepo(sandbox.path);

      const status = await getGitStatus(sandbox.path);
      expect(status.branch).toBe("main");
      expect(status.clean).toBe(true);

      await sandbox.cleanup();
    });

    test("uses custom default branch", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      await initGitRepo(sandbox.path, { defaultBranch: "master" });

      const status = await getGitStatus(sandbox.path);
      expect(status.branch).toBe("master");

      await sandbox.cleanup();
    });

    test("sets custom author info", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      await initGitRepo(sandbox.path, {
        authorName: "Custom Author",
        authorEmail: "custom@example.com",
      });

      // Verify config was set
      const proc = Bun.spawn(["git", "config", "user.name"], {
        cwd: sandbox.path,
        stdout: "pipe",
      });
      await proc.exited;
      const name = await new Response(proc.stdout).text();
      expect(name.trim()).toBe("Custom Author");

      await sandbox.cleanup();
    });
  });

  describe("createCommitHistory", () => {
    test("creates commits with files", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);

      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Hello" } },
        { message: "Add config", files: { "config.json": "{}" } },
      ]);

      const log = await getGitLog(sandbox.path);
      expect(log).toContain("Add config");
      expect(log).toContain("Initial commit");

      // Verify files exist
      const readme = await readFile(join(sandbox.path, "README.md"), "utf-8");
      expect(readme).toBe("# Hello");

      await sandbox.cleanup();
    });

    test("creates commits on specific branches", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);

      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Hello" } },
        { message: "Feature work", files: { "feature.ts": "export {}" }, branch: "feature" },
      ]);

      // Should be on feature branch now
      const status = await getGitStatus(sandbox.path);
      expect(status.branch).toBe("feature");

      // Feature file should exist
      const feature = await readFile(join(sandbox.path, "feature.ts"), "utf-8");
      expect(feature).toBe("export {}");

      await sandbox.cleanup();
    });

    test("supports custom author per commit", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);

      await createCommitHistory(sandbox.path, [
        {
          message: "Commit by Alice",
          files: { "alice.txt": "alice" },
          authorName: "Alice",
          authorEmail: "alice@example.com",
        },
      ]);

      // Verify author
      const proc = Bun.spawn(["git", "log", "-1", "--format=%an"], {
        cwd: sandbox.path,
        stdout: "pipe",
        env: { ...process.env, ...GIT_ISOLATED_ENV },
      });
      await proc.exited;
      const author = await new Response(proc.stdout).text();
      expect(author.trim()).toBe("Alice");

      await sandbox.cleanup();
    });
  });

  describe("setupGitRemote", () => {
    test("creates a bare remote repository", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Test" } },
      ]);

      const remotePath = await setupGitRemote(sandbox.path);

      expect(remotePath).toContain(".git-remotes/origin");

      // Verify remote was added
      const proc = Bun.spawn(["git", "remote", "-v"], {
        cwd: sandbox.path,
        stdout: "pipe",
        env: { ...process.env, ...GIT_ISOLATED_ENV },
      });
      await proc.exited;
      const remotes = await new Response(proc.stdout).text();
      expect(remotes).toContain("origin");

      await sandbox.cleanup();
    });

    test("allows push to remote", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Test" } },
      ]);

      await setupGitRemote(sandbox.path, { branches: ["main"] });

      // Should be able to push
      const proc = Bun.spawn(["git", "push", "origin", "main"], {
        cwd: sandbox.path,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...GIT_ISOLATED_ENV },
      });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      await sandbox.cleanup();
    });

    test("uses custom remote name", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Test" } },
      ]);

      const remotePath = await setupGitRemote(sandbox.path, {
        remoteName: "upstream",
      });

      expect(remotePath).toContain(".git-remotes/upstream");

      const proc = Bun.spawn(["git", "remote"], {
        cwd: sandbox.path,
        stdout: "pipe",
        env: { ...process.env, ...GIT_ISOLATED_ENV },
      });
      await proc.exited;
      const remotes = await new Response(proc.stdout).text();
      expect(remotes).toContain("upstream");

      await sandbox.cleanup();
    });
  });

  describe("setupGitBranches", () => {
    test("creates multiple branches", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Test" } },
      ]);

      await setupGitBranches(sandbox.path, ["feature/auth", "feature/api"]);

      // Verify branches exist
      const proc = Bun.spawn(["git", "branch"], {
        cwd: sandbox.path,
        stdout: "pipe",
        env: { ...process.env, ...GIT_ISOLATED_ENV },
      });
      await proc.exited;
      const branches = await new Response(proc.stdout).text();
      expect(branches).toContain("feature/auth");
      expect(branches).toContain("feature/api");

      await sandbox.cleanup();
    });

    test("checks out specified branch", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Test" } },
      ]);

      await setupGitBranches(sandbox.path, ["develop", "feature"], {
        checkout: "develop",
      });

      const status = await getGitStatus(sandbox.path);
      expect(status.branch).toBe("develop");

      await sandbox.cleanup();
    });
  });

  describe("createUncommittedChanges", () => {
    test("creates unstaged changes", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Test" } },
      ]);

      await createUncommittedChanges(sandbox.path, {
        "new-file.txt": "new content",
      });

      const status = await getGitStatus(sandbox.path);
      expect(status.untracked).toContain("new-file.txt");

      await sandbox.cleanup();
    });

    test("creates staged changes", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Test" } },
      ]);

      await createUncommittedChanges(
        sandbox.path,
        { "staged-file.txt": "staged content" },
        { staged: true }
      );

      const status = await getGitStatus(sandbox.path);
      expect(status.staged).toContain("staged-file.txt");

      await sandbox.cleanup();
    });
  });

  describe("createMergeConflict", () => {
    test("creates a merge conflict", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Test" } },
      ]);

      await createMergeConflict(sandbox.path, {
        file: "config.json",
        baseContent: '{"version": 1}',
        currentContent: '{"version": 2}',
        otherContent: '{"version": 3}',
      });

      const status = await getGitStatus(sandbox.path);
      expect(status.conflicted).toContain("config.json");

      // Verify conflict markers in file
      const content = await readFile(join(sandbox.path, "config.json"), "utf-8");
      expect(content).toContain("<<<<<<<");
      expect(content).toContain(">>>>>>>");

      await sandbox.cleanup();
    });
  });

  describe("getGitStatus", () => {
    test("reports clean repository", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Test" } },
      ]);

      const status = await getGitStatus(sandbox.path);
      expect(status.clean).toBe(true);
      expect(status.staged).toHaveLength(0);
      expect(status.unstaged).toHaveLength(0);
      expect(status.untracked).toHaveLength(0);

      await sandbox.cleanup();
    });

    test("reports various change types", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "Initial commit", files: { "README.md": "# Test" } },
      ]);

      // Create untracked file
      await writeFile(join(sandbox.path, "untracked.txt"), "untracked");

      // Create staged file
      await writeFile(join(sandbox.path, "staged.txt"), "staged");
      const proc = Bun.spawn(["git", "add", "staged.txt"], {
        cwd: sandbox.path,
        env: { ...process.env, ...GIT_ISOLATED_ENV },
      });
      await proc.exited;

      // Modify tracked file (unstaged)
      await writeFile(join(sandbox.path, "README.md"), "# Modified");

      const status = await getGitStatus(sandbox.path);
      expect(status.clean).toBe(false);
      expect(status.untracked).toContain("untracked.txt");
      expect(status.staged).toContain("staged.txt");
      expect(status.unstaged).toContain("README.md");

      await sandbox.cleanup();
    });
  });

  describe("getGitLog", () => {
    test("returns commit messages", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "First commit", files: { "a.txt": "a" } },
        { message: "Second commit", files: { "b.txt": "b" } },
        { message: "Third commit", files: { "c.txt": "c" } },
      ]);

      const log = await getGitLog(sandbox.path);
      expect(log).toHaveLength(3);
      expect(log[0]).toBe("Third commit");
      expect(log[1]).toBe("Second commit");
      expect(log[2]).toBe("First commit");

      await sandbox.cleanup();
    });

    test("respects limit option", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);
      await createCommitHistory(sandbox.path, [
        { message: "First commit", files: { "a.txt": "a" } },
        { message: "Second commit", files: { "b.txt": "b" } },
        { message: "Third commit", files: { "c.txt": "c" } },
      ]);

      const log = await getGitLog(sandbox.path, { limit: 2 });
      expect(log).toHaveLength(2);
      expect(log[0]).toBe("Third commit");
      expect(log[1]).toBe("Second commit");

      await sandbox.cleanup();
    });

    test("returns empty array for repo with no commits", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      await initGitRepo(sandbox.path);

      const log = await getGitLog(sandbox.path);
      expect(log).toHaveLength(0);

      await sandbox.cleanup();
    });
  });
});
