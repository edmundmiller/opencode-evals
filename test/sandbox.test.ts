import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createSandbox, readDirectoryFiles } from "../src/sandbox.js";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";

const TEST_FIXTURES_DIR = join(import.meta.dir, "fixtures");

describe("sandbox", () => {
  beforeAll(async () => {
    // Create test fixtures
    await mkdir(join(TEST_FIXTURES_DIR, "test-template"), { recursive: true });
    await writeFile(
      join(TEST_FIXTURES_DIR, "test-template", "existing.txt"),
      "template content"
    );
  });

  afterAll(async () => {
    await rm(TEST_FIXTURES_DIR, { recursive: true, force: true });
  });

  test("creates empty sandbox", async () => {
    const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

    expect(sandbox.path).toContain("opencode-eval-");

    await sandbox.cleanup();
  });

  test("copies template files", async () => {
    const sandbox = await createSandbox(
      { template: "test-template" },
      "default",
      TEST_FIXTURES_DIR
    );

    const files = await readDirectoryFiles(sandbox.path);
    expect(files["existing.txt"]).toBe("template content");

    await sandbox.cleanup();
  });

  test("writes inline files", async () => {
    const sandbox = await createSandbox(
      {
        files: {
          "src/app.ts": "export const x = 1;",
          "README.md": "# Test",
        },
      },
      "default",
      TEST_FIXTURES_DIR
    );

    const files = await readDirectoryFiles(sandbox.path);
    expect(files["src/app.ts"]).toBe("export const x = 1;");
    expect(files["README.md"]).toBe("# Test");

    await sandbox.cleanup();
  });

  test("merges template and inline files", async () => {
    const sandbox = await createSandbox(
      {
        template: "test-template",
        files: {
          "new.txt": "new content",
        },
      },
      "default",
      TEST_FIXTURES_DIR
    );

    const files = await readDirectoryFiles(sandbox.path);
    expect(files["existing.txt"]).toBe("template content");
    expect(files["new.txt"]).toBe("new content");

    await sandbox.cleanup();
  });

  test("runs variant-specific setup commands", async () => {
    const sandbox = await createSandbox(
      {
        commands: {
          variant1: ["touch variant1.txt"],
          variant2: ["touch variant2.txt"],
        },
      },
      "variant1",
      TEST_FIXTURES_DIR
    );

    const files = await readDirectoryFiles(sandbox.path);
    expect(files["variant1.txt"]).toBeDefined();
    expect(files["variant2.txt"]).toBeUndefined();

    await sandbox.cleanup();
  });
});

describe("readDirectoryFiles", () => {
  test("reads all files recursively", async () => {
    const sandbox = await createSandbox(
      {
        files: {
          "a.txt": "a",
          "dir/b.txt": "b",
          "dir/subdir/c.txt": "c",
        },
      },
      "default",
      TEST_FIXTURES_DIR
    );

    const files = await readDirectoryFiles(sandbox.path);
    expect(files["a.txt"]).toBe("a");
    expect(files["dir/b.txt"]).toBe("b");
    expect(files["dir/subdir/c.txt"]).toBe("c");

    await sandbox.cleanup();
  });

  test("skips hidden files and node_modules", async () => {
    const sandbox = await createSandbox(
      {
        files: {
          "visible.txt": "visible",
          ".hidden": "hidden",
        },
      },
      "default",
      TEST_FIXTURES_DIR
    );

    // Manually create node_modules to test skip
    await mkdir(join(sandbox.path, "node_modules"), { recursive: true });
    await writeFile(join(sandbox.path, "node_modules", "pkg.js"), "pkg");

    const files = await readDirectoryFiles(sandbox.path);
    expect(files["visible.txt"]).toBe("visible");
    expect(files[".hidden"]).toBeUndefined();
    expect(files["node_modules/pkg.js"]).toBeUndefined();

    await sandbox.cleanup();
  });
});
