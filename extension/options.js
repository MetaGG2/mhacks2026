const form = document.getElementById("options-form");
const themeSelect = document.getElementById("theme");
const apiKey = document.getElementById("api-key");
const status = document.getElementById("status");

function applyPageTheme(theme) {
  document.documentElement.dataset.theme =
    theme === "light" || theme === "dark" ? theme : "system";
}

themeSelect.addEventListener("change", () => {
  applyPageTheme(themeSelect.value);
  status.textContent = "";
});

const storage = globalThis.chrome?.storage?.sync;

if (storage) {
  storage
    .get(["apiKey", "geminiApiKey", "grokApiKey", "theme"])
    .then(({ apiKey: savedApiKey, geminiApiKey, grokApiKey, theme }) => {
      apiKey.value = savedApiKey || geminiApiKey || grokApiKey || "";
      themeSelect.value = theme === "light" || theme === "dark" ? theme : "system";
      applyPageTheme(themeSelect.value);
    });
} else {
  themeSelect.value = "system";
  applyPageTheme("system");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const theme = themeSelect.value === "light" || themeSelect.value === "dark"
    ? themeSelect.value
    : "system";
  applyPageTheme(theme);
  if (!storage) {
    status.textContent = "Open this page from the extension options to save.";
    return;
  }
  await storage.set({ apiKey: apiKey.value.trim(), theme });
  await storage.remove(["geminiApiKey", "grokApiKey"]);
  status.textContent = "Saved.";
});
