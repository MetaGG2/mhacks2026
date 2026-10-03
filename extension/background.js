import { generateStructured } from "./lib/gemini.mjs";
import { providerForModel, resolveModel } from "./lib/models.mjs";
import { readingPrompt, readingSchema, searchPrompt, searchSchema } from "./lib/schemas.mjs";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TLD_ANALYZE") {
    return undefined;
  }

  handleAnalyze(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function handleAnalyze(payload) {
  const stored = await chrome.storage.sync.get(["geminiApiKey", "grokApiKey", "model"]);
  const model = resolveModel(stored.model);
  const provider = providerForModel(model);
  const apiKey = provider === "grok" ? stored.grokApiKey : stored.geminiApiKey;
  if (!apiKey) {
    const label = provider === "grok" ? "Grok" : "Gemini";
    throw new Error(`Set your ${label} API key in the WebHound options page.`);
  }

  const request =
    payload.mode === "search"
      ? {
          prompt: searchPrompt(payload.search),
          schema: searchSchema,
          schemaName: "tld_search",
        }
      : {
          prompt: readingPrompt(payload.page),
          schema: readingSchema,
          schemaName: "tld_reading",
        };

  return generateStructured({ apiKey, model, ...request });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TLD_TOGGLE" });
  } catch {
    // Content script not injected (chrome:// pages, etc.)
  }
});
