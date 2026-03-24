import { describe, expect, it } from "vitest";
import { summarizeOpenclawLlmResult } from "./weave-native.js";

describe("summarizeOpenclawLlmResult", () => {
  it("maps normalized usage into Weave summary usage", () => {
    expect(
      summarizeOpenclawLlmResult({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 200,
          total_tokens: 1790,
          cost: {
            input: 0.012,
            output: 0.034,
            cacheRead: 0.001,
            cacheWrite: 0.002,
            total: 0.049,
          },
        },
      }),
    ).toEqual({
      usage: {
        "claude-sonnet-4-20250514": {
          prompt_tokens: 1450,
          completion_tokens: 340,
          input_tokens: 1200,
          output_tokens: 340,
          total_tokens: 1790,
          prompt_tokens_details: { cached_tokens: 50 },
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 200,
          prompt_tokens_total_cost: 0.015,
          completion_tokens_total_cost: 0.034,
          total_cost: 0.049,
        },
      },
    });
  });

  it("returns an empty summary when usage or model is missing", () => {
    expect(summarizeOpenclawLlmResult({ usage: { output_tokens: 1 } })).toEqual({});
    expect(summarizeOpenclawLlmResult({ model: "gpt-5" })).toEqual({});
  });
});
