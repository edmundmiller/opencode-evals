/**
 * VCS helper utilities for setting up git repositories in sandboxes.
 *
 * These helpers provide programmatic ways to set up git state for evals
 * that test VCS-related functionality.
 *
 * @module @opencode/evals/vcs-helpers
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface GitRemoteOptions {
  /** Create as bare repository (default: true) */
  bare?: boolean;
  /** Branches to create in the remote */
  branches?: string[];
  /** Remote name to add in the sandbox (default: "origin") */
  remoteName?: string;
}

export interface CommitOptions {
  /** Commit message */
  message: string;
  /** Files to create/modify before committing */
  files?: Record<string, string>;
  /** Branch to commit on (default: current branch) */
  branch?: string;
  /** Author name (default: "Test User") */
  authorName?: string;
  /** Author email (default: "test@example.com") */
  authorEmail?: string;
}

export interface BranchOptions {
  /** Branch to checkout after creation */
  checkout?: string;
  /** Base ref for new branches (default: HEAD) */
  base?: string;
}

/**
 * Environment variables for isolated git operations.
 * Use these to prevent leaking global git config into sandboxes.
 */
export const GIT_ISOLATED_ENV = {
  // Prevent reading global/system config
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  // Disable interactive prompts
  GIT_TERMINAL_PROMPT: "0",
  // Disable GPG signing
  GIT_COMMIT_GPGSIGN: "false",
  // Set CI mode
  CI: "true",
  // Prevent credential helpers
  GIT_ASKPASS: "echo",
  // Disable hooks that might exist globally
  GIT_HOOKS_PATH: "/dev/null",
} as const;

/**
 * Run a git command in the specified directory with isolated environment.
 */
async function runGit(
  args: string[],
  cwd: string,
  options?: { env?: Record<string, string> }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...GIT_ISOLATED_ENV,
      ...options?.env,
    },
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { stdout, stderr, exitCode };
}

/**
 * Run a git command and throw on failure.
 */
async function runGitOrThrow(
  args: string[],
  cwd: string,
  options?: { env?: Record<string, string> }
): Promise<string> {
  const result = await runGit(args, cwd, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Git command failed: git ${args.join(" ")}\n${result.stderr}`
    );
  }
  return result.stdout;
}

/**
 * Initialize a git repository in the sandbox.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param options - Configuration options
 */
export async function initGitRepo(
  sandboxPath: string,
  options?: {
    defaultBranch?: string;
    authorName?: string;
    authorEmail?: string;
  }
): Promise<void> {
  const defaultBranch = options?.defaultBranch ?? "main";
  const authorName = options?.authorName ?? "Test User";
  const authorEmail = options?.authorEmail ?? "test@example.com";

  // Initialize repository
  await runGitOrThrow(["init", "-b", defaultBranch], sandboxPath);

  // Set local config (not global)
  await runGitOrThrow(["config", "user.name", authorName], sandboxPath);
  await runGitOrThrow(["config", "user.email", authorEmail], sandboxPath);

  // Disable GPG signing locally
  await runGitOrThrow(["config", "commit.gpgsign", "false"], sandboxPath);
}

/**
 * Set up a git remote for the sandbox.
 *
 * Creates a bare repository in a subdirectory and adds it as a remote.
 * This allows testing push/pull operations in isolation.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param options - Configuration options
 * @returns Path to the created remote repository
 *
 * @example
 * ```typescript
 * const remotePath = await setupGitRemote(sandboxPath, {
 *   remoteName: "origin",
 *   branches: ["main", "develop"]
 * });
 * ```
 */
export async function setupGitRemote(
  sandboxPath: string,
  options?: GitRemoteOptions
): Promise<string> {
  const {
    bare = true,
    branches = [],
    remoteName = "origin",
  } = options ?? {};

  // Create remote repo in .git-remotes subdirectory
  const remotePath = join(sandboxPath, ".git-remotes", remoteName);
  await mkdir(remotePath, { recursive: true });

  // Initialize the remote repository
  if (bare) {
    await runGitOrThrow(["init", "--bare"], remotePath);
  } else {
    await runGitOrThrow(["init"], remotePath);
  }

  // Check if sandbox is already a git repo
  const gitCheck = await runGit(["rev-parse", "--git-dir"], sandboxPath);
  const isGitRepo = gitCheck.exitCode === 0;

  if (isGitRepo) {
    // Add remote to the sandbox
    await runGitOrThrow(["remote", "add", remoteName, remotePath], sandboxPath);

    // If we have commits and branches to create, push them
    if (branches.length > 0) {
      // Check if we have any commits
      const hasCommits = await runGit(["rev-parse", "HEAD"], sandboxPath);
      if (hasCommits.exitCode === 0) {
        // Create and push branches
        for (const branch of branches) {
          // Create branch if it doesn't exist
          const branchCheck = await runGit(
            ["rev-parse", "--verify", branch],
            sandboxPath
          );
          if (branchCheck.exitCode !== 0) {
            await runGitOrThrow(["branch", branch], sandboxPath);
          }
          // Push to remote
          await runGitOrThrow(
            ["push", "-u", remoteName, branch],
            sandboxPath
          );
        }
      }
    }
  }

  return remotePath;
}

/**
 * Create a series of commits in the repository.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param commits - Array of commits to create
 *
 * @example
 * ```typescript
 * await createCommitHistory(sandboxPath, [
 *   { message: "Initial commit", files: { "README.md": "# Hello" } },
 *   { message: "Add config", files: { "config.json": "{}" } },
 * ]);
 * ```
 */
export async function createCommitHistory(
  sandboxPath: string,
  commits: CommitOptions[]
): Promise<void> {
  for (const commit of commits) {
    const {
      message,
      files,
      branch,
      authorName = "Test User",
      authorEmail = "test@example.com",
    } = commit;

    // Switch branch if specified
    if (branch) {
      // Check if branch exists
      const branchCheck = await runGit(
        ["rev-parse", "--verify", branch],
        sandboxPath
      );
      if (branchCheck.exitCode !== 0) {
        // Create and checkout new branch
        await runGitOrThrow(["checkout", "-b", branch], sandboxPath);
      } else {
        // Checkout existing branch
        await runGitOrThrow(["checkout", branch], sandboxPath);
      }
    }

    // Write files if specified
    if (files) {
      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = join(sandboxPath, filePath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf-8");
        await runGitOrThrow(["add", filePath], sandboxPath);
      }
    } else {
      // If no files specified, create an empty commit marker or stage all changes
      await runGitOrThrow(["add", "-A"], sandboxPath);
    }

    // Create commit with author info
    const env = {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    };

    // Check if there's anything to commit
    const status = await runGit(["status", "--porcelain"], sandboxPath);
    if (status.stdout.trim() || !files) {
      await runGitOrThrow(
        ["commit", "--allow-empty", "-m", message],
        sandboxPath,
        { env }
      );
    }
  }
}

/**
 * Create branches in the repository.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param branches - Array of branch names to create
 * @param options - Configuration options
 *
 * @example
 * ```typescript
 * await setupGitBranches(sandboxPath, ["feature/auth", "feature/api"], {
 *   checkout: "feature/auth"
 * });
 * ```
 */
export async function setupGitBranches(
  sandboxPath: string,
  branches: string[],
  options?: BranchOptions
): Promise<void> {
  const { checkout, base } = options ?? {};

  for (const branch of branches) {
    // Check if branch already exists
    const branchCheck = await runGit(
      ["rev-parse", "--verify", branch],
      sandboxPath
    );
    if (branchCheck.exitCode !== 0) {
      // Create new branch
      const args = ["branch", branch];
      if (base) {
        args.push(base);
      }
      await runGitOrThrow(args, sandboxPath);
    }
  }

  // Checkout specified branch
  if (checkout) {
    await runGitOrThrow(["checkout", checkout], sandboxPath);
  }
}

/**
 * Create uncommitted changes in the working directory.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param changes - Files to create or modify
 * @param options - Whether to stage changes
 *
 * @example
 * ```typescript
 * await createUncommittedChanges(sandboxPath, {
 *   "src/new-file.ts": "export const x = 1;",
 *   "README.md": "# Updated readme"
 * }, { staged: true });
 * ```
 */
export async function createUncommittedChanges(
  sandboxPath: string,
  changes: Record<string, string>,
  options?: { staged?: boolean }
): Promise<void> {
  const { staged = false } = options ?? {};

  for (const [filePath, content] of Object.entries(changes)) {
    const fullPath = join(sandboxPath, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");

    if (staged) {
      await runGitOrThrow(["add", filePath], sandboxPath);
    }
  }
}

/**
 * Create a merge conflict scenario.
 *
 * Creates two branches with conflicting changes to the same file,
 * then attempts to merge them, leaving the repo in a conflicted state.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param options - Configuration for the conflict
 *
 * @example
 * ```typescript
 * await createMergeConflict(sandboxPath, {
 *   file: "config.json",
 *   baseBranch: "main",
 *   otherBranch: "feature",
 *   baseContent: '{"version": 1}',
 *   currentContent: '{"version": 2}',
 *   otherContent: '{"version": 3}'
 * });
 * ```
 */
export async function createMergeConflict(
  sandboxPath: string,
  options: {
    file: string;
    baseBranch?: string;
    otherBranch?: string;
    baseContent: string;
    currentContent: string;
    otherContent: string;
  }
): Promise<void> {
  const {
    file,
    baseBranch = "main",
    otherBranch = "conflict-branch",
    baseContent,
    currentContent,
    otherContent,
  } = options;

  // Ensure we're on base branch and create base content
  await runGitOrThrow(["checkout", baseBranch], sandboxPath);
  const fullPath = join(sandboxPath, file);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, baseContent, "utf-8");
  await runGitOrThrow(["add", file], sandboxPath);
  await runGitOrThrow(["commit", "-m", "Base content"], sandboxPath);

  // Create other branch with conflicting content
  await runGitOrThrow(["checkout", "-b", otherBranch], sandboxPath);
  await writeFile(fullPath, otherContent, "utf-8");
  await runGitOrThrow(["add", file], sandboxPath);
  await runGitOrThrow(["commit", "-m", "Other branch changes"], sandboxPath);

  // Go back to base branch and make different changes
  await runGitOrThrow(["checkout", baseBranch], sandboxPath);
  await writeFile(fullPath, currentContent, "utf-8");
  await runGitOrThrow(["add", file], sandboxPath);
  await runGitOrThrow(["commit", "-m", "Current branch changes"], sandboxPath);

  // Attempt merge (this will fail and leave conflict markers)
  await runGit(["merge", otherBranch], sandboxPath);
}

/**
 * Get the current git status.
 * Useful for assertions in tests.
 */
export async function getGitStatus(
  sandboxPath: string
): Promise<{
  branch: string | null;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
}> {
  // Get current branch - try rev-parse first, fall back to symbolic-ref for empty repos
  let branch: string | null = null;
  const branchResult = await runGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    sandboxPath
  );
  if (branchResult.exitCode === 0) {
    branch = branchResult.stdout.trim();
  } else {
    // For repos without commits, use symbolic-ref
    const symbolicResult = await runGit(
      ["symbolic-ref", "--short", "HEAD"],
      sandboxPath
    );
    if (symbolicResult.exitCode === 0) {
      branch = symbolicResult.stdout.trim();
    }
  }

  // Get status using porcelain v1 format: XY PATH (or XY ORIG -> PATH for renames)
  const statusResult = await runGit(["status", "--porcelain=v1"], sandboxPath);
  // Don't use trim() - it removes leading spaces which are significant in porcelain format
  // (e.g., " M file" means modified in worktree, "M " means staged)
  const lines = statusResult.stdout.split("\n").filter((line) => line.length > 0);

  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];

  for (const line of lines) {
    // Porcelain v1 format: XY PATH where XY is exactly 2 chars, then space, then path
    // For renames: XY ORIG_PATH -> PATH
    const indexStatus = line[0] ?? " ";
    const workStatus = line[1] ?? " ";
    // Skip the status chars (2) and the space separator (1) to get the filename
    const file = line.slice(3);

    // Handle conflict states
    if (
      indexStatus === "U" ||
      workStatus === "U" ||
      (indexStatus === "A" && workStatus === "A") ||
      (indexStatus === "D" && workStatus === "D")
    ) {
      conflicted.push(file);
    } else if (indexStatus === "?" && workStatus === "?") {
      // Untracked files
      untracked.push(file);
    } else {
      // Staged changes: any non-space, non-? in index position
      if (indexStatus !== " " && indexStatus !== "?") {
        staged.push(file);
      }
      // Unstaged changes: M (modified) or D (deleted) in worktree position
      if (workStatus === "M" || workStatus === "D") {
        unstaged.push(file);
      }
    }
  }

  return {
    branch,
    clean: lines.length === 0,
    staged,
    unstaged,
    untracked,
    conflicted,
  };
}

/**
 * Get the commit log.
 * Useful for assertions in tests.
 */
export async function getGitLog(
  sandboxPath: string,
  options?: { limit?: number; format?: string }
): Promise<string[]> {
  const { limit = 10, format = "%s" } = options ?? {};
  const result = await runGit(
    ["log", `-${limit}`, `--format=${format}`],
    sandboxPath
  );

  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout.trim().split("\n").filter(Boolean);
}
