import { describe, expect, it } from "vitest";
import "../../styles.css";
import { mountApp, registerAppMountHooks } from "../test-helpers/app-mount.ts";

registerAppMountHooks();

describe("chat mobile layout", () => {
  it("avoids horizontal scrolling and keeps key touch targets large", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    // These tests run in a narrow Chromium viewport in CI.
    expect(window.matchMedia("(max-width: 600px)").matches).toBe(true);

    // Render a long message to stress wrapping.
    app.chatMessages = [
      {
        role: "assistant",
        content: `A very long line: ${"x".repeat(2000)}`,
        timestamp: Date.now(),
      },
    ];
    await app.updateComplete;

    const doc = document.documentElement;
    expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth + 1);

    const menuTrigger = app.querySelector<HTMLElement>(".chat-sessions__menuTrigger");
    expect(menuTrigger).not.toBeNull();
    if (menuTrigger) {
      const r = menuTrigger.getBoundingClientRect();
      // Visual size can be smaller than the tap target; the container adds padding.
      expect(r.width).toBeGreaterThanOrEqual(28);
      expect(r.height).toBeGreaterThanOrEqual(28);
    }
  });
});
