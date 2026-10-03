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

export const DEFAULT_MODEL = "gemini-3.1-flash-lite";

export function providerForModel(model) {
  if (GROK_MODELS.includes(model)) return "grok";
  if (GEMINI_MODELS.includes(model)) return "gemini";
  return null;
}

export function resolveModel(model) {
  if (providerForModel(model)) return model;
  return DEFAULT_MODEL;
}
