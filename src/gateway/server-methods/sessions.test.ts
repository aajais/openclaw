import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadConfigReturn: {} as Record<string, unknown>,
  updateSessionStore: vi.fn(),
  applySessionsPatchToStore: vi.fn(),
  resolveGatewaySessionStoreTarget: vi.fn(),
  resolveSessionModelRef: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => mocks.loadConfigReturn,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
    loadSessionStore: vi.fn(() => ({})),
    resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  };
});

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  };
});

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    resolveGatewaySessionStoreTarget: mocks.resolveGatewaySessionStoreTarget,
    resolveSessionModelRef: mocks.resolveSessionModelRef,
    loadSessionEntry: mocks.loadSessionEntry,
  };
});

vi.mock("../sessions-patch.js", async () => {
  const actual = await vi.importActual<typeof import("../sessions-patch.js")>(
    "../sessions-patch.js",
  );
  return {
    ...actual,
    applySessionsPatchToStore: mocks.applySessionsPatchToStore,
  };
});

import { sessionsHandlers } from "./sessions.js";

type SessionsPatchArgs = Parameters<(typeof sessionsHandlers)["sessions.patch"]>[0];
type SessionsDeleteArgs = Parameters<(typeof sessionsHandlers)["sessions.delete"]>[0];

function makeContext(): GatewayRequestContext {
  return {
    loadGatewayModelCatalog: vi.fn(async () => []),
    logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestContext;
}

async function invokeSessionsPatch(
  params: SessionsPatchArgs["params"],
  options?: {
    client?: SessionsPatchArgs["client"];
    isWebchatConnect?: SessionsPatchArgs["isWebchatConnect"];
  },
) {
  const respond = vi.fn();
  await sessionsHandlers["sessions.patch"]({
    params,
    respond: respond as never,
    context: makeContext(),
    req: { type: "req", id: "sessions-patch-test", method: "sessions.patch" },
    client: options?.client ?? null,
    isWebchatConnect: options?.isWebchatConnect ?? (() => false),
  });
  return respond;
}

async function invokeSessionsDelete(
  params: SessionsDeleteArgs["params"],
  options?: {
    client?: SessionsDeleteArgs["client"];
    isWebchatConnect?: SessionsDeleteArgs["isWebchatConnect"];
  },
) {
  const respond = vi.fn();
  await sessionsHandlers["sessions.delete"]({
    params,
    respond: respond as never,
    context: makeContext(),
    req: { type: "req", id: "sessions-delete-test", method: "sessions.delete" },
    client: options?.client ?? null,
    isWebchatConnect: options?.isWebchatConnect ?? (() => false),
  });
  return respond;
}

describe("gateway sessions handler", () => {
  beforeEach(() => {
    mocks.loadConfigReturn = {};
    mocks.resolveGatewaySessionStoreTarget.mockReset();
    mocks.resolveGatewaySessionStoreTarget.mockReturnValue({
      canonicalKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
      storeKeys: ["agent:main:main"],
    });
    mocks.updateSessionStore.mockReset();
    mocks.updateSessionStore.mockImplementation(async (_storePath, updater) => {
      const store: Record<string, unknown> = {};
      return await updater(store);
    });
    mocks.applySessionsPatchToStore.mockReset();
    mocks.applySessionsPatchToStore.mockResolvedValue({
      ok: true,
      entry: {
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride: "gpt-test-a",
      },
    });
    mocks.resolveSessionModelRef.mockReset();
    mocks.resolveSessionModelRef.mockReturnValue({
      provider: "openai",
      model: "gpt-test-a",
    });
    mocks.loadSessionEntry.mockReset();
    mocks.loadSessionEntry.mockReturnValue({
      entry: undefined,
      legacyKey: undefined,
      canonicalKey: "agent:main:main",
    });
  });

  it("allows webchat to patch session model", async () => {
    const respond = await invokeSessionsPatch(
      {
        key: "agent:main:main",
        model: "openai/gpt-test-a",
      },
      {
        client: {
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: "openclaw-control-ui",
              version: "dev",
              platform: "web",
              mode: "webchat",
            },
          },
        },
        isWebchatConnect: () => true,
      },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalledOnce();
    expect(mocks.applySessionsPatchToStore).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: "agent:main:main",
        resolved: { modelProvider: "openai", model: "gpt-test-a" },
      }),
      undefined,
    );
  });

  it("allows webchat to patch session label", async () => {
    const respond = await invokeSessionsPatch(
      {
        key: "agent:main:main",
        label: "spotify vibe router",
      },
      {
        client: {
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: "openclaw-control-ui",
              version: "dev",
              platform: "web",
              mode: "webchat",
            },
          },
        },
        isWebchatConnect: () => true,
      },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalledOnce();
    expect(mocks.applySessionsPatchToStore).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: "agent:main:main",
      }),
      undefined,
    );
  });

  it("still blocks non-model/non-label session patch fields for webchat", async () => {
    const respond = await invokeSessionsPatch(
      {
        key: "agent:main:main",
        thinkingLevel: "high",
      },
      {
        client: {
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: "openclaw-control-ui",
              version: "dev",
              platform: "web",
              mode: "webchat",
            },
          },
        },
        isWebchatConnect: () => true,
      },
    );

    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.applySessionsPatchToStore).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringMatching(/only patch session model or label/i),
      }),
    );
  });

  it("allows webchat clients to delete sessions", async () => {
    mocks.resolveGatewaySessionStoreTarget.mockReturnValue({
      canonicalKey: "agent:main:chat-123",
      storePath: "/tmp/sessions.json",
      storeKeys: ["agent:main:chat-123"],
    });
    mocks.updateSessionStore.mockImplementation(async (_storePath, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:chat-123": {
          sessionId: "sess-1",
          updatedAt: Date.now(),
        },
      };
      return await updater(store);
    });

    const respond = await invokeSessionsDelete(
      { key: "agent:main:chat-123", deleteTranscript: false },
      {
        client: {
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: "openclaw-control-ui",
              version: "dev",
              platform: "web",
              mode: "webchat",
            },
          },
        },
        isWebchatConnect: () => true,
      },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: "agent:main:chat-123",
        deleted: true,
      }),
      undefined,
    );
  });
});
