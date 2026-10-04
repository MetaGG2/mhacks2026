export const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

export const GROK_MODELS = [
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-0309-reasoning",
];

export const GROK_IMAGE_MODEL = "grok-imagine-image";

export const PROVIDERS = {
  gemini: {
    label: "Gemini",
    models: GEMINI_MODELS,
    defaultModel: "gemini-3.1-flash-lite",
    // "AIza…" = legacy Standard keys (39 chars). "AQ.…" = the newer Auth keys AI Studio now issues (~53 chars).
    keyPrefixes: ["AIza", "AQ."],
    keyUrl: "https://aistudio.google.com/apikey",
  },
  grok: {
    label: "Grok",
    models: GROK_MODELS,
    defaultModel: "grok-4.20-0309-non-reasoning",
    keyPrefixes: ["xai-"],
    keyUrl: "https://console.x.ai/",
  },
};

export const DEFAULT_MODEL = PROVIDERS.gemini.defaultModel;

export function providerForModel(model) {
  if (GROK_MODELS.includes(model)) return "grok";
  if (GEMINI_MODELS.includes(model)) return "gemini";
  return null;
}

/** Cleans up common paste mistakes: surrounding quotes, a "Bearer " prefix, stray spaces or line breaks. */
export function normalizeKey(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^bearer\s+/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, "");
}

/**
 * Best guess from the key's prefix. Returns null for formats we don't know; callers should then
 * ask each provider whether it accepts the key rather than rejecting it (formats do change).
 */
export function providerForKey(apiKey) {
  const key = normalizeKey(apiKey);
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    if (provider.keyPrefixes.some((prefix) => key.startsWith(prefix))) return id;
  }
  return null;
}

export const KEY_FORMAT_HINT = 'Gemini keys start with "AIza" or "AQ.", and Grok keys start with "xai-".';

/** Explains keys from other AI services that are often pasted by mistake. */
export function foreignKeyMessage(apiKey) {
  const key = normalizeKey(apiKey);
  if (/^gsk_/.test(key)) return 'That\'s a Groq key (Groq is a different company from Grok). For Grok, create a key at console.x.ai; it starts with "xai-".';
  if (/^sk-ant-/.test(key)) return `That's an Anthropic key, which WebHound doesn't use. ${KEY_FORMAT_HINT}`;
  if (/^sk-or-/.test(key)) return `That's an OpenRouter key, which WebHound doesn't use. ${KEY_FORMAT_HINT}`;
  if (/^sk-/.test(key)) return `That looks like an OpenAI key, which WebHound doesn't use. ${KEY_FORMAT_HINT}`;
  if (/^pplx-/.test(key)) return `That's a Perplexity key, which WebHound doesn't use. ${KEY_FORMAT_HINT}`;
  return "";
}

/** Model groups for the settings dropdown: only the key's provider when one is known. */
export function modelGroups(provider) {
  const ids = provider && PROVIDERS[provider] ? [provider] : Object.keys(PROVIDERS);
  return Object.fromEntries(ids.map((id) => [PROVIDERS[id].label, PROVIDERS[id].models]));
}

/** Returns a model that belongs to `provider` (when given), falling back to that provider's default. */
export function resolveModel(model, provider = null) {
  const modelProvider = providerForModel(model);
  if (provider && PROVIDERS[provider]) {
    return modelProvider === provider ? model : PROVIDERS[provider].defaultModel;
  }
  return modelProvider ? model : DEFAULT_MODEL;
}
