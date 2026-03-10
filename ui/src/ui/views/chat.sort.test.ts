import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderChat, type ChatProps } from "./chat.ts";

function createSessions(rows: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: rows.length,
    defaults: { model: null, contextTokens: null },
    sessions: rows,
  };
}

function baseProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    loading: false,
    sending: false,
    canAbort: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    toolMessages: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    queue: [],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: createSessions([]),
    focusMode: false,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    onRenameSession: () => undefined,
    onDeleteSession: () => undefined,
    ...overrides,
  };
}

describe("chat session sorting", () => {
  it("sorts sessions by name when enabled", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        baseProps({
          sessionKey: "main",
          chatSessionsSort: "name",
          sessions: createSessions([
            { key: "b", kind: "direct", label: "Bravo", createdAt: 1, updatedAt: 1 },
            { key: "a", kind: "direct", label: "Alpha", createdAt: 2, updatedAt: 2 },
            { key: "main", kind: "direct", label: "Main", createdAt: 3, updatedAt: 3 },
          ]),
        }),
      ),
      container,
    );

    const labels = Array.from(container.querySelectorAll(".chat-sessions__label")).map((el) =>
      (el.textContent ?? "").trim(),
    );

    // Active session is always pinned first.
    expect(labels[0]).toBe("Main");
    expect(labels.slice(1, 3)).toEqual(["Alpha", "Bravo"]);
  });
});
