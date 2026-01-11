/**
 * VCS helper utilities for setting up jj (Jujutsu) repositories in sandboxes.
 *
 * These helpers provide programmatic ways to set up jj state for evals
 * that test VCS-related functionality. jj is a Git-compatible VCS with
 * features like automatic change tracking and working-copy-as-a-commit.
 *
 * @module @opencode/evals/jj-helpers
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface JjRemoteOptions {
  /** Create as bare repository (default: true) */
  bare?: boolean;
  /** Branches/bookmarks to create in the remote */
  bookmarks?: string[];
  /** Remote name to add in the sandbox (default: "origin") */
  remoteName?: string;
}

export interface JjChangeOptions {
  /** Change description */
  description: string;
  /** Files to create/modify in this change */
  files?: Record<string, string>;
  /** Bookmark to set on this change */
  bookmark?: string;
  /** Author name (default: "Test User") */
  authorName?: string;
  /** Author email (default: "test@example.com") */
  authorEmail?: string;
}

export interface JjBookmarkOptions {
  /** Start a new change after creating bookmarks */
  newChange?: boolean;
  /** Base revision for new bookmarks (default: @) */
  base?: string;
}

/**
 * Environment variables for isolated jj operations.
 * Use these to prevent leaking global jj/git config into sandboxes.
 * 
 * Note: We don't set JJ_CONFIG=/dev/null because we need repo-local
 * config (user.name, user.email) to work. Instead, we rely on --repo
 * config being set during init.
 */
export const JJ_ISOLATED_ENV = {
  // Prevent reading global/system git config
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
 * Run a jj command in the specified directory with isolated environment.
 */
async function runJj(
  args: string[],
  cwd: string,
  options?: { env?: Record<string, string> }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["jj", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...JJ_ISOLATED_ENV,
      ...options?.env,
    },
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { stdout, stderr, exitCode };
}

/**
 * Run a jj command and throw on failure.
 */
async function runJjOrThrow(
  args: string[],
  cwd: string,
  options?: { env?: Record<string, string> }
): Promise<string> {
  const result = await runJj(args, cwd, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `jj command failed: jj ${args.join(" ")}\n${result.stderr}`
    );
  }
  return result.stdout;
}

/**
 * Initialize a jj repository in the sandbox.
 * Uses `jj git init` to create a git-backed jj repo.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param options - Configuration options
 */
export async function initJjRepo(
  sandboxPath: string,
  options?: {
    authorName?: string;
    authorEmail?: string;
  }
): Promise<void> {
  const authorName = options?.authorName ?? "Test User";
  const authorEmail = options?.authorEmail ?? "test@example.com";

  // Initialize git-backed jj repository
  await runJjOrThrow(["git", "init", "--quiet"], sandboxPath);

  // Set local config (not global)
  // jj config set expects TOML values - strings need quotes for special chars
  // Syntax: jj config set --repo NAME VALUE (--repo means repo scope, not a path)
  await runJjOrThrow(
    ["config", "set", "--repo", "user.name", `"${authorName}"`],
    sandboxPath
  );
  await runJjOrThrow(
    ["config", "set", "--repo", "user.email", `"${authorEmail}"`],
    sandboxPath
  );
}

/**
 * Set up a git remote for the jj repository.
 *
 * Creates a bare git repository and adds it as a remote.
 * This allows testing push/fetch operations in isolation.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param options - Configuration options
 * @returns Path to the created remote repository
 */
export async function setupJjRemote(
  sandboxPath: string,
  options?: JjRemoteOptions
): Promise<string> {
  const {
    bare = true,
    bookmarks = [],
    remoteName = "origin",
  } = options ?? {};

  // Create remote repo in .git-remotes subdirectory
  const remotePath = join(sandboxPath, ".git-remotes", remoteName);
  await mkdir(remotePath, { recursive: true });

  // Initialize the remote repository (always git for remotes)
  const gitArgs = bare ? ["init", "--bare"] : ["init"];
  const gitProc = Bun.spawn(["git", ...gitArgs], {
    cwd: remotePath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...JJ_ISOLATED_ENV },
  });
  await gitProc.exited;

  // Add remote to the jj repo
  await runJjOrThrow(["git", "remote", "add", remoteName, remotePath], sandboxPath);

  // If we have bookmarks to push, push them
  if (bookmarks.length > 0) {
    for (const bookmark of bookmarks) {
      // Check if bookmark exists before pushing
      const bookmarkCheck = await runJj(
        ["bookmark", "list", "--quiet", bookmark],
        sandboxPath
      );
      if (bookmarkCheck.exitCode === 0 && bookmarkCheck.stdout.trim()) {
        await runJjOrThrow(
          ["git", "push", "--bookmark", bookmark, "--allow-new"],
          sandboxPath
        );
      }
    }
  }

  return remotePath;
}

/**
 * Create a series of changes (commits) in the repository.
 *
 * In jj, the working copy is always a commit. This function:
 * 1. Writes files to the working copy
 * 2. Describes the current change
 * 3. Creates a new change for the next iteration
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param changes - Array of changes to create
 */
export async function createJjChanges(
  sandboxPath: string,
  changes: JjChangeOptions[]
): Promise<void> {
  for (const change of changes) {
    const {
      description,
      files,
      bookmark,
      authorName = "Test User",
      authorEmail = "test@example.com",
    } = change;

    // Write files if specified
    if (files) {
      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = join(sandboxPath, filePath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf-8");
      }
    }

    // Describe the current change (uses repo config set in initJjRepo)
    await runJjOrThrow(["describe", "-m", description], sandboxPath);

    // Set bookmark if specified
    if (bookmark) {
      await runJjOrThrow(["bookmark", "set", bookmark], sandboxPath);
    }

    // Create a new empty change for the next iteration
    await runJjOrThrow(["new", "--quiet"], sandboxPath);
  }
}

/**
 * Create bookmarks in the repository.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param bookmarks - Array of bookmark names to create
 * @param options - Configuration options
 */
export async function setupJjBookmarks(
  sandboxPath: string,
  bookmarks: string[],
  options?: JjBookmarkOptions
): Promise<void> {
  const { newChange = false, base } = options ?? {};

  for (const bookmark of bookmarks) {
    // Create bookmark at current revision or specified base
    const args = ["bookmark", "set", bookmark];
    if (base) {
      args.push("-r", base);
    }
    await runJjOrThrow(args, sandboxPath);
  }

  // Start a new change if requested
  if (newChange) {
    await runJjOrThrow(["new", "--quiet"], sandboxPath);
  }
}

/**
 * Create uncommitted changes in the working copy.
 *
 * In jj, all changes are automatically tracked. This function
 * writes files and optionally describes the current change.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param changes - Files to create or modify
 * @param options - Whether to describe the change
 */
export async function createJjWorkingCopyChanges(
  sandboxPath: string,
  changes: Record<string, string>,
  options?: { description?: string }
): Promise<void> {
  for (const [filePath, content] of Object.entries(changes)) {
    const fullPath = join(sandboxPath, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  // Optionally describe the change
  if (options?.description) {
    await runJjOrThrow(["describe", "-m", options.description], sandboxPath);
  }
}

/**
 * Create an orphan scenario for testing orphan recovery.
 *
 * This simulates what happens when external operations (like nix-darwin)
 * change jj state, creating orphaned commits disconnected from main.
 *
 * @param sandboxPath - Path to the sandbox directory
 * @param options - Configuration for the orphan scenario
 */
export async function createOrphanScenario(
  sandboxPath: string,
  options: {
    /** Description for the orphaned change */
    orphanDescription: string;
    /** Files in the orphaned change */
    orphanFiles: Record<string, string>;
    /** Remote bookmark to reset to (default: "main@origin") */
    resetTo?: string;
  }
): Promise<void> {
  const { orphanDescription, orphanFiles, resetTo = "main@origin" } = options;

  // First, create changes that will become orphaned
  for (const [filePath, content] of Object.entries(orphanFiles)) {
    const fullPath = join(sandboxPath, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
  await runJjOrThrow(["describe", "-m", orphanDescription], sandboxPath);

  // Now reset to the remote, orphaning the previous changes
  // This simulates what happens when jj state is externally modified
  await runJjOrThrow(["new", resetTo, "--quiet"], sandboxPath);
}

/**
 * Get the current jj status.
 * Useful for assertions in tests.
 */
export async function getJjStatus(
  sandboxPath: string
): Promise<{
  currentChange: string | null;
  description: string | null;
  bookmarks: string[];
  hasChanges: boolean;
  files: { modified: string[]; added: string[]; deleted: string[] };
}> {
  // Get current change ID
  const changeResult = await runJj(
    ["log", "-r", "@", "--no-graph", "-T", "change_id.short()"],
    sandboxPath
  );
  const currentChange =
    changeResult.exitCode === 0 ? changeResult.stdout.trim() : null;

  // Get current description
  const descResult = await runJj(
    ["log", "-r", "@", "--no-graph", "-T", "description"],
    sandboxPath
  );
  const description =
    descResult.exitCode === 0 ? descResult.stdout.trim() : null;

  // Get bookmarks pointing to current change
  const bookmarkResult = await runJj(["bookmark", "list", "-r", "@"], sandboxPath);
  const bookmarks =
    bookmarkResult.exitCode === 0
      ? bookmarkResult.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(":")[0].trim())
      : [];

  // Get file status using diff
  const diffResult = await runJj(
    ["diff", "--stat", "--from", "@-", "--to", "@"],
    sandboxPath
  );

  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  if (diffResult.exitCode === 0) {
    const lines = diffResult.stdout.trim().split("\n").filter(Boolean);
    // Parse stat output: file | +N -M
    for (const line of lines) {
      if (line.includes("|")) {
        const file = line.split("|")[0].trim();
        if (file && !file.includes("changed")) {
          // Simplified: just mark as modified
          modified.push(file);
        }
      }
    }
  }

  const hasChanges = modified.length > 0 || added.length > 0 || deleted.length > 0;

  return {
    currentChange,
    description,
    bookmarks,
    hasChanges,
    files: { modified, added, deleted },
  };
}

/**
 * Get the jj log (list of changes).
 * Useful for assertions in tests.
 */
export async function getJjLog(
  sandboxPath: string,
  options?: { limit?: number; revset?: string }
): Promise<Array<{ changeId: string; description: string; bookmarks: string[] }>> {
  const { limit = 10, revset = "::@" } = options ?? {};

  const result = await runJj(
    [
      "log",
      "-r",
      revset,
      "--no-graph",
      "-n",
      String(limit),
      "-T",
      'change_id.short() ++ "\\t" ++ description.first_line() ++ "\\t" ++ bookmarks ++ "\\n"',
    ],
    sandboxPath
  );

  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [changeId, description, bookmarksStr] = line.split("\t");
      return {
        changeId: changeId ?? "",
        description: description ?? "",
        bookmarks: bookmarksStr ? bookmarksStr.split(" ").filter(Boolean) : [],
      };
    });
}

/**
 * Check if the repository has orphaned commits.
 * Orphans are changes that are disconnected from main/origin bookmarks
 * AND have actual file changes (not empty working copy commits).
 * 
 * In jj, orphans are typically identified by looking for commits that
 * aren't ancestors of tracked remote bookmarks and contain real work.
 */
export async function hasOrphanedCommits(sandboxPath: string): Promise<boolean> {
  // Look for commits with file changes that aren't reachable from bookmarks
  // Exclude empty commits (like the working copy placeholder)
  const result = await runJj(
    [
      "log",
      "-r",
      "(heads(mutable()) ~ ancestors(bookmarks())) & ~empty()",
      "--no-graph",
      "-T",
      "change_id.short()",
    ],
    sandboxPath
  );

  // Filter out empty lines
  const commits = result.stdout.trim().split("\n").filter(Boolean);
  return result.exitCode === 0 && commits.length > 0;
}
