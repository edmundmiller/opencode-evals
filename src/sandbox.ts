import { mkdtemp, rm, cp, mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { SetupConfig } from "./types.js";

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
 * Run a shell command in the sandbox directory.
 */
async function runCommand(cmd: string, cwd: string): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CI: "true",
      GIT_TERMINAL_PROMPT: "0",
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
