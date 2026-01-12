import type { ToolCall, HttpRequest } from "./types.js";

export interface CaptureResult {
  events: NdjsonEvent[];
  tool_calls: ToolCall[];
  http_requests: HttpRequest[];
  tokens_used: number;
  cost: number;
  duration_ms: number;
  exit_code: number;
}

interface NdjsonEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Run opencode with a query and capture the NDJSON event stream.
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
  const startTime = Date.now();
  const timeout_ms = options.timeout_ms ?? 120000;

  // Build command args
  const args = ["run", query, "--format", "json"];

  if (options.model) {
    args.push("--model", options.model);
  }

  // Spawn opencode process
  const proc = Bun.spawn(["opencode", ...args], {
    cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Set up timeout
  const timeoutId = setTimeout(() => {
    proc.kill();
  }, timeout_ms);

  // Collect stdout and stderr
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit_code = await proc.exited;

  clearTimeout(timeoutId);

  const duration_ms = Date.now() - startTime;

  // Log stderr if present (for debugging)
  if (stderr.trim()) {
    console.error("  [stderr]:", stderr.trim().slice(0, 500));
  }

  // Parse NDJSON events
  const events: NdjsonEvent[] = [];
  const tool_calls: ToolCall[] = [];
  const http_requests: HttpRequest[] = [];
  let tokens_used = 0;
  let cost = 0;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line) as NdjsonEvent;
      events.push(event);

      // Extract tool calls from tool_use events
      // Format: { type: "tool_use", part: { tool: "name", callID: "...", state: { input, output, time } } }
      if (event.type === "tool_use") {
        const part = (event as { part?: unknown }).part as {
          tool?: string;
          callID?: string;
          state?: {
            status?: string;
            input?: unknown;
            output?: unknown;
            time?: { start?: number; end?: number };
          };
        } | undefined;

        if (part?.tool && part?.state) {
          const duration = part.state.time 
            ? (part.state.time.end ?? 0) - (part.state.time.start ?? 0)
            : 0;

          tool_calls.push({
            name: part.tool,
            callID: part.callID ?? "",
            args: part.state.input,
            output: part.state.output,
            timestamp: part.state.time?.start ?? Date.now(),
            duration_ms: duration,
          });

          const httpRequest = buildHttpRequest(part.tool, part.state.input);
          if (httpRequest) {
            http_requests.push(httpRequest);
          }
        }
      }

      // Extract token usage from step_finish events
      if (event.type === "step_finish") {
        const stepEvent = event as {
          type: string;
          tokens?: {
            input?: number;
            output?: number;
            cache_read?: number;
            cache_write?: number;
          };
          cost?: number;
        };

        if (stepEvent.tokens) {
          tokens_used +=
            (stepEvent.tokens.input ?? 0) +
            (stepEvent.tokens.output ?? 0) +
            (stepEvent.tokens.cache_read ?? 0) +
            (stepEvent.tokens.cache_write ?? 0);
        }
        if (stepEvent.cost) {
          cost += stepEvent.cost;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    events,
    tool_calls,
    http_requests,
    tokens_used,
    cost,
    duration_ms,
    exit_code,
  };
}

const HTTP_TOOL_NAMES = new Set(["webfetch", "fetch", "http", "https"]);

function buildHttpRequest(tool: string, input: unknown): HttpRequest | null {
  if (!HTTP_TOOL_NAMES.has(tool)) {
    return null;
  }

  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const url = record.url;
  if (typeof url !== "string") {
    return null;
  }

  const method = typeof record.method === "string" ? record.method : "GET";
  const headers = normalizeHeaders(record.headers);
  const body = record.body ?? record.data ?? record.payload ?? record.json;

  return {
    url,
    method: method.toUpperCase(),
    headers,
    body,
    tool,
  };
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof headerValue === "string") {
      headers[key] = headerValue;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}
