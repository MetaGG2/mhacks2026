import { generateGrokImage, streamCompletion, verifyKey } from "./lib/ai.mjs";
import {
  KEY_FORMAT_HINT,
  PROVIDERS,
  foreignKeyMessage,
  modelGroups,
  normalizeKey,
  providerForKey,
  resolveModel,
} from "./lib/models.mjs";
import {
  DEFAULT_BLACKLIST,
  PRIVACY_MESSAGE,
  effectiveBlacklist,
  isBlacklisted,
  normalizeBlacklist,
} from "./lib/privacy.mjs";
import {
  SELECTION_ACTIONS,
  askPrompt,
  countWords,
  elaboratePrompt,
  shortenLimit,
  shortenRetryPrompt,
  imagePrompt,
  readingPrompt,
  readingSchema,
  selectionPrompt,
} from "./lib/schemas.mjs";

const NO_KEY_MESSAGE = "Check Settings to add an API key";
const SETTINGS_KEYS = ["apiKey", "geminiApiKey", "grokApiKey", "provider", "model", "blacklist", "autoShow", "selectionTools", "aprilFools", "theme"];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEYS);
  const apiKey = normalizeKey(stored.apiKey || stored.geminiApiKey || stored.grokApiKey || "");
  // Known prefixes win; otherwise use the provider that accepted the key when it was confirmed.
  const provider = providerForKey(apiKey) || (PROVIDERS[stored.provider] ? stored.provider : null);
  return {
    apiKey,
    provider,
    model: resolveModel(stored.model, provider),
    blacklist: effectiveBlacklist(stored.blacklist),
    autoShow: stored.autoShow !== false,
    selectionTools: stored.selectionTools !== false,
    aprilFools: stored.aprilFools === true,
    theme: stored.theme === "light" || stored.theme === "dark" ? stored.theme : "system",
  };
}

async function configFor(url) {
  const settings = await loadSettings();
  return {
    hasKey: Boolean(settings.apiKey),
    provider: settings.provider,
    providerLabel: settings.provider ? PROVIDERS[settings.provider].label : "",
    model: settings.model,
    groups: modelGroups(settings.provider),
    keyLinks: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { label: p.label, url: p.keyUrl }])),
    blacklist: settings.blacklist,
    blocked: isBlacklisted(url, settings.blacklist),
    autoShow: settings.autoShow,
    selectionTools: settings.selectionTools,
    aprilFools: settings.aprilFools,
    theme: settings.theme,
  };
}

// ---------- Streaming requests (content script <-> background over a port) ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "tld-stream") return;
  const controller = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
    controller.abort();
  });
  const post = (message) => {
    if (!open) return;
    try {
      port.postMessage(message);
    } catch {
      open = false;
    }
  };
  port.onMessage.addListener(async (request) => {
    try {
      await handleStream(request, port.sender, controller.signal, post);
    } catch (error) {
      if (!controller.signal.aborted) {
        post({ type: "error", code: error.code || "error", message: error.message || "Request failed" });
      }
    }
  });
});

async function handleStream(request, sender, signal, post) {
  const settings = await loadSettings();
  // Defense in depth: the content script checks too, but never call the API for a blacklisted site
  // unless the user explicitly chose "Continue anyway" on this page.
  if (request?.override !== true && isBlacklisted(sender?.url || sender?.tab?.url, settings.blacklist)) {
    throw codedError("privacy", PRIVACY_MESSAGE);
  }
  if (!settings.apiKey) throw codedError("no-key", NO_KEY_MESSAGE);
  if (!settings.provider) {
    throw codedError("no-key", "Your API key isn't a Gemini or Grok key. Check Settings to add an API key.");
  }
  if (!/^[\x20-\x7E]+$/.test(settings.apiKey)) {
    throw new Error("Your API key contains invalid characters. Paste the key again without quotes or spaces.");
  }

  const common = { provider: settings.provider, apiKey: settings.apiKey, model: settings.model, signal };
  const onText = (text) => post({ type: "delta", text });
  // The content script sends the mode it is displaying, so its "made up" notice always matches the output.
  const mode = { aprilFools: request?.aprilFools === true };

  switch (request?.kind) {
    case "summary": {
      const text = await streamCompletion({
        ...common,
        prompt: readingPrompt(request.page, mode),
        schema: readingSchema,
        schemaName: "tld_reading",
        onText,
      });
      post({ type: "done", text });
      return;
    }
    case "ask": {
      const question = String(request.question || "").trim().slice(0, 1000);
      if (!question) throw new Error("Type a question first.");
      const text = await streamCompletion({ ...common, prompt: askPrompt(request.page, question), onText });
      post({ type: "done", text });
      return;
    }
    case "selection": {
      if (!SELECTION_ACTIONS.includes(request.action)) throw new Error("Unknown text action");
      const input = String(request.text || "").slice(0, 4000);
      let text = await streamCompletion({ ...common, prompt: selectionPrompt(request.action, input, request.title, mode), onText });
      if (request.action === "shorten") {
        // Guarantee the 30% cut: if the model overshoots, shorten its draft once more.
        const limit = shortenLimit(input);
        if (countWords(text) > limit) {
          post({ type: "reset" });
          text = await streamCompletion({ ...common, prompt: shortenRetryPrompt(text, limit, mode), onText });
        }
      }
      post({ type: "done", text });
      return;
    }
    case "elaborate": {
      let grounding = { sources: [], queries: [] };
      const text = await streamCompletion({
        ...common,
        search: true,
        prompt: elaboratePrompt(request.page, String(request.summary || "").slice(0, 3000)),
        onText,
        onGrounding: (result) => {
          grounding = result;
        },
      });
      post({ type: "sources", sources: grounding.sources.slice(0, 8), queries: grounding.queries.slice(0, 4) });
      post({ type: "done", text });
      return;
    }
    case "image": {
      if (settings.provider !== "grok") throw new Error("Image generation is only available with a Grok API key.");
      const image = await generateGrokImage({
        apiKey: settings.apiKey,
        prompt: imagePrompt(String(request.text || ""), mode),
        signal,
      });
      post({ type: "image", ...image });
      post({ type: "done", text: "" });
      return;
    }
    default:
      throw new Error("Unknown request");
  }
}

// ---------- One-shot messages ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = MESSAGE_HANDLERS[message?.type];
  if (!handler) return undefined;
  handler(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

const MESSAGE_HANDLERS = {
  async TLD_GET_CONFIG(_message, sender) {
    return { config: await configFor(sender.url || sender.tab?.url) };
  },

  async TLD_SAVE_KEY(message, sender) {
    const apiKey = normalizeKey(message.apiKey);
    if (!apiKey) {
      await chrome.storage.sync.remove(["apiKey", "geminiApiKey", "grokApiKey", "provider"]);
      return { config: await configFor(sender.url), notice: "API key removed." };
    }
    if (!/^[\x20-\x7E]+$/.test(apiKey)) {
      throw new Error("The key contains invalid characters. Copy it again from the provider's site.");
    }
    const foreign = foreignKeyMessage(apiKey);
    if (foreign) throw new Error(foreign);

    let provider = providerForKey(apiKey);
    let check;
    if (provider) {
      check = await verifyKey(provider, apiKey);
      if (check.valid === false) throw new Error(check.message || `${PROVIDERS[provider].label} rejected this key.`);
    } else {
      // Unfamiliar format: ask both providers instead of assuming, so new key formats keep working.
      const [gemini, grok] = await Promise.all([verifyKey("gemini", apiKey), verifyKey("grok", apiKey)]);
      if (gemini.valid) [provider, check] = ["gemini", gemini];
      else if (grok.valid) [provider, check] = ["grok", grok];
      else if (gemini.valid === null || grok.valid === null) {
        throw new Error(`WebHound doesn't recognize this key's format and couldn't check it right now. Check your connection and try again. ${KEY_FORMAT_HINT}`);
      } else {
        throw new Error(`Neither Gemini nor xAI accepted this key. ${KEY_FORMAT_HINT}`);
      }
    }

    const { model } = await chrome.storage.sync.get("model");
    await chrome.storage.sync.set({ apiKey, provider, model: resolveModel(model, provider) });
    await chrome.storage.sync.remove(["geminiApiKey", "grokApiKey"]);
    const label = PROVIDERS[provider].label;
    return {
      config: await configFor(sender.url),
      notice: check.valid === null
        ? `${label} key saved, but it couldn't be verified right now.`
        : `${label} key confirmed.`,
    };
  },

  async TLD_SET_BLACKLIST(message, sender) {
    const blacklist = message.reset ? [...DEFAULT_BLACKLIST] : normalizeBlacklist(message.blacklist);
    await chrome.storage.sync.set({ blacklist });
    return { config: await configFor(sender.url) };
  },
};

// ---------- Toolbar button ----------

chrome.action.onClicked.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TLD_TOGGLE" });
  } catch {
    // The content script is unavailable on restricted browser pages.
  }
});
