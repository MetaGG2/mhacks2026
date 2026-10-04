import { streamGemini, verifyGeminiKey } from "./gemini.mjs";
import { streamGrok, streamGrokSearch, verifyGrokKey } from "./grok.mjs";

export { generateGrokImage } from "./grok.mjs";

/**
 * Streams a completion from whichever provider the API key belongs to.
 * `search: true` lets the model pull in web sources (Google Search for Gemini, web_search for Grok).
 */
export function streamCompletion({ provider, search = false, ...options }) {
  if (provider === "grok") return search ? streamGrokSearch(options) : streamGrok(options);
  return streamGemini({ ...options, search });
}

export function verifyKey(provider, apiKey) {
  return provider === "grok" ? verifyGrokKey(apiKey) : verifyGeminiKey(apiKey);
}
