import { mkdtemp, rm, cp, mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { SetupConfig, GitSetup } from "./types.js";
import {
  GIT_ISOLATED_ENV,
  initGitRepo,
  setupGitRemote,
  createCommitHistory,
  setupGitBranches,
  createUncommittedChanges,
} from "./vcs-helpers.js";

export interface Sandbox {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated sandbox directory for running an eval.
 * Copies fixture template and inline files, then runs setup commands.
 */
export async function createSandbox(
  setup: SetupConfig | undefined,
  variant: string,
  fixturesDir: string
): Promise<Sandbox> {
  // Create temp directory
  const path = await mkdtemp(join(tmpdir(), "opencode-eval-"));

  const cleanup = async () => {
    await rm(path, { recursive: true, force: true });
  };

  try {
    // Copy fixture template if specified
    if (setup?.template) {
      const templatePath = join(fixturesDir, setup.template);
      await copyDirectory(templatePath, path);
    }

    // Write inline files
    if (setup?.files) {
      for (const [filePath, content] of Object.entries(setup.files)) {
        const fullPath = join(path, filePath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf-8");
      }
    }

    // Set up VCS if configured
    if (setup?.vcs?.git) {
      await setupGit(path, setup.vcs.git);
    }

    // Run setup commands (variant-aware)
    if (setup?.commands) {
      const commands = Array.isArray(setup.commands)
        ? setup.commands
        : setup.commands[variant] ?? [];

      for (const cmd of commands) {
        await runCommand(cmd, path);
      }
    }

    return { path, cleanup };
  } catch (error) {
    // Clean up on error
    await cleanup();
    throw error;
  }
}

/**
 * Set up git repository based on configuration.
 */
async function setupGit(sandboxPath: string, config: GitSetup): Promise<void> {
  // Determine if we should init - explicit config or implicit from other options
  const shouldInit =
    config.init ??
    Boolean(
      config.commits?.length ||
        config.branches?.length ||
        config.remote ||
        config.uncommitted
    );

  if (shouldInit) {
    await initGitRepo(sandboxPath, {
      defaultBranch: config.defaultBranch,
      authorName: config.authorName,
      authorEmail: config.authorEmail,
    });
  }

  // Create commits in order
  if (config.commits?.length) {
    await createCommitHistory(
      sandboxPath,
      config.commits.map((c) => ({
        message: c.message,
        files: c.files,
        branch: c.branch,
        authorName: c.authorName ?? config.authorName,
        authorEmail: c.authorEmail ?? config.authorEmail,
      }))
    );
  }

  // Create branches
  if (config.branches?.length) {
    await setupGitBranches(sandboxPath, config.branches, {
      checkout: config.checkout,
    });
  } else if (config.checkout) {
    // Just checkout if specified without creating new branches
    await setupGitBranches(sandboxPath, [], { checkout: config.checkout });
  }

  // Set up remote
  if (config.remote) {
    await setupGitRemote(sandboxPath, {
      remoteName: config.remote.name,
      bare: config.remote.bare,
      branches: config.remote.branches,
    });
  }

  // Create uncommitted changes
  if (config.uncommitted) {
    await createUncommittedChanges(sandboxPath, config.uncommitted.files, {
      staged: config.uncommitted.staged,
    });
  }
}

/**
 * Recursively copy a directory.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyDirectory(srcPath, destPath);
    } else {
      await mkdir(dirname(destPath), { recursive: true });
      await cp(srcPath, destPath);
    }
  }
}

/**
 * Environment variables for isolated sandbox command execution.
 * Extends GIT_ISOLATED_ENV with jj-specific settings.
 */
export const SANDBOX_ISOLATED_ENV = {
  ...GIT_ISOLATED_ENV,
  // Use minimal jj config to avoid user template incompatibilities
  JJ_CONFIG: "/dev/null",
} as const;

/**
 * Run a shell command in the sandbox directory.
 */
async function runCommand(cmd: string, cwd: string): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...SANDBOX_ISOLATED_ENV,
    },
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Setup command failed: ${cmd}\n${stderr}`);
  }
}

/**
 * Read all files in a directory as a Record<path, content>.
 */
export async function readDirectoryFiles(
  dir: string,
  prefix = ""
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);

    // Skip hidden files and common ignore patterns
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }

    if (entry.isDirectory()) {
      const subFiles = await readDirectoryFiles(fullPath, relativePath);
      Object.assign(files, subFiles);
    } else {
      try {
        const content = await readFile(fullPath, "utf-8");
        files[relativePath] = content;
      } catch {
        // Skip binary files or files that can't be read as utf-8
      }
    }
  }

  return files;
}

/**
 * Get the fixtures directory path.
 * Looks in the package's fixtures/ directory.
 */
export function getFixturesDir(): string {
  // When running from source: ./fixtures
  // When installed as package: node_modules/opencode-evals/fixtures
  const possiblePaths = [
    join(import.meta.dir, "..", "fixtures"),
    join(import.meta.dir, "..", "..", "fixtures"),
  ];

  // For now, just use the first one (relative to src/)
  return possiblePaths[0];
}
