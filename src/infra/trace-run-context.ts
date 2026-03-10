type ActiveRunContext = {
  runId: string;
  startedAt: number;
};

// Best-effort, in-memory mapping from sessionKey (thread_id) -> active runId (turn_id).
// This is used to correlate tool calls (which only receive sessionKey today) back to
// the current run/turn.
//
// NOTE: OpenClaw generally processes one turn at a time per sessionKey. If that
// assumption changes, this should become a stack keyed by (sessionKey, lane) or
// (sessionKey, sessionId) as needed.
const activeBySessionKey = new Map<string, ActiveRunContext>();

export function setActiveRunForSession(sessionKey: string, runId: string) {
  const key = sessionKey?.trim();
  const id = runId?.trim();
  if (!key || !id) {
    return;
  }
  activeBySessionKey.set(key, { runId: id, startedAt: Date.now() });
}

export function clearActiveRunForSession(sessionKey: string, runId?: string) {
  const key = sessionKey?.trim();
  if (!key) {
    return;
  }
  const existing = activeBySessionKey.get(key);
  if (!existing) {
    return;
  }
  if (runId && existing.runId !== runId) {
    return;
  }
  activeBySessionKey.delete(key);
}

export function getActiveRunIdForSession(sessionKey: string): string | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  return activeBySessionKey.get(key)?.runId;
}

export const __testing = {
  activeBySessionKey,
} as const;
