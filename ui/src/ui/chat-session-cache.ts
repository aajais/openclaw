import type { ChatQueueItem } from "./ui-types.ts";

const KEY = "openclaw.control.chatcache.v1";

export type ChatSessionCache = {
  draft?: string;
  // Store a minimal queue to avoid localStorage blowups (attachments can be huge).
  queue?: Array<Pick<ChatQueueItem, "id" | "text" | "createdAt" | "refreshSessions">>;
  runId?: string | null;
};

type ChatCacheBlob = {
  v: 1;
  sessions: Record<string, ChatSessionCache>;
};

function loadBlob(): ChatCacheBlob {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return { v: 1, sessions: {} };
    }
    const parsed = JSON.parse(raw) as Partial<ChatCacheBlob>;
    if (!parsed || parsed.v !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
      return { v: 1, sessions: {} };
    }
    return { v: 1, sessions: parsed.sessions };
  } catch {
    return { v: 1, sessions: {} };
  }
}

function saveBlob(blob: ChatCacheBlob) {
  try {
    localStorage.setItem(KEY, JSON.stringify(blob));
  } catch {
    // ignore quota / storage failures
  }
}

export function loadChatSessionCache(sessionKey: string): ChatSessionCache | null {
  const key = sessionKey.trim();
  if (!key) {
    return null;
  }
  const blob = loadBlob();
  const entry = blob.sessions[key];
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return entry;
}

export function saveChatSessionCache(sessionKey: string, patch: ChatSessionCache) {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  const blob = loadBlob();
  const prev = blob.sessions[key] ?? {};
  blob.sessions[key] = {
    ...prev,
    ...patch,
  };
  saveBlob(blob);
}

export function clearChatSessionRunId(sessionKey: string) {
  saveChatSessionCache(sessionKey, { runId: null });
}
