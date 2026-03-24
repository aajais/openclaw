import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as weave from "weave";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../agents/usage.js";

let weaveInitPromise: Promise<void> | null = null;
let weaveDisabledReason: string | null = null;
let weaveClientPatchPromise: Promise<void> | null = null;
let weaveProject: string | null = null;

export type WeaveNativeConfig = {
  enabled: boolean;
  project?: string;
};

type InternalWeaveClient = {
  MAX_ERRORS?: number;
  errorCount?: number;
  callQueue?: unknown[];
  batchProcessTimeout?: NodeJS.Timeout | null;
  isBatchProcessing?: boolean;
  scheduleBatchProcessing?: () => void;
  processBatch?: () => Promise<void>;
  traceServerApi?: {
    call?: {
      callStartBatchCallUpsertBatchPost?: (batchReq: unknown) => Promise<unknown>;
    };
  };
};

function isResponseLike(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "statusText" in value &&
    "clone" in value
  );
}

function trimErrorText(value: string, max = 1200): string {
  const text = value.trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...`;
}

function isCallsCompleteModeRequired(message: string): boolean {
  const text = message.toUpperCase();
  return (
    text.includes("CALLS_COMPLETE_MODE_REQUIRED") ||
    (text.includes("COMPLETE") && text.includes("MODE") && text.includes("UPGRADE"))
  );
}

async function describeWeaveError(error: unknown): Promise<string> {
  if (isResponseLike(error)) {
    let body = "";
    try {
      body = trimErrorText(await error.clone().text());
    } catch {
      // ignore body read failures
    }
    const parts = [
      `status=${error.status}`,
      `statusText=${error.statusText}`,
      error.url ? `url=${error.url}` : "",
      body ? `body=${body}` : "",
    ].filter(Boolean);
    return `Weave request failed (${parts.join(" ")})`;
  }
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function disableWeave(reason: string, client?: InternalWeaveClient | null): void {
  if (!weaveDisabledReason) {
    console.error(`[openclaw] Disabling Weave native tracing: ${reason}`);
  }
  weaveDisabledReason = reason;
  if (!client) {
    return;
  }
  try {
    client.callQueue = [];
  } catch {
    // ignore
  }
  try {
    if (client.batchProcessTimeout) {
      clearTimeout(client.batchProcessTimeout);
    }
    client.batchProcessTimeout = null;
  } catch {
    // ignore
  }
  try {
    client.isBatchProcessing = false;
  } catch {
    // ignore
  }
  try {
    client.scheduleBatchProcessing = () => {};
  } catch {
    // ignore
  }
}

async function importWeaveClientApi(): Promise<{
  getGlobalClient: () => InternalWeaveClient | null;
}> {
  const require = createRequire(import.meta.url);
  const weaveEntry = require.resolve("weave");
  const clientApiPath = path.join(path.dirname(weaveEntry), "clientApi.js");
  return import(pathToFileURL(clientApiPath).href);
}

async function patchWeaveClient(): Promise<void> {
  if (weaveDisabledReason) {
    return;
  }
  if (!weaveClientPatchPromise) {
    weaveClientPatchPromise = (async () => {
      const clientApi = await importWeaveClientApi();
      const client = clientApi.getGlobalClient();
      if (!client) {
        return;
      }

      // Prevent the SDK from hard-exiting the whole gateway after repeated upload failures.
      try {
        client.MAX_ERRORS = Number.MAX_SAFE_INTEGER;
      } catch {
        // ignore
      }

      const callApi = client.traceServerApi?.call;
      const originalUpsert = callApi?.callStartBatchCallUpsertBatchPost?.bind(callApi);
      if (callApi && originalUpsert) {
        callApi.callStartBatchCallUpsertBatchPost = async (batchReq: unknown) => {
          try {
            return await originalUpsert(batchReq);
          } catch (error) {
            const message = await describeWeaveError(error);
            if (isCallsCompleteModeRequired(message)) {
              disableWeave(
                "project requires complete-mode writes (CALLS_COMPLETE_MODE_REQUIRED); disable Weave until SDK is upgraded",
                client,
              );
            }
            throw new Error(message, { cause: error });
          }
        };
      }

      const originalProcessBatch = client.processBatch?.bind(client);
      if (originalProcessBatch) {
        client.processBatch = async () => {
          const previousErrorCount = Number(client.errorCount ?? 0);
          await originalProcessBatch();
          if (weaveDisabledReason) {
            client.callQueue = [];
            return;
          }
          const currentErrorCount = Number(client.errorCount ?? 0);
          if (currentErrorCount > previousErrorCount && currentErrorCount >= 3) {
            disableWeave(`repeated batch upload failures (${currentErrorCount})`, client);
          }
        };
      }
    })().catch((error) => {
      disableWeave(`client patch failed: ${String(error)}`);
    });
  }
  await weaveClientPatchPromise;
}

function resolveWeaveProject(cfg?: WeaveNativeConfig): string | null {
  const fromCfg = cfg?.project?.trim();
  if (fromCfg) {
    return fromCfg;
  }
  const fromEnv = (process.env.WEAVE_PROJECT ?? "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  return null;
}

export async function ensureWeaveInit(cfg?: WeaveNativeConfig): Promise<boolean> {
  if (!cfg?.enabled) {
    return false;
  }
  const project = resolveWeaveProject(cfg);
  if (!project) {
    // No project configured; treat as disabled.
    return false;
  }
  if (weaveProject !== project) {
    if (weaveProject) {
      console.warn(
        `[openclaw] Weave native project changed (${weaveProject} -> ${project}); reinitializing tracing client`,
      );
    }
    weaveProject = project;
    weaveInitPromise = null;
    weaveClientPatchPromise = null;
    weaveDisabledReason = null;
  }
  if (weaveDisabledReason) {
    return false;
  }
  if (!weaveInitPromise) {
    weaveInitPromise = (async () => {
      // Weave reads WANDB_API_KEY from env.
      await weave.init(project);
    })();
  }
  try {
    await weaveInitPromise;
    await patchWeaveClient();
    return !weaveDisabledReason;
  } catch (error) {
    weaveInitPromise = null;
    disableWeave(`init failed: ${await describeWeaveError(error)}`);
    return false;
  }
}

export function withWeaveThreadAttributes<T>(
  attrs: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  if (weaveDisabledReason) {
    return fn();
  }
  return Promise.resolve(weave.withAttributes(attrs, fn)).catch(async (error) => {
    disableWeave(`withAttributes failed: ${await describeWeaveError(error)}`);
    return fn();
  });
}

function summarizeTurnResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return { ok: true };
  }
  const record = result as Record<string, unknown>;
  const assistantTexts = Array.isArray(record.assistantTexts) ? record.assistantTexts : [];
  const toolMetas = Array.isArray(record.toolMetas) ? record.toolMetas : [];
  const lastAssistantTextRaw = assistantTexts.length
    ? assistantTexts[assistantTexts.length - 1]
    : undefined;
  const lastAssistantText =
    typeof lastAssistantTextRaw === "string" ? lastAssistantTextRaw.slice(0, 4000) : undefined;
  return {
    aborted: record.aborted,
    timedOut: record.timedOut,
    timedOutDuringCompaction: record.timedOutDuringCompaction,
    promptError: record.promptError,
    sessionIdUsed: record.sessionIdUsed,
    assistantTextCount: assistantTexts.length,
    lastAssistantText,
    toolCallCount: toolMetas.length,
    lastToolError: record.lastToolError,
    didSendViaMessagingTool: record.didSendViaMessagingTool,
    successfulCronAdds: record.successfulCronAdds,
    attemptUsage: record.attemptUsage,
    compactionCount: record.compactionCount,
    cloudCodeAssistFormatError: record.cloudCodeAssistFormatError,
  };
}

function extractWeaveUsageCost(usageRaw: unknown): {
  prompt_tokens_total_cost?: number;
  completion_tokens_total_cost?: number;
  total_cost?: number;
} | null {
  if (!usageRaw || typeof usageRaw !== "object") {
    return null;
  }
  const record = usageRaw as Record<string, unknown>;
  const cost =
    record.cost && typeof record.cost === "object"
      ? (record.cost as Record<string, unknown>)
      : undefined;
  if (!cost) {
    return null;
  }

  const input = typeof cost.input === "number" && Number.isFinite(cost.input) ? cost.input : 0;
  const cacheRead =
    typeof cost.cacheRead === "number" && Number.isFinite(cost.cacheRead) ? cost.cacheRead : 0;
  const cacheWrite =
    typeof cost.cacheWrite === "number" && Number.isFinite(cost.cacheWrite) ? cost.cacheWrite : 0;
  const output = typeof cost.output === "number" && Number.isFinite(cost.output) ? cost.output : 0;
  const total =
    typeof cost.total === "number" && Number.isFinite(cost.total) ? cost.total : undefined;
  const promptTotal = input + cacheRead + cacheWrite;
  const roundCost = (value: number): number => Number(value.toFixed(12));

  if (!(promptTotal > 0) && !(output > 0) && !(typeof total === "number" && total >= 0)) {
    return null;
  }

  return {
    ...(promptTotal > 0 ? { prompt_tokens_total_cost: roundCost(promptTotal) } : {}),
    ...(output > 0 ? { completion_tokens_total_cost: roundCost(output) } : {}),
    ...(typeof total === "number" && total >= 0 ? { total_cost: roundCost(total) } : {}),
  };
}

export function summarizeOpenclawLlmResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return {};
  }

  const record = result as Record<string, unknown>;
  const usage = normalizeUsage((record.usage as UsageLike | undefined) ?? undefined);
  const model =
    typeof record.model === "string" && record.model.trim()
      ? record.model.trim()
      : typeof record.provider === "string" && record.provider.trim()
        ? record.provider.trim()
        : "";

  if (!usage || !model) {
    return {};
  }

  const totalTokens =
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const promptTokens = derivePromptTokens({
    input: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  });
  const cost = extractWeaveUsageCost(record.usage);

  return {
    usage: {
      [model]: {
        ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
        ...(usage.output !== undefined ? { completion_tokens: usage.output } : {}),
        ...(usage.input !== undefined ? { input_tokens: usage.input } : {}),
        ...(usage.output !== undefined ? { output_tokens: usage.output } : {}),
        ...(totalTokens > 0 ? { total_tokens: totalTokens } : {}),
        ...(usage.cacheRead !== undefined
          ? { prompt_tokens_details: { cached_tokens: usage.cacheRead } }
          : {}),
        ...(usage.cacheRead !== undefined
          ? { cache_read_input_tokens: usage.cacheRead }
          : {}),
        ...(usage.cacheWrite !== undefined
          ? { cache_creation_input_tokens: usage.cacheWrite }
          : {}),
        ...(cost ?? {}),
      },
    },
  };
}

const rawOpenclawTurnOp = weave.op(async function openclaw_turn(args: {
  sessionKey: string;
  runId: string;
  inputText: string;
  fn: () => Promise<{ outputText?: string; result: unknown }>;
}) {
  const { result } = await args.fn();
  // Return a compact output payload to keep Weave call rendering stable.
  return summarizeTurnResult(result);
});

const rawOpenclawLlmOp = weave.op(
  async function openclaw_llm(args: {
    sessionKey: string;
    runId: string;
    provider?: string;
    model?: string;
    systemPrompt?: string;
    prompt?: string;
    outputText?: string;
    reasoningSummary?: string;
    usage?: unknown;
  }) {
    // Keep the raw payload visible while summarize() emits token metadata to Weave's summary path.
    return {
      provider: args.provider,
      model: args.model,
      assistant_output: args.outputText,
      reasoning_summary: args.reasoningSummary,
      usage: args.usage,
    };
  },
  {
    opKind: "llm",
    summarize: summarizeOpenclawLlmResult,
  },
);

const rawOpenclawToolOp = weave.op(async function openclaw_tool(args: {
  sessionKey: string;
  runId: string;
  toolName: string;
  toolCallId?: string;
  toolArgs?: unknown;
  fn: () => Promise<unknown>;
}) {
  const result = await args.fn();
  return result;
});

export async function openclawTurnOp(args: {
  sessionKey: string;
  runId: string;
  inputText: string;
  fn: () => Promise<{ outputText?: string; result: unknown }>;
}): Promise<unknown> {
  if (weaveDisabledReason) {
    const { result } = await args.fn();
    return result;
  }
  return rawOpenclawTurnOp(args);
}

export async function openclawLlmOp(args: {
  sessionKey: string;
  runId: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  prompt?: string;
  outputText?: string;
  reasoningSummary?: string;
  usage?: unknown;
}): Promise<unknown> {
  if (weaveDisabledReason) {
    return undefined;
  }
  try {
    return await rawOpenclawLlmOp(args);
  } catch (error) {
    disableWeave(`LLM op failed: ${await describeWeaveError(error)}`);
    return undefined;
  }
}

export async function openclawToolOp(args: {
  sessionKey: string;
  runId: string;
  toolName: string;
  toolCallId?: string;
  toolArgs?: unknown;
  fn: () => Promise<unknown>;
}): Promise<unknown> {
  if (weaveDisabledReason) {
    return args.fn();
  }
  try {
    return await rawOpenclawToolOp(args);
  } catch (error) {
    disableWeave(`tool op failed: ${await describeWeaveError(error)}`);
    return args.fn();
  }
}
