type WeaveLlmEvent = {
  kind: "llm";
  sessionKey: string;
  runId: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  prompt?: string;
  outputText?: string;
  reasoningSummary?: string;
  usage?: unknown;
};

type WeaveToolEvent = {
  kind: "tool";
  sessionKey: string;
  runId: string;
  toolName: string;
  toolCallId?: string;
  toolArgs?: unknown;
  output?: unknown;
};

type WeaveEvent = WeaveLlmEvent | WeaveToolEvent;

const runBuffers = new Map<string, WeaveEvent[]>();

export function enqueueWeaveEvent(runId: string, evt: WeaveEvent): void {
  const buf = runBuffers.get(runId);
  if (buf) {
    buf.push(evt);
    return;
  }
  runBuffers.set(runId, [evt]);
}

export function drainWeaveEvents(runId: string): WeaveEvent[] {
  const buf = runBuffers.get(runId) ?? [];
  runBuffers.delete(runId);
  return buf;
}
