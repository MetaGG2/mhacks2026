const ASSET = (name) => chrome.runtime.getURL(`assets/${name}`);

const PRIVACY_MESSAGE = "Could not produce summary due to privacy concerns";
const PRIVACY_RESPONSE_MESSAGE = "Could not produce a response due to privacy concerns";
const NO_KEY_MESSAGE = "Check Settings to add an API key";
const SUMMARY_TEXT_LIMIT = 9000;
const ASK_TEXT_LIMIT = 20000;
const SELECTION_LIMIT = 4000;
const CORNERS = ["tl", "tr", "bl", "br"];
const TEXT_ACTIONS = [
  { id: "shorten", label: "Shorten", title: "Shortened" },
  { id: "reword", label: "Reword", title: "Reworded" },
  { id: "explain", label: "Explain", title: "Explanation" },
  { id: "image", label: "Generate image", title: "Generated image", grokOnly: true },
];
const FALLBACK_CONFIG = {
  hasKey: false,
  provider: null,
  providerLabel: "",
  model: "",
  groups: {},
  keyLinks: {},
  blacklist: [],
  blocked: false,
  autoShow: true,
  selectionTools: true,
  aprilFools: false,
  theme: "system",
};

let host;
let shadow;
let themeEl;
let root;
let dock;
let pop;
let config = FALLBACK_CONFIG;
let view = "closed"; // "open" | "minimized" | "closed"
let dockCorner = "br";
let startMinimized = false;
let summaryState = "idle"; // idle | loading | ready | error | privacy
let lastErrorCode = "";
let currentPage;
let summaryStream;
let elaborateStream;
let currentSummaryText = "";
let askStream;
let popStream;
let popSelection;
let dragState;
let privacyOverride = false; // Set for this page view when the user chooses "Continue anyway".
let lastQuestion = "";
let lastTextAction = "";
let popImage;

// ---------------------------------------------------------------- utilities

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineFormat(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
}

/** Minimal, safe Markdown-ish formatting for streamed answers: paragraphs, bullets, bold, code. */
/** Drops inline citation markers and turns Markdown links into plain text (sources are listed separately). */
function stripLinks(text) {
  return String(text || "")
    .replace(/\[\[\d+\]\]\([^)]*\)/g, "")
    .replace(/\[(\d+)\]\(https?:[^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1");
}

function formatText(text, streaming = false) {
  const lines = stripLinks(text).trim().split(/\n+/);
  let html = "";
  let inList = false;
  for (const line of lines) {
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    const content = inlineFormat(escapeHtml((bullet ? bullet[1] : line).replace(/^#{1,6}\s+/, "")));
    if (!content.trim()) continue;
    if (bullet) {
      if (!inList) html += "<ul>";
      inList = true;
      html += `<li>${content}</li>`;
    } else {
      if (inList) html += "</ul>";
      inList = false;
      html += `<p>${content}</p>`;
    }
  }
  if (inList) html += "</ul>";
  if (streaming) {
    const caret = '<span class="tld-caret" aria-hidden="true"></span>';
    html = /<\/(p|li)>(<\/ul>)?$/.test(html)
      ? html.replace(/<\/(p|li)>(<\/ul>)?$/, `${caret}</$1>$2`)
      : `<p>${caret}</p>`;
  }
  return html;
}

function stripFences(text) {
  return String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
}

/** Closes any open strings/objects/arrays so a partially streamed JSON document can be parsed. */
function closeJson(input) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const char of input) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") stack.pop();
  }
  let out = input;
  if (inString) {
    if (escaped) out = out.slice(0, -1);
    out = out.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
    out += '"';
  }
  return out + stack.reverse().join("");
}

function parsePartialJson(text) {
  let candidate = stripFences(text);
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  candidate = candidate.slice(start);
  for (let attempt = 0; attempt < 12 && candidate; attempt += 1) {
    try {
      return JSON.parse(closeJson(candidate));
    } catch {
      const cut = Math.max(candidate.lastIndexOf(","), candidate.lastIndexOf("{"), candidate.lastIndexOf("["));
      if (cut <= 0) return null;
      candidate = candidate[cut] === "," ? candidate.slice(0, cut) : candidate.slice(0, cut + 1);
    }
  }
  return null;
}

function contextLostMessage() {
  return "WebHound was updated or reloaded. Refresh this page to keep using it.";
}

async function sendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return { ok: false, error: contextLostMessage() };
  }
}

function summaryCountFor(text) {
  return Math.min(6, Math.max(2, Math.ceil(text.length / 1200)));
}

// ---------------------------------------------------------------- privacy

// Never read or send anything from inputs, editors, or fields that look like secrets.
const SENSITIVE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[autocomplete*='cc-']",
  "[autocomplete*='password']",
  "[autocomplete='one-time-code']",
  "[data-private]",
  "[data-sensitive]",
].join(",");
const SECRET_HINT =
  /pass(?:word|code|phrase)|secret|token|\botp\b|one[-_ ]?time[-_ ]?code|\bpin\b|\bssn\b|social[-_ ]?security|\bcvv\b|\bcvc\b|card[-_ ]?(?:number|num|no)\b|account[-_ ]?(?:number|num|no)\b|routing|\biban\b|api[-_ ]?key|private[-_ ]?key/i;

function isSecretElement(element) {
  if (!(element instanceof Element)) return false;
  if (element.matches(SENSITIVE_SELECTOR)) return true;
  const hint = ["id", "name", "aria-label", "data-testid"]
    .map((attribute) => element.getAttribute(attribute))
    .filter(Boolean)
    .join(" ");
  return Boolean(hint) && SECRET_HINT.test(hint);
}

function hasSecretAncestor(node) {
  let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  while (element && element !== document.documentElement) {
    if (isSecretElement(element)) return true;
    element = element.parentElement;
  }
  return false;
}

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

function ibanValid(value) {
  const compact = value.replace(/\s+/g, "").toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

// `high` findings mean the content is especially vulnerable: nothing is sent at all.
const REDACTIONS = [
  { label: "SECRET", high: false, pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g },
  {
    label: "SECRET",
    high: false,
    pattern: /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b|\bxai-[A-Za-z0-9]{16,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bAQ\.[0-9A-Za-z_.-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  },
  { label: "CARD NUMBER", high: true, pattern: /\b\d(?:[ -]?\d){12,18}\b/g, test: (match) => luhnValid(match.replace(/\D/g, "")) },
  { label: "SSN", high: true, pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { label: "IBAN", high: true, pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g, test: ibanValid },
  { label: "ACCOUNT NUMBER", high: true, pattern: /\b(?:account|acct|routing|aba)\s*(?:number|no\.?|#)?\s*[:#]?\s*\d[\d -]{5,}\d/gi },
  { label: "EMAIL", high: false, pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { label: "PHONE", high: false, pattern: /(?:\+?\d{1,3}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/g },
];

/** Replaces personal details with placeholders. Returns the cleaned text and how many high-risk items were found. */
function redact(text) {
  let high = 0;
  let output = String(text || "");
  for (const rule of REDACTIONS) {
    output = output.replace(rule.pattern, (match) => {
      if (rule.test && !rule.test(match)) return match;
      if (rule.high) high += 1;
      return `[REDACTED ${rule.label}]`;
    });
  }
  return { text: output, high };
}

function privatePage(page) {
  const text = redact(page.text);
  const title = redact(page.title);
  const headings = page.headings.map((heading) => {
    const cleaned = redact(heading.text);
    text.high += cleaned.high;
    return { id: heading.id, text: cleaned.text };
  });
  return { page: { title: title.text, headings, text: text.text }, high: text.high + title.high };
}

// ---------------------------------------------------------------- page extraction

function extractPage(limit) {
  const main =
    document.querySelector("article") ||
    document.querySelector("[role='main']") ||
    document.querySelector("main") ||
    document.body;
  const usedIds = new Set([...document.querySelectorAll("[id]")].map((element) => element.id));
  const headingIds = new Set();
  const headings = [...main.querySelectorAll("h1, h2, h3")]
    .filter((element) => !hasSecretAncestor(element))
    .map((element, index) => {
      if (!element.id || headingIds.has(element.id)) {
        let nextId = `tld-section-${index}`;
        let suffix = 1;
        while (usedIds.has(nextId)) nextId = `tld-section-${index}-${suffix++}`;
        element.id = nextId;
      }
      usedIds.add(element.id);
      headingIds.add(element.id);
      return { id: element.id, text: element.innerText.trim().slice(0, 120) };
    })
    .filter((heading) => heading.text);
  const clone = main.cloneNode(true);
  clone.querySelectorAll("script, style, noscript, nav, footer, aside, iframe, svg, form, template")
    .forEach((element) => element.remove());
  clone.querySelectorAll("*").forEach((element) => {
    if (isSecretElement(element)) element.remove();
  });
  const text = clone.innerText.replace(/\s+/g, " ").trim().slice(0, limit);
  return { title: document.title || "Untitled page", headings, text };
}

// ---------------------------------------------------------------- streaming

/** Opens a port to the background worker and streams one request. */
function streamRequest(payload, handlers) {
  let finished = false;
  let port;
  const finish = () => {
    finished = true;
    try {
      port?.disconnect();
    } catch {
      // Already closed.
    }
  };
  try {
    port = chrome.runtime.connect({ name: "tld-stream" });
  } catch {
    queueMicrotask(() => handlers.onError?.({ message: contextLostMessage() }));
    return { cancel() {} };
  }
  port.onMessage.addListener((message) => {
    if (finished) return;
    if (message.type === "delta") handlers.onDelta?.(message.text || "");
    else if (message.type === "image") handlers.onImage?.(message);
    else if (message.type === "sources") handlers.onSources?.(message);
    else if (message.type === "reset") handlers.onReset?.();
    else if (message.type === "done") {
      finish();
      handlers.onDone?.(message.text || "");
    } else if (message.type === "error") {
      finish();
      handlers.onError?.({ code: message.code, message: message.message });
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (finished) return;
    finished = true;
    handlers.onError?.({ message: "The connection was interrupted. Try again." });
  });
  port.postMessage(payload);
  return {
    cancel() {
      if (!finished) finish();
    },
  };
}

/** Coalesces rapid stream deltas into one render per animation frame. */
function frameScheduler(render) {
  let frame = 0;
  return {
    schedule() {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        render();
      });
    },
    cancel() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

// ---------------------------------------------------------------- UI shell

const $ = (selector) => root?.querySelector(selector);

function loaderHtml(label = "Fetching…") {
  return `<p class="tld-loading" role="status">${escapeHtml(label)}</p>`;
}

/** `target` names what "Continue anyway" re-runs: "summary", "ask" or "pop". */
function privacyHtml(message, detail, target) {
  return `
    <div class="tld-privacy" role="status">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z"/></svg>
      <div>
        <p class="tld-message"><strong>${escapeHtml(message)}</strong></p>
        ${detail ? `<p class="tld-note">${escapeHtml(detail)}</p>` : ""}
        ${target ? `
          <div class="tld-privacy-override">
            <button class="tld-btn tld-btn-ghost" type="button" data-privacy-override="${target}">Continue anyway</button>
            <p class="tld-note">Personal details are still redacted, and passwords are never sent.</p>
          </div>` : ""}
      </div>
    </div>`;
}

function privacyDetail(reason) {
  return reason === "blacklist"
    ? "This site is on your privacy blacklist, so nothing was sent to the AI."
    : "This content appears to include sensitive personal or financial details, so nothing was sent to the AI.";
}

function foolsNoteHtml(what) {
  return `<p class="tld-fools-note">🐾 April Fools mode: ${escapeHtml(what)}.</p>`;
}

function errorHtml(error) {
  if (error.code === "no-key") {
    return `
      <p class="tld-message">${escapeHtml(error.message || NO_KEY_MESSAGE)}</p>
      <button class="tld-btn" type="button" data-open-settings>Open settings</button>`;
  }
  return `<p class="tld-message">${escapeHtml(error.message || "Something went wrong.")}</p>`;
}

function shellHtml() {
  return `
    <header class="tld-header">
      <div class="tld-brand">
        <img class="tld-brand-mark" src="${ASSET("WebHoundHead.png")}" width="28" height="28" alt="">
        <strong>WebHound</strong>
      </div>
      <div class="tld-actions">
        <button class="tld-action" type="button" data-refresh aria-label="Refresh summary" title="Refresh">↻</button>
        <button class="tld-action" type="button" data-settings aria-label="Settings" title="Settings">⚙</button>
        <button class="tld-action" type="button" data-minimize aria-label="Minimize" title="Minimize">–</button>
        <button class="tld-action" type="button" data-close aria-label="Close" title="Close">
          <img src="${ASSET("close.svg")}" width="13" height="13" alt="">
        </button>
      </div>
    </header>
    <aside class="tld-settings" aria-label="Settings">
      <h2>Settings</h2>
      <div class="tld-field">
        <label for="tld-api-key">API key</label>
        <div class="tld-key-row">
          <input id="tld-api-key" type="password" data-api-key autocomplete="off" spellcheck="false">
          <button class="tld-btn" type="button" data-key-confirm>Confirm</button>
        </div>
        <p class="tld-note" data-key-current></p>
        <p class="tld-note" data-key-status aria-live="polite"></p>
        <p class="tld-note tld-key-links">
          Get a key:
          <a data-key-link="gemini" target="_blank" rel="noopener noreferrer">Gemini ↗</a>
          ·
          <a data-key-link="grok" target="_blank" rel="noopener noreferrer">Grok ↗</a>
        </p>
      </div>
      <div class="tld-field">
        <label for="tld-model">AI model</label>
        <select id="tld-model" data-model></select>
      </div>
      <label class="tld-setting-check">
        <input type="checkbox" data-auto-show>
        Show summaries automatically
      </label>
      <label class="tld-setting-check">
        <input type="checkbox" data-selection-tools>
        Show tools when highlighting text
      </label>
      <div class="tld-field">
        <label class="tld-setting-check">
          <input type="checkbox" data-april-fools>
          April Fools mode 🐾
        </label>
        <p class="tld-note">Summaries, shortened text, rewordings, explanations and images become made-up jokes told by a dog. Search-bar answers stay real.</p>
      </div>
      <div class="tld-field">
        <label for="tld-theme">Theme</label>
        <select id="tld-theme" data-theme-select>
          <option value="system">System default</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div class="tld-field">
        <label for="tld-blacklist">Privacy blacklist</label>
        <textarea id="tld-blacklist" rows="5" data-blacklist spellcheck="false"></textarea>
        <p class="tld-note">One site per line. Nothing from these sites is ever sent to the AI. A word without a dot (like "mychart") matches any site containing it.</p>
        <div class="tld-button-row">
          <button class="tld-btn" type="button" data-blacklist-save>Save list</button>
          <button class="tld-btn tld-btn-ghost" type="button" data-blacklist-add>Add this site</button>
          <button class="tld-btn tld-btn-ghost" type="button" data-blacklist-reset>Reset</button>
        </div>
        <p class="tld-note" data-blacklist-status aria-live="polite"></p>
      </div>
    </aside>
    <form class="tld-ask" data-ask-form>
      <input type="text" data-ask-input placeholder="Ask about this page…" maxlength="500" autocomplete="off" aria-label="Ask about this page">
      <button class="tld-ask-btn" type="submit" aria-label="Ask">→</button>
    </form>
    <section class="tld-answer" data-answer hidden aria-live="polite"></section>
    <main class="tld-body" data-body></main>`;
}

function ensureUi() {
  if (host) return;
  host = document.createElement("div");
  host.id = "tldretriever-host";
  // Closed so page scripts can't reach into the panel through host.shadowRoot.
  shadow = host.attachShadow({ mode: "closed" });

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("overlay.css");

  themeEl = document.createElement("div");
  themeEl.className = "tld-theme";
  themeEl.dataset.view = "closed";
  themeEl.dataset.theme = config.theme;
  themeEl.style.visibility = "hidden"; // Avoid a flash of unstyled content.
  const reveal = () => themeEl.style.removeProperty("visibility");
  stylesheet.addEventListener("load", reveal, { once: true });
  stylesheet.addEventListener("error", reveal, { once: true });

  root = document.createElement("div");
  root.className = "tld-root";
  root.innerHTML = shellHtml();

  dock = document.createElement("div");
  dock.className = "tld-dock";
  dock.dataset.corner = dockCorner;
  dock.innerHTML = `
    <button class="tld-dock-btn" type="button" data-restore aria-label="Open WebHound" title="Open WebHound">
      <img src="${ASSET("WebHoundHead.png")}" alt="">
    </button>`;

  pop = document.createElement("div");
  pop.className = "tld-pop";
  pop.hidden = true;

  themeEl.append(root, dock, pop);
  shadow.append(stylesheet, themeEl);
  document.documentElement.append(host);

  // Keep the host page's keyboard shortcuts from firing while typing in WebHound.
  for (const type of ["keydown", "keyup", "keypress", "paste", "copy", "cut", "input", "beforeinput"]) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }
  shadow.addEventListener("click", onShadowClick);
  shadow.addEventListener("keydown", onShadowKeydown);
  shadow.addEventListener("change", onSettingChange);
  shadow.addEventListener("input", onSettingInput);
  shadow.addEventListener("submit", onSubmit);
  shadow.addEventListener("pointerdown", startDrag);
  shadow.addEventListener("pointermove", moveDrag);
  shadow.addEventListener("pointerup", endDrag);
  shadow.addEventListener("pointercancel", endDrag);
  shadow.addEventListener("wheel", scrollOverlay, { passive: false });
  // Keep the page's text selection when pressing a text-tool button.
  pop.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });

  syncSettings();
}

function setView(next) {
  ensureUi();
  view = next;
  themeEl.dataset.view = next;
  dock.dataset.corner = dockCorner;
  chrome.storage.local.set({ minimized: next === "minimized", dockCorner }).catch(() => {});
}

function minimize() {
  const bounds = root.getBoundingClientRect();
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  dockCorner = `${centerY < window.innerHeight / 2 ? "t" : "b"}${centerX < window.innerWidth / 2 ? "l" : "r"}`;
  root.classList.remove("tld-settings-open");
  setView("minimized");
}

function restore() {
  setView("open");
  if (summaryState === "idle") analyze({ force: true });
}

function setSummaryState(state) {
  summaryState = state;
  if (dock) dock.querySelector(".tld-dock-btn").dataset.state = state;
}

function setBody(html, ready = false) {
  const body = $("[data-body]");
  body.className = `tld-body${ready ? " tld-ready" : ""}`;
  body.innerHTML = html;
}

function applyTheme(theme) {
  if (themeEl) themeEl.dataset.theme = theme === "light" || theme === "dark" ? theme : "system";
}

// ---------------------------------------------------------------- settings

function setStatus(selector, message, tone = "") {
  const element = $(selector);
  if (!element) return;
  element.textContent = message || "";
  element.dataset.tone = tone;
}

function syncSettings() {
  if (!root) return;
  applyTheme(config.theme);

  const keyInput = $("[data-api-key]");
  keyInput.placeholder = config.hasKey ? "Paste a new key to replace it" : "Paste a Gemini or Grok key";
  const current = $("[data-key-current]");
  current.innerHTML = config.hasKey
    ? `Using ${escapeHtml(config.providerLabel || "an unrecognized")} key. <button class="tld-link" type="button" data-key-remove>Remove key</button>`
    : "No API key saved.";
  for (const link of root.querySelectorAll("[data-key-link]")) {
    const info = config.keyLinks?.[link.dataset.keyLink];
    if (info?.url) link.href = info.url;
  }

  const modelSelect = $("[data-model]");
  modelSelect.innerHTML = Object.entries(config.groups || {}).map(([label, models]) => `
    <optgroup label="${escapeHtml(label)}">
      ${models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")}
    </optgroup>`).join("");
  modelSelect.value = config.model;

  $("[data-auto-show]").checked = config.autoShow !== false;
  $("[data-selection-tools]").checked = config.selectionTools !== false;
  $("[data-april-fools]").checked = config.aprilFools === true;
  $("[data-theme-select]").value = config.theme || "system";

  const blacklist = $("[data-blacklist]");
  if (shadow.activeElement !== blacklist) blacklist.value = (config.blacklist || []).join("\n");
}

async function refreshConfig() {
  const response = await sendMessage({ type: "TLD_GET_CONFIG" });
  if (response?.ok) applyConfig(response.config);
}

function applyConfig(next) {
  const wasBlocked = config.blocked;
  const oldProvider = config.provider;
  const wasAprilFools = config.aprilFools;
  config = next;
  syncSettings();
  if (oldProvider !== config.provider && pop && !pop.hidden && !popHasResult()) hidePop();
  if (wasAprilFools !== config.aprilFools) {
    if (pop && !pop.hidden) hidePop();
    // Swap the summary between real and joke versions if one is showing.
    if (view !== "closed" && ["loading", "ready"].includes(summaryState) && wasBlocked === config.blocked) analyze({ force: true });
  }
  if (wasBlocked !== config.blocked) {
    privacyOverride = false; // A blacklist change resets any earlier "Continue anyway".
    if (view === "open") analyze({ force: true });
  }
}

async function confirmKey() {
  const input = $("[data-api-key]");
  const button = $("[data-key-confirm]");
  const value = input.value.trim();
  if (!value) {
    setStatus("[data-key-status]", "Paste a key first, then press Confirm.", "error");
    return;
  }
  button.disabled = true;
  button.textContent = "Checking…";
  setStatus("[data-key-status]", "Checking key…");
  const response = await sendMessage({ type: "TLD_SAVE_KEY", apiKey: value });
  button.disabled = false;
  button.textContent = "Confirm";
  if (!response?.ok) {
    setStatus("[data-key-status]", response?.error || "Couldn't save the key.", "error");
    return;
  }
  input.value = "";
  applyConfig(response.config);
  setStatus("[data-key-status]", response.notice, "ok");
  if (lastErrorCode === "no-key") analyze({ force: true });
}

async function removeKey() {
  const response = await sendMessage({ type: "TLD_SAVE_KEY", apiKey: "" });
  if (!response?.ok) {
    setStatus("[data-key-status]", response?.error || "Couldn't remove the key.", "error");
    return;
  }
  applyConfig(response.config);
  setStatus("[data-key-status]", response.notice, "ok");
}

async function saveBlacklist({ reset = false, addCurrent = false } = {}) {
  const textarea = $("[data-blacklist]");
  const entries = textarea.value.split(/[\n,]+/);
  if (addCurrent) entries.push(location.hostname);
  const response = await sendMessage({ type: "TLD_SET_BLACKLIST", blacklist: entries, reset });
  if (!response?.ok) {
    setStatus("[data-blacklist-status]", response?.error || "Couldn't save the list.", "error");
    return;
  }
  textarea.value = response.config.blacklist.join("\n");
  applyConfig(response.config);
  const message = reset
    ? "Blacklist reset to defaults."
    : addCurrent
      ? `Added ${location.hostname.replace(/^www\./, "")}.`
      : "Blacklist saved.";
  setStatus("[data-blacklist-status]", message, "ok");
}

function openSettings() {
  root.classList.add("tld-settings-open");
  root.scrollTop = 0;
  $("[data-api-key]")?.focus();
}

// ---------------------------------------------------------------- events

function onShadowClick(event) {
  const target = event.target;
  if (target.closest("[data-restore]")) return restore();
  if (target.closest("[data-refresh]")) return analyze({ force: true });
  if (target.closest("[data-settings]")) return root.classList.toggle("tld-settings-open");
  if (target.closest("[data-open-settings]")) return openSettings();
  if (target.closest("[data-minimize]")) return minimize();
  if (target.closest("[data-close]")) return setView("closed");
  if (target.closest("[data-key-confirm]")) return confirmKey();
  if (target.closest("[data-key-remove]")) return removeKey();
  if (target.closest("[data-blacklist-save]")) return saveBlacklist();
  if (target.closest("[data-blacklist-add]")) return saveBlacklist({ addCurrent: true });
  if (target.closest("[data-blacklist-reset]")) return saveBlacklist({ reset: true });
  if (target.closest("[data-answer-close]")) return clearAnswer();
  const override = target.closest("[data-privacy-override]");
  if (override) return overridePrivacy(override.dataset.privacyOverride);
  const save = target.closest("[data-pop-save]");
  if (save) return saveImage(save);
  const copyImageButton = target.closest("[data-pop-copy-image]");
  if (copyImageButton) return copyImage(copyImageButton);
  const action = target.closest("[data-text-action]");
  if (action) return runTextAction(action.dataset.textAction);
  if (target.closest("[data-pop-close]")) return hidePop();
  const copy = target.closest("[data-pop-copy]");
  if (copy) return copyPopResult(copy);
  if (target.closest("[data-elaborate]")) return elaborate();
  const jump = target.closest("[data-jump]");
  if (jump) jumpTo(jump.dataset.jump);
  return undefined;
}

function onShadowKeydown(event) {
  if (event.key === "Escape") {
    if (pop && !pop.hidden) hidePop();
    else if (root?.classList.contains("tld-settings-open")) root.classList.remove("tld-settings-open");
    return;
  }
  if (event.key === "Enter" && event.target.closest("[data-api-key]")) {
    event.preventDefault();
    confirmKey();
    return;
  }
  const jump = event.target.closest("[data-jump]");
  if (jump && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    jumpTo(jump.dataset.jump);
  }
}

function onSubmit(event) {
  if (!event.target.closest("[data-ask-form]")) return;
  event.preventDefault();
  ask($("[data-ask-input]").value);
}

function onSettingChange(event) {
  const target = event.target;
  if (target.closest("[data-model]")) chrome.storage.sync.set({ model: target.value });
  else if (target.closest("[data-auto-show]")) chrome.storage.sync.set({ autoShow: target.checked });
  else if (target.closest("[data-april-fools]")) chrome.storage.sync.set({ aprilFools: target.checked });
  else if (target.closest("[data-selection-tools]")) {
    chrome.storage.sync.set({ selectionTools: target.checked });
    if (!target.checked) hidePop();
  } else if (target.closest("[data-theme-select]")) {
    const theme = target.value === "light" || target.value === "dark" ? target.value : "system";
    chrome.storage.sync.set({ theme });
    applyTheme(theme);
  }
}

function onSettingInput(event) {
  if (event.target.closest("[data-api-key]")) {
    setStatus("[data-key-status]", event.target.value.trim() ? "Press Confirm to save this key." : "");
  }
}

function jumpTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function scrollOverlay(event) {
  if (!root || !root.contains(event.target) || event.target.closest("textarea")) return;
  event.preventDefault();
  root.scrollTop += event.deltaY;
}

function startDrag(event) {
  const header = event.target.closest(".tld-header");
  if (!root || !header || event.button !== 0 || event.target.closest("button")) return;
  const bounds = root.getBoundingClientRect();
  dragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - bounds.left,
    offsetY: event.clientY - bounds.top,
  };
  root.setPointerCapture(event.pointerId);
  root.classList.add("tld-dragging");
  event.preventDefault();
}

function moveDrag(event) {
  if (!root || !dragState || event.pointerId !== dragState.pointerId) return;
  const margin = 16;
  const maxLeft = Math.max(margin, window.innerWidth - root.offsetWidth - margin);
  const maxTop = Math.max(margin, window.innerHeight - root.offsetHeight - margin);
  root.style.left = `${Math.min(maxLeft, Math.max(margin, event.clientX - dragState.offsetX))}px`;
  root.style.top = `${Math.min(maxTop, Math.max(margin, event.clientY - dragState.offsetY))}px`;
  root.style.right = "auto";
  root.style.bottom = "auto";
}

function endDrag(event) {
  if (!root || !dragState || event.pointerId !== dragState.pointerId) return;
  root.classList.remove("tld-dragging");
  root.releasePointerCapture?.(event.pointerId);
  dragState = undefined;
}

// ---------------------------------------------------------------- summary

function summaryHtml(summary, validIds, maxItems) {
  const usedIds = new Set();
  return (Array.isArray(summary) ? summary : [])
    .filter((part) => typeof part?.text === "string" && part.text.trim())
    .filter((part) => {
      if (!validIds.has(part.headingId)) return true;
      if (usedIds.has(part.headingId)) return false;
      usedIds.add(part.headingId);
      return true;
    })
    .slice(0, maxItems)
    .map((part) => {
      const linked = validIds.has(part.headingId);
      const attributes = linked ? ` data-jump="${escapeHtml(part.headingId)}" role="link" tabindex="0"` : "";
      return `<span class="tld-summary-sentence${linked ? "" : " tld-unlinked"}"${attributes}>${escapeHtml(part.text)}</span>`;
    })
    .join(" ");
}

function renderSummary(result, page, streaming, aprilFools = false) {
  const validIds = new Set(page.headings.map((heading) => heading.id));
  const sentences = summaryHtml(result?.summary, validIds, summaryCountFor(page.text));
  const points = (Array.isArray(result?.keyPoints) ? result.keyPoints : [])
    .filter((point) => typeof point === "string" && point.trim())
    .slice(0, 3);
  if (!sentences && !points.length) {
    if (!streaming) showSummaryError({ message: "The AI didn't return a summary. Try refreshing." });
    return; // While streaming, keep the loader until text arrives.
  }
  const caret = streaming ? '<span class="tld-caret" aria-hidden="true"></span>' : "";
  setBody(`
    ${aprilFools ? foolsNoteHtml("this summary is made up") : ""}
    <section class="tld-section">
      <h2>Summary</h2>
      <p class="tld-summary">${sentences}${points.length ? "" : caret}</p>
    </section>
    ${points.length ? `
      <section class="tld-section">
        <h2>Key points</h2>
        <ul class="tld-points">${points.map((point, index) => `
          <li><img src="${ASSET("status-dot.svg")}" width="5" height="5" alt=""><span>${escapeHtml(point)}${index === points.length - 1 ? caret : ""}</span></li>`).join("")}
        </ul>
      </section>` : ""}
    ${!streaming && !aprilFools ? `
      <div class="tld-elaborate-slot" data-elaborate-slot>
        <button class="tld-btn tld-btn-ghost tld-elaborate-btn" type="button" data-elaborate>Elaborate with web sources ↗</button>
      </div>` : ""}
  `, !streaming);
  if (!streaming) {
    const plain = (Array.isArray(result?.summary) ? result.summary : []).map((part) => part?.text).filter(Boolean).join(" ");
    currentSummaryText = [plain, ...points.map((point) => `- ${point}`)].join("\n");
  }
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function sourcesHtml(sources, queries) {
  const links = (Array.isArray(sources) ? sources : [])
    .map((source) => {
      const href = safeUrl(source?.url);
      if (!href) return null;
      const label = String(source.title || "").trim() || new URL(href).hostname.replace(/^www\./, "");
      return { href, label };
    })
    .filter(Boolean)
    .slice(0, 6);
  const searches = (Array.isArray(queries) ? queries : []).filter((query) => typeof query === "string" && query.trim()).slice(0, 3);
  if (!links.length && !searches.length) return '<p class="tld-note">No source links were returned for this answer.</p>';
  return `
    <div class="tld-sources">
      ${links.length ? `
        <h3>Sources</h3>
        <ol>${links.map((link) => `
          <li><a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a></li>`).join("")}
        </ol>` : ""}
      ${searches.length ? `
        <p class="tld-note">Searched for: ${searches.map((query) =>
          `<a href="https://www.google.com/search?q=${encodeURIComponent(query)}" target="_blank" rel="noopener noreferrer">${escapeHtml(query)}</a>`).join(", ")}</p>` : ""}
    </div>`;
}

/** Expands on the summary with outside, web-sourced information (the summary itself is page-only). */
function elaborate() {
  const slot = $("[data-elaborate-slot]");
  if (!slot || !currentPage || !currentSummaryText) return;
  elaborateStream?.cancel();
  slot.innerHTML = `
    <section class="tld-section tld-elaboration">
      <h2>Elaboration <span class="tld-badge">Web sources</span></h2>
      <div class="tld-rich" data-elab-body>${loaderHtml("Searching the web…")}</div>
      <div data-elab-sources></div>
    </section>`;
  const body = () => $("[data-elab-body]");
  let text = "";
  const scheduler = frameScheduler(() => {
    const element = body();
    if (element) element.innerHTML = formatText(text, true);
  });
  elaborateStream = streamRequest({ kind: "elaborate", page: currentPage, summary: currentSummaryText, override: privacyOverride }, {
    onDelta(delta) {
      text += delta;
      scheduler.schedule();
    },
    onSources({ sources, queries }) {
      const element = $("[data-elab-sources]");
      if (element) element.innerHTML = sourcesHtml(sources, queries);
    },
    onDone(full) {
      scheduler.cancel();
      const element = body();
      if (element) element.innerHTML = formatText(full || text);
    },
    onError(error) {
      scheduler.cancel();
      const element = body();
      if (!element) return;
      element.innerHTML = `${errorHtml(error)}
        <button class="tld-btn tld-btn-ghost" type="button" data-elaborate>Try again</button>`;
    },
  });
}

function showSummaryError(error) {
  lastErrorCode = error.code || "";
  if (error.code === "privacy") {
    setSummaryState("privacy");
    setBody(privacyHtml(PRIVACY_MESSAGE, privacyDetail("blacklist"), "summary"));
    return;
  }
  setSummaryState("error");
  setBody(errorHtml(error));
}

async function analyze({ force = false } = {}) {
  await configReady;
  if (!force && !config.autoShow) return;
  const extracted = extractPage(SUMMARY_TEXT_LIMIT);
  if (extracted.text.length < 80 && !force) return;

  ensureUi();
  if (view === "closed") setView("open");
  summaryStream?.cancel();
  elaborateStream?.cancel();
  currentSummaryText = "";
  lastErrorCode = "";

  if (config.blocked && !privacyOverride) {
    showSummaryError({ code: "privacy" });
    return;
  }
  if (extracted.text.length < 80) {
    showSummaryError({ message: "There isn't enough text on this page to summarize." });
    return;
  }
  const { page, high } = privatePage(extracted);
  currentPage = page;
  if (high > 0 && !privacyOverride) {
    setSummaryState("privacy");
    setBody(privacyHtml(PRIVACY_MESSAGE, privacyDetail("sensitive"), "summary"));
    return;
  }

  setSummaryState("loading");
  setBody(loaderHtml());
  const aprilFools = config.aprilFools === true;
  let buffer = "";
  const scheduler = frameScheduler(() => {
    const partial = parsePartialJson(buffer);
    if (partial) renderSummary(partial, page, true, aprilFools);
  });
  summaryStream = streamRequest({ kind: "summary", page, override: privacyOverride, aprilFools }, {
    onDelta(text) {
      buffer += text;
      scheduler.schedule();
    },
    onDone(text) {
      scheduler.cancel();
      let result;
      try {
        result = JSON.parse(stripFences(text || buffer));
      } catch {
        result = parsePartialJson(text || buffer);
      }
      if (!result) {
        showSummaryError({ message: "The AI returned an unreadable summary. Try refreshing." });
        return;
      }
      setSummaryState("ready");
      renderSummary(result, page, false, aprilFools);
    },
    onError(error) {
      scheduler.cancel();
      showSummaryError(error);
    },
  });
}

// ---------------------------------------------------------------- ask

function setAnswer(question, html) {
  const answer = $("[data-answer]");
  answer.hidden = false;
  answer.innerHTML = `
    <div class="tld-answer-head">
      <h2>Answer</h2>
      <button class="tld-action tld-action-small" type="button" data-answer-close aria-label="Clear answer" title="Clear">
        <img src="${ASSET("close.svg")}" width="11" height="11" alt="">
      </button>
    </div>
    <p class="tld-answer-q">${escapeHtml(question)}</p>
    <div class="tld-rich" data-answer-body>${html}</div>`;
}

function clearAnswer() {
  askStream?.cancel();
  const answer = $("[data-answer]");
  answer.hidden = true;
  answer.innerHTML = "";
}

async function ask(rawQuestion) {
  const question = String(rawQuestion || "").trim();
  if (!question) return;
  await configReady;
  askStream?.cancel();
  lastQuestion = question;
  if (config.blocked && !privacyOverride) {
    setAnswer(question, privacyHtml(PRIVACY_RESPONSE_MESSAGE, privacyDetail("blacklist"), "ask"));
    return;
  }
  const { page, high } = privatePage(extractPage(ASK_TEXT_LIMIT));
  const cleanQuestion = redact(question);
  if ((high > 0 || cleanQuestion.high > 0) && !privacyOverride) {
    setAnswer(question, privacyHtml(PRIVACY_RESPONSE_MESSAGE, privacyDetail("sensitive"), "ask"));
    return;
  }
  setAnswer(question, loaderHtml());
  const body = () => $("[data-answer-body]");
  let text = "";
  const scheduler = frameScheduler(() => {
    const element = body();
    if (element) element.innerHTML = formatText(text, true);
  });
  askStream = streamRequest({ kind: "ask", page, question: cleanQuestion.text, override: privacyOverride }, {
    onDelta(delta) {
      text += delta;
      scheduler.schedule();
    },
    onDone(full) {
      scheduler.cancel();
      const element = body();
      if (element) element.innerHTML = formatText(full || text);
      $("[data-ask-input]").value = "";
    },
    onError(error) {
      scheduler.cancel();
      const element = body();
      if (!element) return;
      element.innerHTML = error.code === "privacy"
        ? privacyHtml(PRIVACY_RESPONSE_MESSAGE, privacyDetail("blacklist"), "ask")
        : errorHtml(error);
    },
  });
}

// ---------------------------------------------------------------- selection tools

function popHasResult() {
  return Boolean(pop?.querySelector(".tld-pop-card"));
}

function hidePop() {
  popStream?.cancel();
  popStream = undefined;
  popSelection = undefined;
  popImage = undefined;
  if (!pop) return;
  pop.hidden = true;
  pop.innerHTML = "";
}

function positionPop() {
  if (!pop || pop.hidden || !popSelection) return;
  const { rect } = popSelection;
  const margin = 8;
  pop.style.left = "0px"; // Measure at full width so the toolbar doesn't wrap near the edge.
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const left = Math.min(window.innerWidth - width - margin, Math.max(margin, rect.left + rect.width / 2 - width / 2));
  let top = rect.bottom + margin;
  if (top + height > window.innerHeight - margin) top = rect.top - height - margin;
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function isSensitiveRange(range) {
  if (hasSecretAncestor(range.commonAncestorContainer)) return true;
  if (hasSecretAncestor(range.startContainer) || hasSecretAncestor(range.endContainer)) return true;
  return [...document.querySelectorAll("input[type='password'], [autocomplete*='cc-']")]
    .some((field) => range.intersectsNode(field));
}

function showToolbar(text, rect) {
  ensureUi();
  popStream?.cancel();
  popSelection = { text, rect };
  const actions = TEXT_ACTIONS.filter((action) => !action.grokOnly || config.provider === "grok");
  pop.innerHTML = `
    <div class="tld-pop-bar" role="toolbar" aria-label="WebHound text tools">
      <img class="tld-pop-mark" src="${ASSET("WebHoundHead.png")}" alt="" width="18" height="18">
      ${actions.map((action) => `
        <button class="tld-pop-btn" type="button" data-text-action="${action.id}">${escapeHtml(action.label)}</button>`).join("")}
    </div>`;
  pop.hidden = false;
  positionPop();
}

function onSelectionEnd(event) {
  if (!config.selectionTools || (config.blocked && !privacyOverride)) return;
  if (host && event?.composedPath?.().includes(host)) return;
  setTimeout(() => {
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString().trim() : "";
    if (text.length < 2) {
      if (!popHasResult()) hidePop();
      return;
    }
    const range = selection.getRangeAt(0);
    if (isSensitiveRange(range)) {
      hidePop();
      return;
    }
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    showToolbar(text.slice(0, SELECTION_LIMIT), rect);
  }, 10);
}

function runTextAction(actionId) {
  const action = TEXT_ACTIONS.find((item) => item.id === actionId);
  if (!action || !popSelection) return;
  popStream?.cancel();
  popImage = undefined;
  lastTextAction = action.id;
  const { text } = popSelection;
  const aprilFools = config.aprilFools === true;
  const tools = action.id === "image"
    ? `<button class="tld-pop-btn tld-pop-small" type="button" data-pop-save disabled>Save Image</button>
       <button class="tld-pop-btn tld-pop-small" type="button" data-pop-copy-image disabled>Copy Image</button>`
    : '<button class="tld-pop-btn tld-pop-small" type="button" data-pop-copy disabled>Copy</button>';
  pop.innerHTML = `
    <div class="tld-pop-card${action.id === "image" ? " tld-pop-card-image" : ""}" role="dialog" aria-label="${escapeHtml(action.title)}">
      <div class="tld-pop-head">
        <img class="tld-pop-mark" src="${ASSET("WebHoundHead.png")}" alt="" width="18" height="18">
        <strong>${escapeHtml(action.title)}</strong>
        <div class="tld-pop-tools">
          ${tools}
          <button class="tld-action tld-action-small" type="button" data-pop-close aria-label="Close">
            <img src="${ASSET("close.svg")}" width="11" height="11" alt="">
          </button>
        </div>
      </div>
      ${aprilFools ? foolsNoteHtml(action.id === "image" ? "this image is a joke" : "this is made up") : ""}
      <div class="tld-pop-body tld-rich" data-pop-body>${loaderHtml(action.id === "image" ? "Fetching your image…" : "Fetching…")}</div>
    </div>`;
  positionPop();

  const body = () => pop.querySelector("[data-pop-body]");
  const cleaned = redact(text);
  if (cleaned.high > 0 && !privacyOverride) {
    body().innerHTML = privacyHtml(PRIVACY_RESPONSE_MESSAGE, privacyDetail("sensitive"), "pop");
    positionPop();
    return;
  }
  const showError = (error) => {
    const element = body();
    if (!element) return;
    element.innerHTML = error.code === "privacy"
      ? privacyHtml(PRIVACY_RESPONSE_MESSAGE, privacyDetail("blacklist"), "pop")
      : errorHtml(error);
    positionPop();
  };

  if (action.id === "image") {
    popStream = streamRequest({ kind: "image", text: cleaned.text, override: privacyOverride, aprilFools }, {
      onImage(image) {
        const element = body();
        if (!element) return;
        const blob = imageBlob(image.dataUrl).catch(() => null);
        popImage = { blob, fileName: imageFileName(text, image.dataUrl) };
        element.innerHTML = `
          <img class="tld-pop-image" src="${escapeHtml(image.dataUrl)}" alt="AI-generated illustration of the selected text">`;
        for (const button of pop.querySelectorAll("[data-pop-save], [data-pop-copy-image]")) button.disabled = false;
        const img = element.querySelector("img");
        img.addEventListener("load", positionPop, { once: true });
        img.addEventListener("error", () => {
          img.replaceWith(Object.assign(document.createElement("p"), {
            className: "tld-note",
            textContent: "This site blocks showing the image here, but you can still save or copy it.",
          }));
          positionPop();
        }, { once: true });
      },
      onError: showError,
    });
    return;
  }

  let output = "";
  const scheduler = frameScheduler(() => {
    const element = body();
    if (element) element.innerHTML = formatText(output, true);
    positionPop();
  });
  popStream = streamRequest({ kind: "selection", action: action.id, text: cleaned.text, title: redact(document.title).text, override: privacyOverride, aprilFools }, {
    onDelta(delta) {
      output += delta;
      scheduler.schedule();
    },
    onReset() {
      // The first draft wasn't short enough; the background is shortening it again.
      output = "";
      const element = body();
      if (element) element.innerHTML = loaderHtml("Trimming further…");
    },
    onDone(full) {
      scheduler.cancel();
      output = full || output;
      const element = body();
      if (element) {
        element.innerHTML = formatText(output);
        if (action.id === "shorten") element.insertAdjacentHTML("beforeend", shortenStatHtml(text, output));
      }
      const copy = pop.querySelector("[data-pop-copy]");
      if (copy) {
        copy.disabled = false;
        copy.dataset.copyText = output;
      }
      positionPop();
    },
    onError(error) {
      scheduler.cancel();
      showError(error);
    },
  });
}

function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function shortenStatHtml(original, shortened) {
  const before = wordCount(original);
  const after = wordCount(stripLinks(shortened));
  if (!before) return "";
  const cut = Math.round((1 - after / before) * 100);
  return `<p class="tld-note tld-shorten-stat">${before} → ${after} words · ${cut}% shorter</p>`;
}

function flashButton(button, message) {
  button.dataset.label ||= button.textContent;
  button.textContent = message;
  clearTimeout(button.flashTimer);
  button.flashTimer = setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1400);
}

function copyPopResult(button) {
  const text = button.dataset.copyText;
  if (!text) return;
  navigator.clipboard?.writeText(text)
    .then(() => flashButton(button, "Copied"))
    .catch(() => flashButton(button, "Couldn't copy"));
}

function overridePrivacy(target) {
  privacyOverride = true;
  if (target === "summary") analyze({ force: true });
  else if (target === "ask") ask(lastQuestion);
  else if (target === "pop" && lastTextAction) runTextAction(lastTextAction);
}

// ---------------------------------------------------------------- generated images

const FILENAME_STOPWORDS = new Set(
  "a an the and or but nor of to in on at for with from by as into onto over than then that this these those is are was were be been being it its their our your his her they we you i".split(" "),
);
const IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** "Honey bees collect nectar…" -> "honey-bees-collect.png": up to 3 meaningful words from the selection. */
function imageFileName(text, dataUrl) {
  const words = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z0-9]+/g) || [];
  const meaningful = words.filter((word) => !FILENAME_STOPWORDS.has(word));
  const chosen = (meaningful.length ? meaningful : words).slice(0, 3).map((word) => word.slice(0, 24));
  const mime = /^data:([^;,]+)/.exec(dataUrl || "")?.[1];
  return `${chosen.join("-") || "webhound-image"}.${IMAGE_EXTENSIONS[mime] || "jpg"}`;
}

/** Decodes the image locally (no network request, so the page's CSP can't block it). */
async function imageBlob(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || "");
  if (!match) return (await fetch(dataUrl)).blob();
  const raw = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return new Blob([bytes], { type: match[1] || "image/jpeg" });
}

/** The clipboard only accepts PNG images, so convert JPEG/WebP first. */
async function toPng(blob) {
  if (!blob) throw new Error("No image");
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

async function saveImage(button) {
  const blob = await popImage?.blob;
  if (!blob) {
    flashButton(button, "Couldn't save");
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: popImage.fileName });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  flashButton(button, "Saved");
}

async function copyImage(button) {
  if (!popImage) return;
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    flashButton(button, "Not available here");
    return;
  }
  try {
    // Passing a promise keeps the click's user activation while the PNG is prepared.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": popImage.blob.then(toPng) })]);
    flashButton(button, "Copied");
  } catch {
    flashButton(button, "Couldn't copy");
  }
}

function onOutsideMousedown(event) {
  if (!pop || pop.hidden) return;
  if (host && event.composedPath().includes(host)) return;
  hidePop();
}

function onDocumentKeydown(event) {
  if (event.key === "Escape" && pop && !pop.hidden) hidePop();
}

function onScroll() {
  if (pop && !pop.hidden && !popHasResult()) hidePop();
}

// ---------------------------------------------------------------- startup

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "TLD_TOGGLE") return;
  if (view === "open") {
    setView("closed");
    return;
  }
  setView("open");
  if (summaryState === "idle" || summaryState === "error") analyze({ force: true });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.theme) applyTheme(changes.theme.newValue);
  clearTimeout(refreshConfig.timer);
  refreshConfig.timer = setTimeout(refreshConfig, 100);
});

const configReady = (async () => {
  const [response, local] = await Promise.all([
    sendMessage({ type: "TLD_GET_CONFIG" }),
    chrome.storage.local.get(["minimized", "dockCorner"]).catch(() => ({})),
  ]);
  if (response?.ok) config = response.config;
  dockCorner = CORNERS.includes(local.dockCorner) ? local.dockCorner : "br";
  startMinimized = Boolean(local.minimized);
  if (root) syncSettings();
})();

async function init() {
  await configReady;
  document.addEventListener("mouseup", onSelectionEnd);
  document.addEventListener("keyup", (event) => {
    if (event.shiftKey || event.key === "Shift") onSelectionEnd(event);
  });
  document.addEventListener("mousedown", onOutsideMousedown, true);
  document.addEventListener("keydown", onDocumentKeydown, true);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("resize", () => {
    if (pop && !pop.hidden && !popHasResult()) hidePop();
  });

  if (startMinimized) setView("minimized");
  analyze();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
