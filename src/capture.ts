import type { OpenCodeEvent, ToolCall } from "./types.js";

export interface CaptureResult {
  events: OpenCodeEvent[];
  tool_calls: ToolCall[];
  tokens_used: number;
  cost: number;
  duration_ms: number;
  exit_code: number;
}

/**
 * Run opencode with a query and capture the event stream.
 */
export async function runOpenCode(
  query: string,
  cwd: string,
  options: {
    plugins?: string[];
    model?: string;
    agent?: string;
    env?: Record<string, string>;
    timeout_ms?: number;
  } = {}
): Promise<CaptureResult> {
  const args = ["run", query, "--format", "json"];

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.agent) {
    args.push("--agent", options.agent);
  }

  // TODO: Handle plugins - need to figure out how to pass them
  // Might need to modify opencode.json in the sandbox

  const startTime = Date.now();

  const proc = Bun.spawn(["opencode", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...options.env,
      CI: "true",
      NO_COLOR: "1",
    },
  });

  // Set up timeout
  const timeout_ms = options.timeout_ms ?? 120000;
  const timeoutId = setTimeout(() => {
    proc.kill();
  }, timeout_ms);

  // Collect stdout as NDJSON
  const stdout = await new Response(proc.stdout).text();
  const exit_code = await proc.exited;

  clearTimeout(timeoutId);

  const duration_ms = Date.now() - startTime;

  // Parse NDJSON events
  const events = parseNDJSON(stdout);
  const tool_calls = extractToolCalls(events);
  const { tokens_used, cost } = aggregateTokensAndCost(events);

  return {
    events,
    tool_calls,
    tokens_used,
    cost,
    duration_ms,
    exit_code,
  };
}

/**
 * Parse newline-delimited JSON into events.
 */
function parseNDJSON(text: string): OpenCodeEvent[] {
  const events: OpenCodeEvent[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as OpenCodeEvent;
      events.push(event);
    } catch {
      // Skip malformed lines
      console.warn("Failed to parse event:", trimmed.slice(0, 100));
    }
  }

  return events;
}

/**
 * Extract tool calls from the event stream.
 */
function extractToolCalls(events: OpenCodeEvent[]): ToolCall[] {
  const tool_calls: ToolCall[] = [];

  for (const event of events) {
    if (event.type === "tool_use" && event.part.tool && event.part.state) {
      const { state } = event.part;

      // Only include completed tool calls
      if (state.status === "completed" || state.status === "error") {
        tool_calls.push({
          name: event.part.tool,
          callID: event.part.callID ?? "",
          args: state.input,
          output: state.output,
          timestamp: state.time?.start ?? event.timestamp,
          duration_ms: state.time ? state.time.end - state.time.start : 0,
        });
      }
    }
  }

  return tool_calls;
}

/**
 * Aggregate token usage and cost from step_finish events.
 */
function aggregateTokensAndCost(events: OpenCodeEvent[]): {
  tokens_used: number;
  cost: number;
} {
  let tokens_used = 0;
  let cost = 0;

  for (const event of events) {
    if (event.type === "step_finish" && event.part.tokens) {
      const { tokens } = event.part;
      tokens_used +=
        tokens.input +
        tokens.output +
        tokens.reasoning +
        (tokens.cache?.read ?? 0) +
        (tokens.cache?.write ?? 0);
    }

    if (event.type === "step_finish" && event.part.cost) {
      cost += event.part.cost;
    }
  }

  return { tokens_used, cost };
}
