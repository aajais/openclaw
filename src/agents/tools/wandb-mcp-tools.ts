import { spawn } from "node:child_process";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const DEFAULT_SERVER_NAME = "wandb";
const DEFAULT_SERVER_URL = "https://mcp.withwandb.com/mcp";

const McpPassthroughSchema = Type.Object({
  /** Optional: override the mcporter server name (defaults to "wandb"). */
  server: Type.Optional(Type.String()),
  /** Optional: override the MCP base URL (defaults to https://mcp.withwandb.com/mcp). */
  serverUrl: Type.Optional(Type.String()),
  /** Tool-specific arguments forwarded verbatim to the MCP tool. */
  args: Type.Optional(Type.Any()),
  /** Convenience: provide args as a JSON string instead of an object. */
  argsJson: Type.Optional(Type.String()),
  /** Optional timeout in ms (default 60s). */
  timeoutMs: Type.Optional(Type.Number()),
});

type McpPassthroughParams = {
  server?: string;
  serverUrl?: string;
  args?: unknown;
  argsJson?: string;
  timeoutMs?: number;
};

function resolveMcporterConfigPath(): string {
  // Resolve relative to the configured OpenClaw workspace root.
  return path.resolve(resolveWorkspaceRoot(), "config", "mcporter.json");
}

function normalizeArgs(params: McpPassthroughParams): Record<string, unknown> {
  if (params.argsJson) {
    try {
      const parsed = JSON.parse(params.argsJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new Error("argsJson must be a JSON object");
    } catch (err) {
      throw new ToolInputError(`Invalid argsJson: ${String(err)}`);
    }
  }

  if (params.args === undefined || params.args === null) {
    return {};
  }
  if (typeof params.args === "object" && !Array.isArray(params.args)) {
    return params.args as Record<string, unknown>;
  }
  throw new ToolInputError("args must be an object");
}

async function runMcporterCall(opts: {
  toolName: string;
  params: McpPassthroughParams;
}): Promise<{ stdout: string; stderr: string }> {
  const serverName = (opts.params.server ?? DEFAULT_SERVER_NAME).trim() || DEFAULT_SERVER_NAME;
  const serverUrl = (opts.params.serverUrl ?? "").trim();

  if (!process.env.WANDB_API_KEY?.trim()) {
    // We purposely rely on env, not config, so secrets don't end up committed.
    throw new ToolInputError(
      "WANDB_API_KEY env var is required to call the W&B MCP server.",
    );
  }

  const mcporterConfigPath = resolveMcporterConfigPath();

  // If the user passed serverUrl, call via --http-url so we don't require a named config.
  // Otherwise prefer the configured server entry in mcporter.json (e.g. "wandb").
  const selector = serverUrl
    ? `${serverUrl}.${opts.toolName}`
    : `${serverName}.${opts.toolName}`;

  const argsObj = normalizeArgs(opts.params);
  const timeoutMs =
    typeof opts.params.timeoutMs === "number" && Number.isFinite(opts.params.timeoutMs)
      ? Math.max(1, opts.params.timeoutMs)
      : 60_000;

  const argv = [
    "--config",
    mcporterConfigPath,
    "call",
    selector,
    "--args",
    JSON.stringify(argsObj),
    "--output",
    "json",
    "--timeout",
    String(timeoutMs),
  ];

  const child = spawn("mcporter", argv, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Required for Authorization template expansion in mcporter headers.
      WANDB_API_KEY: process.env.WANDB_API_KEY,
    },
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mcporter call timed out after ${timeoutMs}ms`));
    }, timeoutMs + 5_000);

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`mcporter call failed (code ${code}): ${stderr || stdout}`));
    });
  });
}

function createWandbMcpTool(params: {
  id: string;
  description: string;
  mcpToolName: string;
}): AnyAgentTool {
  return {
    label: params.id,
    name: params.id,
    description: params.description,
    parameters: McpPassthroughSchema,
    async execute(_callId, rawParams) {
      const { stdout } = await runMcporterCall({
        toolName: params.mcpToolName,
        params: rawParams as McpPassthroughParams,
      });

      const raw = stdout || "{}";
      try {
        return jsonResult(JSON.parse(raw));
      } catch {
        // Fallback: return raw text while still satisfying the AgentToolResult shape.
        return jsonResult({ raw });
      }
    },
  };
}

export function createWandbMcpTools(): AnyAgentTool[] {
  return [
    createWandbMcpTool({
      id: "query_wandb_tool",
      mcpToolName: "query_wandb_tool",
      description: "Query W&B runs, metrics, and experiments (via W&B MCP)",
    }),
    createWandbMcpTool({
      id: "query_weave_traces_tool",
      mcpToolName: "query_weave_traces_tool",
      description: "Query/analyze Weave traces and evaluations (via W&B MCP)",
    }),
    createWandbMcpTool({
      id: "count_weave_traces_tool",
      mcpToolName: "count_weave_traces_tool",
      description: "Count Weave traces + storage metrics (via W&B MCP)",
    }),
    createWandbMcpTool({
      id: "create_wandb_report_tool",
      mcpToolName: "create_wandb_report_tool",
      description: "Create a W&B report programmatically (via W&B MCP)",
    }),
    createWandbMcpTool({
      id: "query_wandb_entity_projects",
      mcpToolName: "query_wandb_entity_projects",
      description: "List W&B projects for an entity (via W&B MCP)",
    }),
    createWandbMcpTool({
      id: "query_wandb_support_bot",
      mcpToolName: "query_wandb_support_bot",
      description: "Ask W&B SupportBot / docs Q&A (via W&B MCP)",
    }),
  ];
}
