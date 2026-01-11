import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createSandbox } from "../src/sandbox.js";
import { getGitStatus, getGitLog, GIT_ISOLATED_ENV } from "../src/vcs-helpers.js";
import { join } from "node:path";
import { mkdir, rm, readFile } from "node:fs/promises";

const TEST_FIXTURES_DIR = join(import.meta.dir, "fixtures");

describe("VCS Integration - Declarative Config", () => {
  beforeAll(async () => {
    await mkdir(TEST_FIXTURES_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_FIXTURES_DIR, { recursive: true, force: true });
  });

  describe("git init via config", () => {
    test("initializes git repo with default settings", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              init: true,
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      const status = await getGitStatus(sandbox.path);
      expect(status.branch).toBe("main");

      await sandbox.cleanup();
    });

    test("initializes with custom branch name", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              init: true,
              defaultBranch: "master",
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      const status = await getGitStatus(sandbox.path);
      expect(status.branch).toBe("master");

      await sandbox.cleanup();
    });

    test("auto-inits when commits are specified", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              commits: [{ message: "Initial", files: { "README.md": "# Test" } }],
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      const log = await getGitLog(sandbox.path);
      expect(log).toContain("Initial");

      await sandbox.cleanup();
    });
  });

  describe("git commits via config", () => {
    test("creates single commit with files", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              commits: [
                {
                  message: "Add readme",
                  files: { "README.md": "# Hello World" },
                },
              ],
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      const content = await readFile(join(sandbox.path, "README.md"), "utf-8");
      expect(content).toBe("# Hello World");

      const log = await getGitLog(sandbox.path);
      expect(log).toContain("Add readme");

      await sandbox.cleanup();
    });

    test("creates multiple commits in order", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              commits: [
                { message: "First commit", files: { "a.txt": "a" } },
                { message: "Second commit", files: { "b.txt": "b" } },
                { message: "Third commit", files: { "c.txt": "c" } },
              ],
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      const log = await getGitLog(sandbox.path);
      expect(log[0]).toBe("Third commit");
      expect(log[1]).toBe("Second commit");
      expect(log[2]).toBe("First commit");

      await sandbox.cleanup();
    });

    test("creates commits on different branches", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              commits: [
                { message: "Main commit", files: { "main.txt": "main" } },
                { message: "Feature commit", files: { "feature.txt": "feature" }, branch: "feature" },
              ],
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // Should be on feature branch (last commit's branch)
      const status = await getGitStatus(sandbox.path);
      expect(status.branch).toBe("feature");

      await sandbox.cleanup();
    });
  });

  describe("git branches via config", () => {
    test("creates branches from commit history", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              commits: [{ message: "Initial", files: { "README.md": "# Test" } }],
              branches: ["develop", "feature/auth"],
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      const proc = Bun.spawn(["git", "branch"], {
        cwd: sandbox.path,
        stdout: "pipe",
        env: { ...process.env, ...GIT_ISOLATED_ENV },
      });
      await proc.exited;
      const branches = await new Response(proc.stdout).text();

      expect(branches).toContain("develop");
      expect(branches).toContain("feature/auth");

      await sandbox.cleanup();
    });

    test("checks out specified branch", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              commits: [{ message: "Initial", files: { "README.md": "# Test" } }],
              branches: ["develop", "feature"],
              checkout: "develop",
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      const status = await getGitStatus(sandbox.path);
      expect(status.branch).toBe("develop");

      await sandbox.cleanup();
    });
  });

  describe("git remote via config", () => {
    test("creates bare remote repository", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              commits: [{ message: "Initial", files: { "README.md": "# Test" } }],
              remote: {
                name: "origin",
              },
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

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

    test("pushes branches to remote", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              commits: [{ message: "Initial", files: { "README.md": "# Test" } }],
              remote: {
                name: "origin",
                branches: ["main"],
              },
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // Verify we can push (remote was set up correctly)
      const proc = Bun.spawn(["git", "push", "origin", "main"], {
        cwd: sandbox.path,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...GIT_ISOLATED_ENV },
      });
      const exitCode = await proc.exited;

      // Should succeed (already pushed) or succeed (pushes again)
      expect(exitCode).toBe(0);

      await sandbox.cleanup();
    });
  });

  describe("uncommitted changes via config", () => {
    test("creates unstaged changes", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              commits: [{ message: "Initial", files: { "README.md": "# Test" } }],
              uncommitted: {
                files: { "new-file.txt": "new content" },
                staged: false,
              },
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      const status = await getGitStatus(sandbox.path);
      expect(status.untracked).toContain("new-file.txt");

      await sandbox.cleanup();
    });

    test("creates staged changes", async () => {
      const sandbox = await createSandbox(
        {
          vcs: {
            git: {
              commits: [{ message: "Initial", files: { "README.md": "# Test" } }],
              uncommitted: {
                files: { "staged-file.txt": "staged content" },
                staged: true,
              },
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      const status = await getGitStatus(sandbox.path);
      expect(status.staged).toContain("staged-file.txt");

      await sandbox.cleanup();
    });
  });

  describe("combined configuration", () => {
    test("full git setup with commits, branches, remote, and uncommitted changes", async () => {
      const sandbox = await createSandbox(
        {
          files: {
            "config.json": '{"version": 1}',
          },
          vcs: {
            git: {
              defaultBranch: "main",
              authorName: "Test Author",
              authorEmail: "test@example.com",
              commits: [
                { message: "Initial commit", files: { "README.md": "# Project" } },
                { message: "Add feature", files: { "feature.ts": "export {}" } },
              ],
              branches: ["develop"],
              remote: {
                name: "origin",
                branches: ["main"],
              },
              uncommitted: {
                files: { "wip.txt": "work in progress" },
                staged: true,
              },
            },
          },
        },
        "default",
        TEST_FIXTURES_DIR
      );

      // Verify commits
      const log = await getGitLog(sandbox.path);
      expect(log).toContain("Initial commit");
      expect(log).toContain("Add feature");

      // Verify branch was created
      const branchProc = Bun.spawn(["git", "branch"], {
        cwd: sandbox.path,
        stdout: "pipe",
        env: { ...process.env, ...GIT_ISOLATED_ENV },
      });
      await branchProc.exited;
      const branches = await new Response(branchProc.stdout).text();
      expect(branches).toContain("develop");

      // Verify remote exists
      const remoteProc = Bun.spawn(["git", "remote"], {
        cwd: sandbox.path,
        stdout: "pipe",
        env: { ...process.env, ...GIT_ISOLATED_ENV },
      });
      await remoteProc.exited;
      const remotes = await new Response(remoteProc.stdout).text();
      expect(remotes).toContain("origin");

      // Verify uncommitted changes
      const status = await getGitStatus(sandbox.path);
      expect(status.staged).toContain("wip.txt");

      // Verify inline files were created
      const config = await readFile(join(sandbox.path, "config.json"), "utf-8");
      expect(config).toBe('{"version": 1}');

      await sandbox.cleanup();
    });
  });
});
