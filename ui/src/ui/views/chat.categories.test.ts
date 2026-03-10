import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderChat, type ChatProps } from "./chat.ts";

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    defaults: { model: null, contextTokens: null },
    sessions: [
      { key: "main", kind: "direct", label: "Main", createdAt: 1, updatedAt: 1 },
      { key: "dev", kind: "direct", label: "Dev", createdAt: 2, updatedAt: 2 },
    ],
  };
}

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
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
    sessions: createSessions(),
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

describe("chat categories", () => {
  it("adds category class to session items", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          chatSessionCategories: { main: "personal", dev: "dev" },
        }),
      ),
      container,
    );

    const items = Array.from(container.querySelectorAll<HTMLElement>(".chat-sessions__item"));
    expect(items.some((el) => el.className.includes("chat-sessions__item--cat-personal"))).toBe(
      true,
    );
    expect(items.some((el) => el.className.includes("chat-sessions__item--cat-dev"))).toBe(true);
  });
});
