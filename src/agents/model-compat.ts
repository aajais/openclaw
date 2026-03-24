import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

function isOpenAiResponsesModel(model: Model<Api>): model is Model<"openai-responses"> {
  return model.api === "openai-responses";
}

type OpenAiCompletionsCompat = NonNullable<Model<"openai-completions">["compat"]>;

function isDashScopeCompatibleEndpoint(baseUrl: string): boolean {
  return (
    baseUrl.includes("dashscope.aliyuncs.com") ||
    baseUrl.includes("dashscope-intl.aliyuncs.com") ||
    baseUrl.includes("dashscope-us.aliyuncs.com")
  );
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

function normalizeOpenAiCompletionsBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/chat\/completions\/?$/, "");
}

function normalizeOpenAiResponsesBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/responses\/?$/, "");
}

function isWandbInferenceEndpoint(model: Model<Api>, baseUrl: string): boolean {
  return model.provider === "wandb" || baseUrl.includes("api.inference.wandb.ai");
}

function applyOpenAiCompatDefaults(
  model: Model<"openai-completions">,
  defaults: Partial<OpenAiCompletionsCompat>,
): Model<"openai-completions"> {
  if (Object.keys(defaults).length === 0) {
    return model;
  }

  const compat = model.compat ?? {};
  const nextCompat: OpenAiCompletionsCompat = { ...compat };
  let mutated = false;

  for (const [key, value] of Object.entries(defaults) as Array<
    [keyof OpenAiCompletionsCompat, OpenAiCompletionsCompat[keyof OpenAiCompletionsCompat]]
  >) {
    if (value === undefined || nextCompat[key] !== undefined) {
      continue;
    }
    nextCompat[key] = value;
    mutated = true;
  }

  return mutated ? ({ ...model, compat: nextCompat } as Model<"openai-completions">) : model;
}

/**
 * pi-ai constructs the Anthropic API endpoint as `${baseUrl}/v1/messages`.
 * If a user configures `baseUrl` with a trailing `/v1` (e.g. the previously
 * recommended format "https://api.anthropic.com/v1"), the resulting URL
 * becomes "…/v1/v1/messages" which the Anthropic API rejects with a 404.
 *
 * Strip a single trailing `/v1` (with optional trailing slash) from the
 * baseUrl for anthropic-messages models so users with either format work.
 */
function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}
export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  let normalizedModel = model;
  const baseUrl = normalizedModel.baseUrl ?? "";

  // Normalise anthropic-messages baseUrl: strip trailing /v1 that users may
  // have included in their config. pi-ai appends /v1/messages itself.
  if (isAnthropicMessagesModel(normalizedModel) && baseUrl) {
    const normalised = normalizeAnthropicBaseUrl(baseUrl);
    if (normalised !== baseUrl) {
      normalizedModel = { ...normalizedModel, baseUrl: normalised } as Model<"anthropic-messages">;
    }
  }

  const normalizedBaseUrl = normalizedModel.baseUrl ?? "";

  // OpenAI-compatible SDKs expect a base URL (e.g. .../v1), not a full endpoint.
  // Users frequently paste .../chat/completions or .../responses from provider docs,
  // which would otherwise become .../chat/completions/chat/completions and 404.
  if (isOpenAiCompletionsModel(normalizedModel) && normalizedBaseUrl) {
    const normalised = normalizeOpenAiCompletionsBaseUrl(normalizedBaseUrl);
    if (normalised !== normalizedBaseUrl) {
      normalizedModel = { ...normalizedModel, baseUrl: normalised } as Model<"openai-completions">;
    }
  }

  if (isOpenAiResponsesModel(normalizedModel) && normalizedBaseUrl) {
    const normalised = normalizeOpenAiResponsesBaseUrl(normalizedBaseUrl);
    if (normalised !== normalizedBaseUrl) {
      normalizedModel = { ...normalizedModel, baseUrl: normalised } as Model<"openai-responses">;
    }
  }

  const compatBaseUrl = normalizedModel.baseUrl ?? "";
  const isZai = normalizedModel.provider === "zai" || compatBaseUrl.includes("api.z.ai");
  const isMoonshot =
    normalizedModel.provider === "moonshot" ||
    compatBaseUrl.includes("moonshot.ai") ||
    compatBaseUrl.includes("moonshot.cn");
  const isDashScope =
    normalizedModel.provider === "dashscope" || isDashScopeCompatibleEndpoint(compatBaseUrl);
  const isWandbInference = isWandbInferenceEndpoint(normalizedModel, compatBaseUrl);
  if (!isOpenAiCompletionsModel(normalizedModel)) {
    return normalizedModel;
  }

  const compatDefaults: Partial<OpenAiCompletionsCompat> = {};
  if (isZai || isMoonshot || isDashScope || isWandbInference) {
    compatDefaults.supportsDeveloperRole = false;
  }
  if (isWandbInference) {
    compatDefaults.supportsReasoningEffort = false;
    compatDefaults.maxTokensField = "max_tokens";
  }

  return applyOpenAiCompatDefaults(normalizedModel, compatDefaults);
}
