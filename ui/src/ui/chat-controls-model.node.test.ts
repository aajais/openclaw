import { describe, expect, it } from "vitest";
import { resolveSessionModelRef } from "./app-render.helpers.ts";

describe("resolveSessionModelRef", () => {
  it("combines provider + model when model lacks slash", () => {
    expect(resolveSessionModelRef({ modelProvider: "openai", model: "gpt-5.2" } as any)).toBe(
      "openai/gpt-5.2",
    );
  });

  it("returns model when it already contains provider prefix", () => {
    expect(resolveSessionModelRef({ model: "openai/gpt-5.2" } as any)).toBe("openai/gpt-5.2");
  });
});

