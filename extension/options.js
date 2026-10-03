import {
  DEFAULT_MODEL,
  GEMINI_MODELS,
  GROK_MODELS,
  providerForModel,
  resolveModel,
} from "./lib/models.mjs";

const form = document.getElementById("options-form");
const themeSelect = document.getElementById("theme");
const modelSelect = document.getElementById("model");
const geminiKey = document.getElementById("gemini-key");
const grokKey = document.getElementById("grok-key");
const geminiField = document.getElementById("gemini-field");
const grokField = document.getElementById("grok-field");
const note = document.getElementById("model-note");
const status = document.getElementById("status");

function optionGroup(label, models) {
  const group = document.createElement("optgroup");
  group.label = label;
  for (const id of models) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    group.append(option);
  }
  return group;
}

modelSelect.append(optionGroup("Google Gemini", GEMINI_MODELS));
modelSelect.append(optionGroup("xAI Grok", GROK_MODELS));

function applyPageTheme(theme) {
  document.documentElement.dataset.theme =
    theme === "light" || theme === "dark" ? theme : "system";
}

themeSelect.addEventListener("change", () => {
  applyPageTheme(themeSelect.value);
  status.textContent = "";
});

function syncProviderNote() {
  const provider = providerForModel(modelSelect.value);
  const usesGrok = provider === "grok";
  geminiField.classList.toggle("active-key", !usesGrok);
  grokField.classList.toggle("active-key", usesGrok);
  note.textContent = usesGrok
    ? "This model uses your Grok API key and calls api.x.ai."
    : "This model uses your Gemini API key and calls Google generateContent.";
}

modelSelect.addEventListener("change", () => {
  status.textContent = "";
  syncProviderNote();
});

const storage = globalThis.chrome?.storage?.sync;

if (storage) {
  storage
    .get(["geminiApiKey", "grokApiKey", "model", "theme"])
    .then(({ geminiApiKey, grokApiKey, model, theme }) => {
      if (geminiApiKey) geminiKey.value = geminiApiKey;
      if (grokApiKey) grokKey.value = grokApiKey;
      modelSelect.value = resolveModel(model || DEFAULT_MODEL);
      themeSelect.value = theme === "light" || theme === "dark" ? theme : "system";
      applyPageTheme(themeSelect.value);
      syncProviderNote();
    });
} else {
  modelSelect.value = DEFAULT_MODEL;
  themeSelect.value = "system";
  applyPageTheme("system");
  syncProviderNote();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const model = resolveModel(modelSelect.value);
  const theme = themeSelect.value === "light" || themeSelect.value === "dark" ? themeSelect.value : "system";
  applyPageTheme(theme);
  const settings = {
    model,
    theme,
    geminiApiKey: geminiKey.value.trim(),
    grokApiKey: grokKey.value.trim(),
  };
  if (!storage) {
    status.textContent = "Open this page from the extension options to save.";
    return;
  }
  await storage.set(settings);
  const provider = providerForModel(model) === "grok" ? "Grok" : "Gemini";
  status.textContent = `Saved. Requests will use ${model} (${provider}).`;
});
