import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../chat/message-normalizer.ts";
import { icons } from "../icons.ts";
import { detectTextDirection } from "../text-direction.ts";
import type { SessionsListResult } from "../types.ts";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type FallbackIndicatorStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  sessionBadges?: Record<string, { running: boolean; error: boolean }>;
  onAbortSession?: (sessionKey: string) => void;
  onRenameSession?: (sessionKey: string, nextLabel: string | null) => void;
  onDeleteSession?: (sessionKey: string, opts?: { skipConfirm?: boolean }) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  fallbackStatus?: FallbackIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  // Image attachments
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  // Scroll control
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onNewSession: () => void;
  chatSessionsSort?: "recent" | "name";
  chatSessionCategories?: Record<string, import("../storage.ts").ChatCategory>;
  onChatSessionsSortChange?: (next: "recent" | "name") => void;
  onChatSessionCategoryChange?: (
    sessionKey: string,
    category: import("../storage.ts").ChatCategory,
  ) => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  // Resize-to-content, but cap height to avoid giant composers on mobile.
  el.style.height = "auto";

  let max = 0;
  try {
    const raw = getComputedStyle(el).maxHeight;
    if (raw && raw !== "none") {
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed)) {
        max = parsed;
      }
    }
  } catch {
    // ignore
  }

  const next = max > 0 ? Math.min(el.scrollHeight, max) : el.scrollHeight;
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight > next ? "auto" : "hidden";
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="compaction-indicator compaction-indicator--active" role="status" aria-live="polite">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="compaction-indicator compaction-indicator--complete" role="status" aria-live="polite">
          ${icons.check} Context compacted
        </div>
      `;
    }
  }

  return nothing;
}

function renderFallbackIndicator(status: FallbackIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <div
      class=${className}
      role="status"
      aria-live="polite"
      title=${details}
    >
      ${icon} ${message}
    </div>
  `;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }

  const imageItems: DataTransferItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }

  if (imageItems.length === 0) {
    return;
  }

  e.preventDefault();

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      const newAttachment: ChatAttachment = {
        id: generateAttachmentId(),
        dataUrl,
        mimeType: file.type,
      };
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    });
    reader.readAsDataURL(file);
  }
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment">
            <img
              src=${att.dataUrl}
              alt="Attachment preview"
              class="chat-attachment__img"
            />
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label="Remove attachment"
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const composePlaceholder = props.connected
    ? hasAttachments
      ? "Add a message or paste more images..."
      : "Message (↩ to send, Shift+↩ for line breaks, paste images)"
    : "Connect to the gateway to start chatting…";

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const thread = html`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
    >
      ${
        props.loading
          ? html`
              <div class="muted">Loading chat…</div>
            `
          : nothing
      }
      ${repeat(
        buildChatItems(props),
        (item) => item.key,
        (item) => {
          if (item.kind === "divider") {
            return html`
              <div class="chat-divider" role="separator" data-ts=${String(item.timestamp)}>
                <span class="chat-divider__line"></span>
                <span class="chat-divider__label">${item.label}</span>
                <span class="chat-divider__line"></span>
              </div>
            `;
          }

          if (item.kind === "reading-indicator") {
            return renderReadingIndicatorGroup(assistantIdentity);
          }

          if (item.kind === "stream") {
            return renderStreamingGroup(
              item.text,
              item.startedAt,
              props.onOpenSidebar,
              assistantIdentity,
            );
          }

          if (item.kind === "group") {
            return renderMessageGroup(item, {
              onOpenSidebar: props.onOpenSidebar,
              showReasoning,
              assistantName: props.assistantName,
              assistantAvatar: assistantIdentity.avatar,
            });
          }

          return nothing;
        },
      )}
    </div>
  `;

  return html`
    <section class="card chat">
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}

      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}

      ${
        props.focusMode
          ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ${icons.x}
            </button>
          `
          : nothing
      }

      <div class="chat-layout">
        <aside class="chat-sessions" aria-label="Chats">
          <div class="chat-sessions__header">
            <div class="chat-sessions__title">Chats</div>
            <label class="chat-sessions__sort" aria-label="Sort chats">
              <span class="sr-only">Sort</span>
              <select
                .value=${props.chatSessionsSort ?? "recent"}
                @change=${(e: Event) => {
                  const next = (e.target as HTMLSelectElement).value === "name" ? "name" : "recent";
                  props.onChatSessionsSortChange?.(next);
                }}
              >
                <option value="recent">Recent</option>
                <option value="name">Name</option>
              </select>
            </label>
            <button class="btn" type="button" ?disabled=${!props.connected} @click=${props.onNewSession}>
              New
            </button>
          </div>
          <div class="chat-sessions__list" role="list">
            ${(() => {
              const badges = props.sessionBadges ?? {};
              const fromBackend = props.sessions?.sessions ?? [];
              const rowsByKey = new Map(fromBackend.map((row) => [row.key, row] as const));
              const keys = new Set<string>([
                ...fromBackend.map((row) => row.key),
                ...Object.keys(badges),
              ]);
              if (!keys.has(props.sessionKey)) {
                keys.add(props.sessionKey);
              }
              const ordered = Array.from(keys);
              const sortMode = props.chatSessionsSort ?? "recent";
              ordered.sort((a, b) => {
                const aRow = rowsByKey.get(a);
                const bRow = rowsByKey.get(b);

                if (sortMode === "name") {
                  const aLabel = (aRow?.label ?? a).toLowerCase();
                  const bLabel = (bRow?.label ?? b).toLowerCase();
                  const byLabel = aLabel.localeCompare(bLabel);
                  if (byLabel !== 0) {
                    return byLabel;
                  }
                  return a.localeCompare(b);
                }

                const aUpdated = aRow?.updatedAt ?? null;
                const bUpdated = bRow?.updatedAt ?? null;
                if (typeof aUpdated === "number" && typeof bUpdated === "number") {
                  return bUpdated - aUpdated;
                }

                const aCreated = aRow?.createdAt ?? null;
                const bCreated = bRow?.createdAt ?? null;
                if (typeof aCreated === "number" && typeof bCreated === "number") {
                  return bCreated - aCreated;
                }

                return a.localeCompare(b);
              });
              return ordered.map((key) => {
                const row = rowsByKey.get(key);
                const label = row?.label ? row.label : key;
                const badge = badges[key];
                const category = row?.category ?? props.chatSessionCategories?.[key] ?? "other";
                return html`
                  <div
                    class="chat-sessions__item chat-sessions__item--cat-${category} ${key === props.sessionKey ? "chat-sessions__item--active" : ""}"
                    role="listitem"
                    title=${key}
                    tabindex="0"
                    @click=${() => props.onSessionKeyChange(key)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        props.onSessionKeyChange(key);
                      }
                    }}
                  >
                    <span class="chat-sessions__label">${label}</span>

                    <span class="chat-sessions__actions" aria-label="Chat actions">
                      <details
                        class="chat-sessions__menu"
                        @click=${(e: Event) => e.stopPropagation()}
                        @toggle=${(e: Event) => {
                          const el = e.currentTarget as HTMLDetailsElement;
                          if (!el.open) {
                            return;
                          }
                          // Position menu with fixed coords so it isn't clipped by overflow containers.
                          window.requestAnimationFrame(() => {
                            const trigger = el.querySelector<HTMLElement>(
                              ".chat-sessions__menuTrigger",
                            );
                            const menu = el.querySelector<HTMLElement>(".chat-sessions__menuItems");
                            if (!trigger || !menu) {
                              return;
                            }
                            const r = trigger.getBoundingClientRect();
                            const gap = 6;
                            const top = Math.min(
                              window.innerHeight - menu.offsetHeight - 8,
                              r.bottom + gap,
                            );
                            const left = Math.min(
                              window.innerWidth - menu.offsetWidth - 8,
                              r.right - menu.offsetWidth,
                            );
                            menu.style.top = `${Math.max(8, top)}px`;
                            menu.style.left = `${Math.max(8, left)}px`;
                          });
                        }}
                      >
                        <summary
                          class="chat-sessions__menuTrigger"
                          role="button"
                          aria-label="Chat options"
                          title="Options"
                          @click=${(e: Event) => e.stopPropagation()}
                        >
                          ${icons.dotsHorizontal}
                        </summary>
                        <div class="chat-sessions__menuItems" role="menu">
                          <button
                            class="chat-sessions__menuItem"
                            type="button"
                            role="menuitem"
                            ?disabled=${!props.connected}
                            @click=${(e: Event) => {
                              e.stopPropagation();
                              (e.currentTarget as HTMLElement)
                                .closest("details")
                                ?.removeAttribute("open");
                              if (!props.onRenameSession) {
                                return;
                              }
                              const currentLabel = row?.label ?? "";
                              const next = window.prompt("Chat title", currentLabel);
                              if (next === null) {
                                return;
                              }
                              const trimmed = next.trim();
                              props.onRenameSession(key, trimmed.length ? trimmed : null);
                            }}
                          >
                            Rename
                          </button>

                          <div class="chat-sessions__menuSection" role="presentation">
                            <div class="chat-sessions__menuSectionTitle">Category</div>
                            ${(
                              [
                                ["personal", "Personal"],
                                ["dev", "Dev"],
                                ["informational", "Informational"],
                                ["other", "Other"],
                              ] as const
                            ).map(([value, label]) => {
                              const active = category === value;
                              return html`
                                <button
                                  class="chat-sessions__menuItem ${active ? "chat-sessions__menuItem--active" : ""}"
                                  type="button"
                                  role="menuitem"
                                  ?disabled=${!props.connected}
                                  @click=${(e: Event) => {
                                    e.stopPropagation();
                                    (e.currentTarget as HTMLElement)
                                      .closest("details")
                                      ?.removeAttribute("open");
                                    props.onChatSessionCategoryChange?.(key, value);
                                  }}
                                >
                                  ${label}
                                </button>
                              `;
                            })}
                          </div>
                          <button
                            class="chat-sessions__menuItem chat-sessions__menuItem--danger"
                            type="button"
                            role="menuitem"
                            ?disabled=${!props.connected}
                            @click=${(e: Event) => {
                              e.stopPropagation();
                              (e.currentTarget as HTMLElement)
                                .closest("details")
                                ?.removeAttribute("open");

                              // Confirm synchronously in the click handler.
                              // iOS Safari can block confirm dialogs if they happen after an async hop.
                              const confirmed = window.confirm(
                                `Delete session "${key}"?\n\nDeletes the session entry and archives its transcript.`,
                              );
                              if (!confirmed) {
                                return;
                              }
                              props.onDeleteSession?.(key, { skipConfirm: true });
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </details>

                      ${(() => {
                        const showStop =
                          Boolean(props.onAbortSession) &&
                          (key === props.sessionKey || badge?.running);
                        if (!showStop) {
                          return nothing;
                        }
                        const running = Boolean(badge?.running);
                        return html`
                          <button
                            type="button"
                            class="chat-sessions__stop ${running ? "chat-sessions__stop--running" : "chat-sessions__stop--idle"}"
                            title=${running ? "Stop" : "Not running"}
                            ?disabled=${!running}
                            @click=${(e: Event) => {
                              e.stopPropagation();
                              if (!running) {
                                return;
                              }
                              props.onAbortSession?.(key);
                            }}
                          >
                            ${icons.stop}
                          </button>
                        `;
                      })()}

                      ${
                        badge?.error
                          ? html`
                              <span class="chat-sessions__badge chat-sessions__badge--error">error</span>
                            `
                          : nothing
                      }
                    </span>
                  </div>
                `;
              });
            })()}
          </div>
        </aside>

        <div class="chat-content">
          <div
            class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
          >
            <div
              class="chat-main"
              style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
            >
              ${thread}
            </div>

            ${
              sidebarOpen
                ? html`
                  <resizable-divider
                    .splitRatio=${splitRatio}
                    @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
                  ></resizable-divider>
                  <div class="chat-sidebar">
                    ${renderMarkdownSidebar({
                      content: props.sidebarContent ?? null,
                      error: props.sidebarError ?? null,
                      onClose: props.onCloseSidebar!,
                      onViewRawText: () => {
                        if (!props.sidebarContent || !props.onOpenSidebar) {
                          return;
                        }
                        props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                      },
                    })}
                  </div>
                `
                : nothing
            }
          </div>
        </div>
      </div>

      ${
        props.queue.length
          ? html`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map(
                  (item) => html`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">
                        ${
                          item.text ||
                          (item.attachments?.length ? `Image (${item.attachments.length})` : "")
                        }
                      </div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
          : nothing
      }

      ${renderFallbackIndicator(props.fallbackStatus)}
      ${renderCompactionIndicator(props.compactionStatus)}

      ${
        props.showNewMessages
          ? html`
            <button
              class="btn chat-new-messages"
              type="button"
              @click=${props.onScrollToBottom}
            >
              New messages ${icons.arrowDown}
            </button>
          `
          : nothing
      }

      <div class="chat-compose">
        ${renderAttachmentPreview(props)}
        <div class="chat-compose__row">
          <label class="field chat-compose__field">
            <span>Message</span>
            <textarea
              ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement))}
              .value=${props.draft}
              dir=${detectTextDirection(props.draft)}
              ?disabled=${!props.connected}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key !== "Enter") {
                  return;
                }
                if (e.isComposing || e.keyCode === 229) {
                  return;
                }
                if (e.shiftKey) {
                  return;
                } // Allow Shift+Enter for line breaks
                if (!props.connected) {
                  return;
                }
                e.preventDefault();
                if (canCompose) {
                  props.onSend();
                }
              }}
              @input=${(e: Event) => {
                const target = e.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                props.onDraftChange(target.value);
              }}
              @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
              placeholder=${composePlaceholder}
            ></textarea>
          </label>
          <div class="chat-compose__actions">
            ${
              canAbort
                ? html`
                  <button class="btn" ?disabled=${!props.connected} @click=${props.onAbort}>
                    Stop
                  </button>
                `
                : nothing
            }
            <button
              class="btn primary"
              ?disabled=${!props.connected}
              @click=${props.onSend}
            >
              ${isBusy ? "Queue" : "Send"}<kbd class="btn-kbd">↵</kbd>
            </button>
          </div>
        </div>
      </div>
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const timestamp = normalized.timestamp || Date.now();

    if (!currentGroup || currentGroup.role !== role) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__openclaw as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compaction",
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.showThinking && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  if (props.showThinking) {
    for (let i = 0; i < tools.length; i++) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return groupMessages(items);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
