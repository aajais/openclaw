import { context, metrics, trace, SpanStatusCode } from "@opentelemetry/api";
import type { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { DiagnosticEventPayload, OpenClawPluginService } from "openclaw/plugin-sdk";
import { onDiagnosticEvent, redactSensitiveText, registerLogTransport } from "openclaw/plugin-sdk";

const DEFAULT_SERVICE_NAME = "openclaw";

function normalizeEndpoint(endpoint?: string): string | undefined {
  const trimmed = endpoint?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function resolveOtelUrl(endpoint: string | undefined, path: string): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  const endpointWithoutQueryOrFragment = endpoint.split(/[?#]/, 1)[0] ?? endpoint;
  if (/\/v1\/(?:traces|metrics|logs)$/i.test(endpointWithoutQueryOrFragment)) {
    return endpoint;
  }
  return `${endpoint}/${path}`;
}

function resolveSampleRate(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function redactOtelAttributes(attributes: Record<string, string | number | boolean>) {
  const redactedAttributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    redactedAttributes[key] = typeof value === "string" ? redactSensitiveText(value) : value;
  }
  return redactedAttributes;
}

export function createDiagnosticsOtelService(): OpenClawPluginService {
  let sdk: NodeSDK | null = null;
  let logProvider: LoggerProvider | null = null;
  let stopLogTransport: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    id: "diagnostics-otel",
    async start(ctx) {
      const cfg = ctx.config.diagnostics;
      const otel = cfg?.otel;
      if (!cfg?.enabled || !otel?.enabled) {
        return;
      }

      const protocol = otel.protocol ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf";
      if (protocol !== "http/protobuf") {
        ctx.logger.warn(`diagnostics-otel: unsupported protocol ${protocol}`);
        return;
      }

      const endpoint = normalizeEndpoint(otel.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
      const headers = otel.headers ?? undefined;
      const serviceName =
        otel.serviceName?.trim() || process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
      const sampleRate = resolveSampleRate(otel.sampleRate);

      const tracesEnabled = otel.traces !== false;
      const metricsEnabled = otel.metrics !== false;
      const logsEnabled = otel.logs === true;
      if (!tracesEnabled && !metricsEnabled && !logsEnabled) {
        return;
      }

      const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
      });

      const traceUrl = resolveOtelUrl(endpoint, "v1/traces");
      const metricUrl = resolveOtelUrl(endpoint, "v1/metrics");
      const logUrl = resolveOtelUrl(endpoint, "v1/logs");
      const traceExporter = tracesEnabled
        ? new OTLPTraceExporter({
            ...(traceUrl ? { url: traceUrl } : {}),
            ...(headers ? { headers } : {}),
          })
        : undefined;

      const metricExporter = metricsEnabled
        ? new OTLPMetricExporter({
            ...(metricUrl ? { url: metricUrl } : {}),
            ...(headers ? { headers } : {}),
          })
        : undefined;

      const metricReader = metricExporter
        ? new PeriodicExportingMetricReader({
            exporter: metricExporter,
            ...(typeof otel.flushIntervalMs === "number"
              ? { exportIntervalMillis: Math.max(1000, otel.flushIntervalMs) }
              : {}),
          })
        : undefined;

      if (tracesEnabled || metricsEnabled) {
        sdk = new NodeSDK({
          resource,
          ...(traceExporter ? { traceExporter } : {}),
          ...(metricReader ? { metricReader } : {}),
          ...(sampleRate !== undefined
            ? {
                sampler: new ParentBasedSampler({
                  root: new TraceIdRatioBasedSampler(sampleRate),
                }),
              }
            : {}),
        });

        try {
          await sdk.start();
        } catch (err) {
          ctx.logger.error(`diagnostics-otel: failed to start SDK: ${formatError(err)}`);
          throw err;
        }
      }

      const logSeverityMap: Record<string, SeverityNumber> = {
        TRACE: 1 as SeverityNumber,
        DEBUG: 5 as SeverityNumber,
        INFO: 9 as SeverityNumber,
        WARN: 13 as SeverityNumber,
        ERROR: 17 as SeverityNumber,
        FATAL: 21 as SeverityNumber,
      };

      const meter = metrics.getMeter("openclaw");
      const tracer = trace.getTracer("openclaw");

      const weaveTraceEnabled = ctx.config.diagnostics?.trace?.enabled === true;

      const tokensCounter = meter.createCounter("openclaw.tokens", {
        unit: "1",
        description: "Token usage by type",
      });
      const costCounter = meter.createCounter("openclaw.cost.usd", {
        unit: "1",
        description: "Estimated model cost (USD)",
      });
      const durationHistogram = meter.createHistogram("openclaw.run.duration_ms", {
        unit: "ms",
        description: "Agent run duration",
      });
      const contextHistogram = meter.createHistogram("openclaw.context.tokens", {
        unit: "1",
        description: "Context window size and usage",
      });
      const webhookReceivedCounter = meter.createCounter("openclaw.webhook.received", {
        unit: "1",
        description: "Webhook requests received",
      });
      const webhookErrorCounter = meter.createCounter("openclaw.webhook.error", {
        unit: "1",
        description: "Webhook processing errors",
      });
      const webhookDurationHistogram = meter.createHistogram("openclaw.webhook.duration_ms", {
        unit: "ms",
        description: "Webhook processing duration",
      });
      const messageQueuedCounter = meter.createCounter("openclaw.message.queued", {
        unit: "1",
        description: "Messages queued for processing",
      });
      const messageProcessedCounter = meter.createCounter("openclaw.message.processed", {
        unit: "1",
        description: "Messages processed by outcome",
      });
      const messageDurationHistogram = meter.createHistogram("openclaw.message.duration_ms", {
        unit: "ms",
        description: "Message processing duration",
      });
      const queueDepthHistogram = meter.createHistogram("openclaw.queue.depth", {
        unit: "1",
        description: "Queue depth on enqueue/dequeue",
      });
      const queueWaitHistogram = meter.createHistogram("openclaw.queue.wait_ms", {
        unit: "ms",
        description: "Queue wait time before execution",
      });
      const laneEnqueueCounter = meter.createCounter("openclaw.queue.lane.enqueue", {
        unit: "1",
        description: "Command queue lane enqueue events",
      });
      const laneDequeueCounter = meter.createCounter("openclaw.queue.lane.dequeue", {
        unit: "1",
        description: "Command queue lane dequeue events",
      });
      const sessionStateCounter = meter.createCounter("openclaw.session.state", {
        unit: "1",
        description: "Session state transitions",
      });
      const sessionStuckCounter = meter.createCounter("openclaw.session.stuck", {
        unit: "1",
        description: "Sessions stuck in processing",
      });
      const sessionStuckAgeHistogram = meter.createHistogram("openclaw.session.stuck_age_ms", {
        unit: "ms",
        description: "Age of stuck sessions",
      });
      const runAttemptCounter = meter.createCounter("openclaw.run.attempt", {
        unit: "1",
        description: "Run attempts",
      });

      let otelLogger: ReturnType<LoggerProvider["getLogger"]> | null = null;

      if (logsEnabled) {
        const logExporter = new OTLPLogExporter({
          ...(logUrl ? { url: logUrl } : {}),
          ...(headers ? { headers } : {}),
        });
        const logProcessor = new BatchLogRecordProcessor(
          logExporter,
          typeof otel.flushIntervalMs === "number"
            ? { scheduledDelayMillis: Math.max(1000, otel.flushIntervalMs) }
            : {},
        );
        logProvider = new LoggerProvider({
          resource,
          processors: [logProcessor],
        });
        otelLogger = logProvider.getLogger("openclaw");

        stopLogTransport = registerLogTransport((logObj) => {
          try {
            const safeStringify = (value: unknown) => {
              try {
                return JSON.stringify(value);
              } catch {
                return String(value);
              }
            };
            const meta = (logObj as Record<string, unknown>)._meta as
              | {
                  logLevelName?: string;
                  date?: Date;
                  name?: string;
                  parentNames?: string[];
                  path?: {
                    filePath?: string;
                    fileLine?: string;
                    fileColumn?: string;
                    filePathWithLine?: string;
                    method?: string;
                  };
                }
              | undefined;
            const logLevelName = meta?.logLevelName ?? "INFO";
            const severityNumber = logSeverityMap[logLevelName] ?? (9 as SeverityNumber);

            const numericArgs = Object.entries(logObj)
              .filter(([key]) => /^\d+$/.test(key))
              .toSorted((a, b) => Number(a[0]) - Number(b[0]))
              .map(([, value]) => value);

            let bindings: Record<string, unknown> | undefined;
            if (typeof numericArgs[0] === "string" && numericArgs[0].trim().startsWith("{")) {
              try {
                const parsed = JSON.parse(numericArgs[0]);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  bindings = parsed as Record<string, unknown>;
                  numericArgs.shift();
                }
              } catch {
                // ignore malformed json bindings
              }
            }

            let message = "";
            if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") {
              message = String(numericArgs.pop());
            } else if (numericArgs.length === 1) {
              message = safeStringify(numericArgs[0]);
              numericArgs.length = 0;
            }
            if (!message) {
              message = "log";
            }

            const attributes: Record<string, string | number | boolean> = {
              "openclaw.log.level": logLevelName,
            };
            if (meta?.name) {
              attributes["openclaw.logger"] = meta.name;
            }
            if (meta?.parentNames?.length) {
              attributes["openclaw.logger.parents"] = meta.parentNames.join(".");
            }
            if (bindings) {
              for (const [key, value] of Object.entries(bindings)) {
                if (
                  typeof value === "string" ||
                  typeof value === "number" ||
                  typeof value === "boolean"
                ) {
                  attributes[`openclaw.${key}`] = value;
                } else if (value != null) {
                  attributes[`openclaw.${key}`] = safeStringify(value);
                }
              }
            }
            if (numericArgs.length > 0) {
              attributes["openclaw.log.args"] = safeStringify(numericArgs);
            }
            if (meta?.path?.filePath) {
              attributes["code.filepath"] = meta.path.filePath;
            }
            if (meta?.path?.fileLine) {
              attributes["code.lineno"] = Number(meta.path.fileLine);
            }
            if (meta?.path?.method) {
              attributes["code.function"] = meta.path.method;
            }
            if (meta?.path?.filePathWithLine) {
              attributes["openclaw.code.location"] = meta.path.filePathWithLine;
            }

            // OTLP can leave the host boundary, so redact string fields before export.
            otelLogger.emit({
              body: redactSensitiveText(message),
              severityText: logLevelName,
              severityNumber,
              attributes: redactOtelAttributes(attributes),
              timestamp: meta?.date ?? new Date(),
            });
          } catch (err) {
            ctx.logger.error(`diagnostics-otel: log transport failed: ${formatError(err)}`);
          }
        });
      }

      const spanWithDuration = (
        name: string,
        attributes: Record<string, string | number | boolean>,
        durationMs?: number,
      ) => {
        const startTime =
          typeof durationMs === "number" ? Date.now() - Math.max(0, durationMs) : undefined;
        const span = tracer.startSpan(name, {
          attributes,
          ...(startTime ? { startTime } : {}),
        });
        return span;
      };

      const activeTurnSpans = new Map<string, ReturnType<typeof tracer.startSpan>>();
      const activeLlmSpans = new Map<string, Array<ReturnType<typeof tracer.startSpan>>>();
      const activeToolSpans = new Map<string, ReturnType<typeof tracer.startSpan>>();

      const keyForTurn = (sessionKey: string | undefined, runId: string | undefined) =>
        `${sessionKey ?? ""}::${runId ?? ""}`;

      const safeJson = (value: unknown): string => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      };

      const emitSpanLog = (
        span: ReturnType<typeof tracer.startSpan> | undefined,
        body: string,
        attrs?: Record<string, string | number | boolean>,
      ) => {
        if (!otelLogger || !span) {
          return;
        }
        const attributes = attrs ? redactOtelAttributes(attrs) : undefined;
        // Bind the log record to the span context so backends can associate it.
        context.with(trace.setSpan(context.active(), span), () => {
          otelLogger?.emit({
            body: redactSensitiveText(body),
            severityText: "INFO",
            severityNumber: 9 as SeverityNumber,
            attributes,
            timestamp: new Date(),
          });
        });
      };

      const recordModelUsage = (evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.provider": evt.provider ?? "unknown",
          "openclaw.model": evt.model ?? "unknown",
        };

        const usage = evt.usage;
        if (usage.input) {
          tokensCounter.add(usage.input, { ...attrs, "openclaw.token": "input" });
        }
        if (usage.output) {
          tokensCounter.add(usage.output, { ...attrs, "openclaw.token": "output" });
        }
        if (usage.cacheRead) {
          tokensCounter.add(usage.cacheRead, { ...attrs, "openclaw.token": "cache_read" });
        }
        if (usage.cacheWrite) {
          tokensCounter.add(usage.cacheWrite, { ...attrs, "openclaw.token": "cache_write" });
        }
        if (usage.promptTokens) {
          tokensCounter.add(usage.promptTokens, { ...attrs, "openclaw.token": "prompt" });
        }
        if (usage.total) {
          tokensCounter.add(usage.total, { ...attrs, "openclaw.token": "total" });
        }

        if (evt.costUsd) {
          costCounter.add(evt.costUsd, attrs);
        }
        if (evt.durationMs) {
          durationHistogram.record(evt.durationMs, attrs);
        }
        if (evt.context?.limit) {
          contextHistogram.record(evt.context.limit, {
            ...attrs,
            "openclaw.context": "limit",
          });
        }
        if (evt.context?.used) {
          contextHistogram.record(evt.context.used, {
            ...attrs,
            "openclaw.context": "used",
          });
        }

        // When weave trace spans are enabled, prefer attaching usage to the LLM call span
        // (gen_ai.usage.*) and avoid emitting extra root spans per message.
        if (!tracesEnabled || weaveTraceEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "openclaw.sessionKey": evt.sessionKey ?? "",
          "openclaw.sessionId": evt.sessionId ?? "",
          "openclaw.tokens.input": usage.input ?? 0,
          "openclaw.tokens.output": usage.output ?? 0,
          "openclaw.tokens.cache_read": usage.cacheRead ?? 0,
          "openclaw.tokens.cache_write": usage.cacheWrite ?? 0,
          "openclaw.tokens.total": usage.total ?? 0,
        };

        const span = spanWithDuration("openclaw.model.usage", spanAttrs, evt.durationMs);
        span.end();
      };

      const recordWebhookReceived = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.received" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown",
        };
        webhookReceivedCounter.add(1, attrs);
      };

      const recordWebhookProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.processed" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown",
        };
        if (typeof evt.durationMs === "number") {
          webhookDurationHistogram.record(evt.durationMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        const span = spanWithDuration("openclaw.webhook.processed", spanAttrs, evt.durationMs);
        span.end();
      };

      const recordWebhookError = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.error" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.webhook": evt.updateType ?? "unknown",
        };
        webhookErrorCounter.add(1, attrs);
        if (!tracesEnabled) {
          return;
        }
        const redactedError = redactSensitiveText(evt.error);
        const spanAttrs: Record<string, string | number> = {
          ...attrs,
          "openclaw.error": redactedError,
        };
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        const span = tracer.startSpan("openclaw.webhook.error", {
          attributes: spanAttrs,
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: redactedError });
        span.end();
      };

      const recordMessageQueued = (
        evt: Extract<DiagnosticEventPayload, { type: "message.queued" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.source": evt.source ?? "unknown",
        };
        messageQueuedCounter.add(1, attrs);
        if (typeof evt.queueDepth === "number") {
          queueDepthHistogram.record(evt.queueDepth, attrs);
        }
      };

      const addSessionIdentityAttrs = (
        spanAttrs: Record<string, string | number>,
        evt: { sessionKey?: string; sessionId?: string },
      ) => {
        if (evt.sessionKey) {
          spanAttrs["openclaw.sessionKey"] = evt.sessionKey;
        }
        if (evt.sessionId) {
          spanAttrs["openclaw.sessionId"] = evt.sessionId;
        }
      };

      const recordMessageProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
      ) => {
        const attrs = {
          "openclaw.channel": evt.channel ?? "unknown",
          "openclaw.outcome": evt.outcome ?? "unknown",
        };
        messageProcessedCounter.add(1, attrs);
        if (typeof evt.durationMs === "number") {
          messageDurationHistogram.record(evt.durationMs, attrs);
        }
        // When weave trace spans are enabled, trace.turn/llm/tool spans become the single
        // "one trace per turn" source of truth. Avoid emitting extra root diagnostic spans.
        if (!tracesEnabled || weaveTraceEnabled) {
          return;
        }

        const spanAttrs: Record<string, string | number | boolean> = { ...attrs };
        addSessionIdentityAttrs(spanAttrs, evt);
        if (evt.chatId !== undefined) {
          spanAttrs["openclaw.chatId"] = String(evt.chatId);
        }
        if (evt.messageId !== undefined) {
          spanAttrs["openclaw.messageId"] = String(evt.messageId);
        }
        if (evt.reason) {
          spanAttrs["openclaw.reason"] = redactSensitiveText(evt.reason);
        }
        const span = spanWithDuration("openclaw.message.processed", spanAttrs, evt.durationMs);
        if (evt.outcome === "error" && evt.error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: redactSensitiveText(evt.error) });
        }
        span.end();
      };

      const recordLaneEnqueue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>,
      ) => {
        const attrs = { "openclaw.lane": evt.lane };
        laneEnqueueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
      };

      const recordLaneDequeue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>,
      ) => {
        const attrs = { "openclaw.lane": evt.lane };
        laneDequeueCounter.add(1, attrs);
        queueDepthHistogram.record(evt.queueSize, attrs);
        if (typeof evt.waitMs === "number") {
          queueWaitHistogram.record(evt.waitMs, attrs);
        }
      };

      const recordSessionState = (
        evt: Extract<DiagnosticEventPayload, { type: "session.state" }>,
      ) => {
        const attrs: Record<string, string> = { "openclaw.state": evt.state };
        if (evt.reason) {
          attrs["openclaw.reason"] = redactSensitiveText(evt.reason);
        }
        sessionStateCounter.add(1, attrs);
      };

      const recordSessionStuck = (
        evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
      ) => {
        const attrs: Record<string, string> = { "openclaw.state": evt.state };
        sessionStuckCounter.add(1, attrs);
        if (typeof evt.ageMs === "number") {
          sessionStuckAgeHistogram.record(evt.ageMs, attrs);
        }
        if (!tracesEnabled) {
          return;
        }
        const spanAttrs: Record<string, string | number> = { ...attrs };
        addSessionIdentityAttrs(spanAttrs, evt);
        spanAttrs["openclaw.queueDepth"] = evt.queueDepth ?? 0;
        spanAttrs["openclaw.ageMs"] = evt.ageMs;
        const span = tracer.startSpan("openclaw.session.stuck", { attributes: spanAttrs });
        span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
        span.end();
      };

      const recordRunAttempt = (evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>) => {
        runAttemptCounter.add(1, { "openclaw.attempt": evt.attempt });
      };

      const recordHeartbeat = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.heartbeat" }>,
      ) => {
        queueDepthHistogram.record(evt.queued, { "openclaw.channel": "heartbeat" });
      };

      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        try {
          switch (evt.type) {
            case "model.usage":
              recordModelUsage(evt);
              return;
            case "webhook.received":
              recordWebhookReceived(evt);
              return;
            case "webhook.processed":
              recordWebhookProcessed(evt);
              return;
            case "webhook.error":
              recordWebhookError(evt);
              return;
            case "message.queued":
              recordMessageQueued(evt);
              return;
            case "message.processed":
              recordMessageProcessed(evt);
              return;
            case "queue.lane.enqueue":
              recordLaneEnqueue(evt);
              return;
            case "queue.lane.dequeue":
              recordLaneDequeue(evt);
              return;
            case "session.state":
              recordSessionState(evt);
              return;
            case "session.stuck":
              recordSessionStuck(evt);
              return;
            case "run.attempt":
              recordRunAttempt(evt);
              return;
            case "diagnostic.heartbeat":
              recordHeartbeat(evt);
              return;

            case "trace.turn": {
              if (!tracesEnabled) {
                return;
              }
              const spanKey = keyForTurn(evt.sessionKey, evt.runId);
              if (evt.phase === "start") {
                const truncate = (value: string, max: number) =>
                  value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;

                const threadId = evt.sessionKey ?? "unknown";
                const inputText =
                  typeof evt.inputText === "string" ? redactSensitiveText(evt.inputText) : "";
                const displayName = inputText.trim() ? truncate(inputText.trim(), 120) : "turn";

                const attrs: Record<string, string | number | boolean> = {
                  // Weave Threads
                  "wandb.thread_id": threadId,
                  // Some backends may drop boolean-valued attributes; include both bool and string.
                  "wandb.is_turn": true,
                  "wandb.is_turn_str": "true",
                  "wandb.display_name": displayName,

                  // Weave call inputs/outputs (OpenInference-style keys Weave recognizes)
                  "input.value": inputText,

                  // Our own correlation keys
                  thread_id: threadId,
                  turn_id: evt.runId,
                  "openclaw.sessionKey": threadId,
                  "openclaw.runId": evt.runId,
                  "openclaw.channel": evt.channel ?? "unknown",
                };
                if (evt.messageId != null) {
                  attrs["openclaw.messageId"] = String(evt.messageId);
                }
                if (evt.chatId != null) {
                  attrs["openclaw.chatId"] = String(evt.chatId);
                }
                const span = tracer.startSpan("openclaw.turn", { attributes: attrs });
                activeTurnSpans.set(spanKey, span);
                return;
              }
              const span = activeTurnSpans.get(spanKey);
              if (span) {
                span.end();
              }
              activeTurnSpans.delete(spanKey);
              activeLlmSpans.delete(spanKey);
              return;
            }

            case "trace.llm": {
              if (!tracesEnabled) {
                return;
              }
              const spanKey = keyForTurn(evt.sessionKey, evt.runId);
              const parent = activeTurnSpans.get(spanKey);
              if (evt.phase === "input") {
                const span = tracer.startSpan(
                  "openclaw.llm.call",
                  {
                    attributes: {
                      // Weave Threads propagation (helps some UIs/indexers)
                      "wandb.thread_id": evt.sessionKey ?? "unknown",

                      thread_id: evt.sessionKey ?? "unknown",
                      turn_id: evt.runId,
                      "openclaw.provider": evt.provider ?? "unknown",
                      "openclaw.model": evt.model ?? "unknown",
                    },
                  },
                  parent ? trace.setSpan(context.active(), parent) : undefined,
                );
                const stack = activeLlmSpans.get(spanKey) ?? [];
                stack.push(span);
                activeLlmSpans.set(spanKey, stack);
                if (evt.systemPrompt) {
                  // Populate Weave inputs (Weave OTEL ingestion reads INPUT_KEYS like "input.value" / "input").
                  // We rely on OTEL attribute unflattening: input.system_prompt => {input: {system_prompt: ...}}
                  span.setAttribute("input.system_prompt", evt.systemPrompt);
                  emitSpanLog(span, evt.systemPrompt, { "openclaw.kind": "system_prompt" });
                }
                if (evt.prompt) {
                  span.setAttribute("input.prompt", evt.prompt);
                  emitSpanLog(span, evt.prompt, { "openclaw.kind": "prompt" });
                }
                return;
              }
              // output
              const stack = activeLlmSpans.get(spanKey);
              const span = stack?.length ? stack[stack.length - 1] : undefined;
              if (evt.outputText) {
                span?.setAttribute("output.assistant_output", evt.outputText);
                // Also populate the parent turn span output so Weave Threads can show the turn row.
                parent?.setAttribute("output.value", evt.outputText);
                emitSpanLog(span, evt.outputText, { "openclaw.kind": "assistant_output" });
              }
              if (evt.reasoningSummary) {
                span?.setAttribute("output.reasoning_summary", evt.reasoningSummary);
                emitSpanLog(span, evt.reasoningSummary, { "openclaw.kind": "reasoning_summary" });
              }
              if (evt.usage) {
                const attrs: Record<string, string | number | boolean> = {};
                if (evt.usage.input != null) attrs["openclaw.tokens.input"] = evt.usage.input;
                if (evt.usage.output != null) attrs["openclaw.tokens.output"] = evt.usage.output;
                if (evt.usage.total != null) attrs["openclaw.tokens.total"] = evt.usage.total;
                // Also map to gen_ai usage keys so Weave can normalize token usage.
                if (evt.usage.input != null) attrs["gen_ai.usage.prompt_tokens"] = evt.usage.input;
                if (evt.usage.output != null)
                  attrs["gen_ai.usage.completion_tokens"] = evt.usage.output;
                if (evt.usage.total != null) attrs["llm.usage.total_tokens"] = evt.usage.total;
                span?.setAttributes(attrs);
              }
              span?.end();
              if (stack?.length) {
                stack.pop();
                if (stack.length === 0) {
                  activeLlmSpans.delete(spanKey);
                }
              }
              return;
            }

            case "trace.tool": {
              if (!tracesEnabled) {
                return;
              }
              const runId = evt.runId;
              const spanKey = keyForTurn(evt.sessionKey, runId);
              const parent = activeTurnSpans.get(spanKey);
              const toolSpanKey = evt.toolCallId ? `${spanKey}::${evt.toolCallId}` : undefined;
              if (evt.phase === "start") {
                const span = tracer.startSpan(
                  `openclaw.tool.call`,
                  {
                    attributes: {
                      // Weave Threads propagation (helps some UIs/indexers)
                      "wandb.thread_id": evt.sessionKey ?? "unknown",

                      thread_id: evt.sessionKey ?? "unknown",
                      turn_id: runId ?? "unknown",
                      "tool.name": evt.toolName,
                      "openclaw.toolCallId": evt.toolCallId ?? "unknown",
                    },
                  },
                  parent ? trace.setSpan(context.active(), parent) : undefined,
                );
                if (toolSpanKey) {
                  activeToolSpans.set(toolSpanKey, span);
                }
                if (evt.args != null) {
                  const argsJson = safeJson(evt.args);
                  // Populate Weave inputs for tool calls.
                  span.setAttribute("input.tool_args", argsJson);
                  emitSpanLog(span, argsJson, { "openclaw.kind": "tool_args" });
                }
                return;
              }
              const span = toolSpanKey ? activeToolSpans.get(toolSpanKey) : undefined;
              if (evt.result != null) {
                const resultJson = safeJson(evt.result);
                span?.setAttribute("output.tool_result", resultJson);
                emitSpanLog(span, resultJson, { "openclaw.kind": "tool_result" });
              }
              if (evt.error) {
                span?.setAttribute("output.tool_error", evt.error);
                emitSpanLog(span, evt.error, { "openclaw.kind": "tool_error" });
                span?.setStatus({ code: SpanStatusCode.ERROR, message: "tool error" });
              }
              if (typeof evt.durationMs === "number") {
                span?.setAttribute("openclaw.durationMs", evt.durationMs);
              }
              span?.end();
              if (toolSpanKey) {
                activeToolSpans.delete(toolSpanKey);
              }
              return;
            }
          }
        } catch (err) {
          ctx.logger.error(
            `diagnostics-otel: event handler failed (${evt.type}): ${formatError(err)}`,
          );
        }
      });

      if (logsEnabled) {
        ctx.logger.info("diagnostics-otel: logs exporter enabled (OTLP/Protobuf)");
      }
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      stopLogTransport?.();
      stopLogTransport = null;
      if (logProvider) {
        await logProvider.shutdown().catch(() => undefined);
        logProvider = null;
      }
      if (sdk) {
        await sdk.shutdown().catch(() => undefined);
        sdk = null;
      }
    },
  } satisfies OpenClawPluginService;
}
