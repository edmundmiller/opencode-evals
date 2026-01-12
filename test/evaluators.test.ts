import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runCodeEvaluator } from "../src/evaluators/code.js";
import { createSandbox } from "../src/sandbox.js";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { ToolCall } from "../src/types.js";

const TEST_FIXTURES_DIR = join(import.meta.dir, "fixtures");

describe("code evaluator", () => {
  beforeAll(async () => {
    await mkdir(TEST_FIXTURES_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEST_FIXTURES_DIR, { recursive: true, force: true });
  });

  describe("file_exists", () => {
    test("passes when file exists", async () => {
      const sandbox = await createSandbox(
        { files: { "test.txt": "content" } },
        "default",
        TEST_FIXTURES_DIR
      );

      const feedback = await runCodeEvaluator(
        [{ type: "file_exists", path: "test.txt" }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(true);
      expect(feedback[0].score).toBe(1);

      await sandbox.cleanup();
    });

    test("fails when file missing", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "file_exists", path: "missing.txt" }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(false);
      expect(feedback[0].score).toBe(0);

      await sandbox.cleanup();
    });
  });

  describe("file_contains", () => {
    test("passes when pattern matches", async () => {
      const sandbox = await createSandbox(
        { files: { "app.ts": "function hello() { return 'world'; }" } },
        "default",
        TEST_FIXTURES_DIR
      );

      const feedback = await runCodeEvaluator(
        [{ type: "file_contains", path: "app.ts", pattern: "function hello" }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(true);

      await sandbox.cleanup();
    });

    test("supports regex patterns", async () => {
      const sandbox = await createSandbox(
        { files: { "app.ts": "const count = 42;" } },
        "default",
        TEST_FIXTURES_DIR
      );

      const feedback = await runCodeEvaluator(
        [{ type: "file_contains", path: "app.ts", pattern: "count\\s*=\\s*\\d+" }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(true);

      await sandbox.cleanup();
    });

    test("fails when pattern not found", async () => {
      const sandbox = await createSandbox(
        { files: { "app.ts": "const x = 1;" } },
        "default",
        TEST_FIXTURES_DIR
      );

      const feedback = await runCodeEvaluator(
        [{ type: "file_contains", path: "app.ts", pattern: "function" }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(false);

      await sandbox.cleanup();
    });
  });

  describe("file_not_contains", () => {
    test("passes when pattern not found", async () => {
      const sandbox = await createSandbox(
        { files: { "app.ts": "const x = 1;" } },
        "default",
        TEST_FIXTURES_DIR
      );

      const feedback = await runCodeEvaluator(
        [{ type: "file_not_contains", path: "app.ts", pattern: "console\\.log" }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(true);

      await sandbox.cleanup();
    });

    test("fails when pattern found", async () => {
      const sandbox = await createSandbox(
        { files: { "app.ts": "console.log('debug');" } },
        "default",
        TEST_FIXTURES_DIR
      );

      const feedback = await runCodeEvaluator(
        [{ type: "file_not_contains", path: "app.ts", pattern: "console\\.log" }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(false);

      await sandbox.cleanup();
    });
  });

  describe("tool_called", () => {
    const toolCalls: ToolCall[] = [
      {
        name: "write",
        callID: "1",
        args: { path: "/test.txt", content: "hello" },
        output: "success",
        timestamp: Date.now(),
        duration_ms: 100,
      },
      {
        name: "read",
        callID: "2",
        args: { path: "/other.txt" },
        output: "content",
        timestamp: Date.now(),
        duration_ms: 50,
      },
    ];

    test("passes when tool was called", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "tool_called", name: "write" }],
        sandbox.path,
        toolCalls,
        0
      );

      expect(feedback[0].passed).toBe(true);

      await sandbox.cleanup();
    });

    test("passes with matching args", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "tool_called", name: "write", args: { path: "/test.txt" } }],
        sandbox.path,
        toolCalls,
        0
      );

      expect(feedback[0].passed).toBe(true);

      await sandbox.cleanup();
    });

    test("fails when tool not called", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "tool_called", name: "delete" }],
        sandbox.path,
        toolCalls,
        0
      );

      expect(feedback[0].passed).toBe(false);

      await sandbox.cleanup();
    });
  });

  describe("tool_not_called", () => {
    const toolCalls: ToolCall[] = [
      {
        name: "write",
        callID: "1",
        args: {},
        output: "success",
        timestamp: Date.now(),
        duration_ms: 100,
      },
    ];

    test("passes when tool not called", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "tool_not_called", name: "delete" }],
        sandbox.path,
        toolCalls,
        0
      );

      expect(feedback[0].passed).toBe(true);

      await sandbox.cleanup();
    });

    test("fails when tool was called", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "tool_not_called", name: "write" }],
        sandbox.path,
        toolCalls,
        0
      );

      expect(feedback[0].passed).toBe(false);

      await sandbox.cleanup();
    });
  });

  describe("exit_code", () => {
    test("passes when exit code matches", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "exit_code", expected: 0 }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(true);

      await sandbox.cleanup();
    });

    test("fails when exit code differs", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "exit_code", expected: 0 }],
        sandbox.path,
        [],
        1
      );

      expect(feedback[0].passed).toBe(false);
      expect(feedback[0].comment).toContain("expected 0, got 1");

      await sandbox.cleanup();
    });
  });

  describe("environment_var", () => {
    test("passes when env var matches", async () => {
      process.env.OPENCODE_EVAL_TEST_VAR = "present";
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "environment_var", name: "OPENCODE_EVAL_TEST_VAR", value: "present" }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(true);

      await sandbox.cleanup();
      delete process.env.OPENCODE_EVAL_TEST_VAR;
    });

    test("passes when env var is not set", async () => {
      delete process.env.OPENCODE_EVAL_MISSING_VAR;
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "environment_var", name: "OPENCODE_EVAL_MISSING_VAR", exists: false }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(true);

      await sandbox.cleanup();
    });
  });

  describe("process_running", () => {
    test("passes when process is running", async () => {
      const proc = Bun.spawn(["sleep", "5"]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "process_running", name: "sleep" }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(true);

      proc.kill();
      await proc.exited;
      await sandbox.cleanup();
    });

    test("fails when process is not running", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);

      const feedback = await runCodeEvaluator(
        [{ type: "process_running", name: "definitely-not-running" }],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(false);

      await sandbox.cleanup();
    });
  });

  describe("database_query_result", () => {
    test("passes when sqlite query matches", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      const dbPath = join(sandbox.path, "test.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
      db.exec("INSERT INTO users (id, name) VALUES (1, 'Ada');");
      db.close();

      const feedback = await runCodeEvaluator(
        [
          {
            type: "database_query_result",
            connection: "sqlite://test.db",
            query: "SELECT name FROM users WHERE id = 1",
            expected: { name: "Ada" },
          },
        ],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(true);

      await sandbox.cleanup();
    });

    test("fails when sqlite query mismatches", async () => {
      const sandbox = await createSandbox(undefined, "default", TEST_FIXTURES_DIR);
      const dbPath = join(sandbox.path, "test.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);");
      db.exec("INSERT INTO users (id, name) VALUES (2, 'Grace');");
      db.close();

      const feedback = await runCodeEvaluator(
        [
          {
            type: "database_query_result",
            connection: "sqlite://test.db",
            query: "SELECT name FROM users WHERE id = 2",
            expected: { name: "Ada" },
          },
        ],
        sandbox.path,
        [],
        0
      );

      expect(feedback[0].passed).toBe(false);

      await sandbox.cleanup();
    });
  });
});
