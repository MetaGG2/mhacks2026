const ASSET = (name) => chrome.runtime.getURL(`assets/${name}`);

let host;
let shadow;
let showAllResults = false;
let lastPayload = null;
let lastMode = "reading";
let analyzing = false;

function isGoogleSearch() {
  return /(^|\.)google\./.test(location.hostname) && location.pathname.startsWith("/search");
}

function injectFonts() {
  if (document.getElementById("tld-fonts")) return;
  const link = document.createElement("link");
  link.id = "tld-fonts";
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Lora&display=swap";
  document.documentElement.appendChild(link);
}

async function ensureUi() {
  if (host) return;
  injectFonts();
  host = document.createElement("div");
  host.id = "tldretriever-host";
  shadow = host.attachShadow({ mode: "open" });
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("overlay.css");
  shadow.appendChild(link);
  const root = document.createElement("div");
  root.className = "tld-root";
  shadow.appendChild(root);
  document.documentElement.appendChild(host);

  shadow.addEventListener("mousemove", (event) => {
    const glow = shadow.querySelector(".tld-glow");
    if (!glow) return;
    glow.style.left = `${event.clientX}px`;
    glow.style.top = `${event.clientY}px`;
  });

  shadow.addEventListener("click", (event) => {
    const close = event.target.closest("[data-close]");
    if (close) {
      root.classList.add("tld-hidden");
      return;
    }
    const jump = event.target.closest("[data-jump]");
    if (jump) {
      const target = document.getElementById(jump.dataset.jump);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const viewAll = event.target.closest("[data-view-all]");
    if (viewAll && lastPayload) {
      showAllResults = true;
      renderSearch(lastPayload, lastPayload._meta);
    }
  });
}

function rootEl() {
  return shadow.querySelector(".tld-root");
}

function statusPill(label) {
  return `<div class="tld-status"><img src="${ASSET("status-dot.svg")}" width="5" height="5" alt=""><span>${label}</span></div>`;
}

function heading(label) {
  return `<div class="tld-heading"><div class="tld-accent"></div><span>${label}</span></div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderShell({ purpose, contextHtml, bodyHtml }) {
  const root = rootEl();
  root.classList.remove("tld-hidden");
  root.innerHTML = `
    <div class="tld-glow" aria-hidden="true"></div>
    <div class="tld-header">
      <div class="tld-bar">
        <div class="tld-brand">
          <div class="tld-mark"><img src="${ASSET("dog.svg")}" width="14" height="14" alt=""></div>
          <div>
            <p class="tld-product">WebHound</p>
            <p class="tld-purpose">${purpose}</p>
          </div>
        </div>
        <button class="tld-close" type="button" data-close aria-label="Close">
          <img src="${ASSET("close.svg")}" width="14" height="14" alt="">
        </button>
      </div>
      ${contextHtml}
    </div>
    ${bodyHtml}
  `;
}

function renderMessage(purpose, contextHtml, message) {
  renderShell({
    purpose,
    contextHtml,
    bodyHtml: `<div class="tld-body"><p class="tld-message">${escapeHtml(message)}</p></div>`,
  });
}

function extractHeadings() {
  return [...document.querySelectorAll("h1, h2, h3")].map((el, index) => {
    if (!el.id) el.id = `tld-section-${index}`;
    return { id: el.id, text: el.innerText.trim().slice(0, 160) };
  }).filter((headingItem) => headingItem.text);
}

function extractText() {
  const root =
    document.querySelector("article") ||
    document.querySelector("[role='main']") ||
    document.querySelector("main") ||
    document.body;
  const clone = root.cloneNode(true);
  clone.querySelectorAll("script, style, noscript, nav, footer, aside, iframe, svg, form").forEach((el) => {
    el.remove();
  });
  return clone.innerText.replace(/\s+/g, " ").trim().slice(0, 12000);
}

function extractLinks() {
  const seen = new Set();
  const links = [];
  const scope =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.body;
  for (const anchor of scope.querySelectorAll("a[href]")) {
    let url;
    try {
      url = new URL(anchor.href);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.hostname === location.hostname) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const title = anchor.innerText.trim() || url.hostname;
    links.push({
      title: title.slice(0, 90),
      source: url.hostname.replace(/^www\./, ""),
      url: url.href,
    });
    if (links.length >= 15) break;
  }
  return links;
}

function extractReadingPage() {
  const text = extractText();
  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    title: document.title || "Untitled page",
    url: location.href,
    host: location.hostname.replace(/^www\./, ""),
    headings: extractHeadings(),
    links: extractLinks(),
    text,
    wordCount: words,
  };
}

function extractSearch() {
  const query =
    document.querySelector("textarea[name='q'], input[name='q']")?.value?.trim() ||
    new URLSearchParams(location.search).get("q") ||
    "";
  const nodes = [
    ...document.querySelectorAll("#search .MjjYud, #rso .g, #search .g, #rso .MjjYud"),
  ];
  const results = [];
  const seen = new Set();

  for (const node of nodes) {
    if (node.closest("[data-text-ad], .uEierd, #tads, #tadsb, .commercial-unit-desktop-top")) {
      continue;
    }
    const titleEl = node.querySelector("h3");
    const title = titleEl?.innerText?.trim();
    const anchor = titleEl?.closest("a") || node.querySelector("a[href^='http']");
    const href = anchor?.href;
    if (!title || !href || seen.has(href)) continue;
    if (href.includes("google.") && href.includes("/search")) continue;
    seen.add(href);
    let source = "";
    try {
      source = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      source = "";
    }
    const snippet =
      node.querySelector(".VwiC3b, .IsZvec, [data-sncf], .ITZItd")?.innerText?.trim() || "";
    results.push({
      title,
      url: href,
      source,
      snippet: snippet.slice(0, 280),
    });
    if (results.length >= 24) break;
  }

  return { query, results };
}

function renderReading(data, page) {
  lastMode = "reading";
  const contextHtml = `
    <div class="tld-page">
      <div class="tld-page-copy">
        <p class="tld-title">${escapeHtml(data.pageTitle || page.title)}</p>
        <p class="tld-meta">${escapeHtml(data.source || page.host)} · ${escapeHtml(data.readMinutes || 1)} min read</p>
      </div>
      ${statusPill("Ready")}
    </div>
  `;
  const points = (data.keyPoints || [])
    .map(
      (point) => `
        <li>
          <img src="${ASSET("status-dot.svg")}" width="5" height="5" alt="">
          <span>${escapeHtml(point)}</span>
        </li>`,
    )
    .join("");
  const sections = (data.sections || [])
    .map(
      (section) => `
        <button class="tld-jump" type="button" data-jump="${escapeHtml(section.headingId)}">
          <div class="tld-marker"><img src="${ASSET("corner-down-right.svg")}" width="13" height="13" alt=""></div>
          <div class="tld-item-copy">
            <p class="tld-item-title">${escapeHtml(section.title)}</p>
            <p class="tld-item-sub">${escapeHtml(section.location)}</p>
          </div>
          <img src="${ASSET("chevron-right.svg")}" width="15" height="15" alt="">
        </button>`,
    )
    .join("");
  const links = (data.usefulLinks || [])
    .map(
      (linkItem) => `
        <a class="tld-link" href="${escapeHtml(linkItem.url)}" target="_blank" rel="noopener noreferrer">
          <div class="tld-item-copy">
            <p class="tld-item-title">${escapeHtml(linkItem.title)}</p>
            <p class="tld-item-sub">${escapeHtml(linkItem.source)}</p>
          </div>
          <div class="tld-ext"><img src="${ASSET("external-link.svg")}" width="14" height="14" alt=""></div>
        </a>`,
    )
    .join("");

  renderShell({
    purpose: "Reading assistant",
    contextHtml,
    bodyHtml: `
      <div class="tld-body">
        <section class="tld-section">
          ${heading("Summary")}
          <p class="tld-summary">${escapeHtml(data.summary)}</p>
        </section>
        <hr class="tld-divider">
        <section class="tld-section">
          ${heading("Key points")}
          <ul class="tld-points">${points}</ul>
        </section>
        <hr class="tld-divider">
        <section class="tld-section">
          ${heading("Jump to section")}
          <div class="tld-stack">${sections}</div>
        </section>
        <hr class="tld-divider">
        <section class="tld-section">
          ${heading("Useful links")}
          <div class="tld-stack">${links}</div>
        </section>
      </div>
    `,
  });
}

function chipIcon(index) {
  const names = ["waves.svg", "mic.svg", "clock.svg"];
  return ASSET(names[index % names.length]);
}

function renderSearch(data, search) {
  lastMode = "search";
  lastPayload = { ...data, _meta: search };
  const contextHtml = `
    <div class="tld-search-context">
      <p class="tld-context-label">Current Google search</p>
      <p class="tld-query">${escapeHtml(data.query || search.query)}</p>
      <p class="tld-meta">google.com · ${escapeHtml(data.resultsScanned || search.results.length)} results scanned</p>
    </div>
  `;
  const chips = (data.intent?.priorities || [])
    .map(
      (priority, index) => `
        <div class="tld-chip">
          <img src="${chipIcon(index)}" width="11" height="11" alt="">
          <span>${escapeHtml(priority)}</span>
        </div>`,
    )
    .join("");
  const whyByIndex = new Map(
    (data.explanations || []).map((item) => [item.resultIndex, item.why]),
  );
  const categories = (data.categories || [])
    .map((category, catIndex) => {
      const indexes = showAllResults
        ? category.resultIndexes || []
        : (category.resultIndexes || []).slice(0, 2);
      const cards = indexes
        .map((resultIndex) => {
          const result = search.results[resultIndex];
          if (!result) return "";
          return `
            <a class="tld-result" href="${escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer">
              <p class="tld-result-title">${escapeHtml(result.title)}</p>
              <div class="tld-source-row">
                <img src="${ASSET("globe.svg")}" width="11" height="11" alt="">
                <span>${escapeHtml(result.source)}</span>
                <img src="${ASSET("arrow-up-right.svg")}" width="12" height="12" alt="">
              </div>
              <p class="tld-why">${escapeHtml(whyByIndex.get(resultIndex) || result.snippet)}</p>
            </a>`;
        })
        .join("");
      const divider =
        catIndex < (data.categories || []).length - 1 ? `<hr class="tld-divider">` : "";
      return `
        <section class="tld-section">
          <div class="tld-cat-head">
            <div class="tld-accent"></div>
            <div class="tld-cat-copy">
              <p class="tld-cat-label">${escapeHtml(category.label)}</p>
              <p class="tld-cat-why">${escapeHtml(category.rationale)}</p>
            </div>
            <span class="tld-count">${indexes.length} LINKS</span>
          </div>
          <div class="tld-stack">${cards}</div>
        </section>
        ${divider}
      `;
    })
    .join("");

  const shown = (data.categories || []).reduce((sum, category) => {
    const count = showAllResults
      ? category.resultIndexes.length
      : Math.min(2, category.resultIndexes.length);
    return sum + count;
  }, 0);

  renderShell({
    purpose: "Search assistant",
    contextHtml,
    bodyHtml: `
      <div class="tld-body tld-search-body">
        <div class="tld-intent">
          <div class="tld-heading">
            <div class="tld-accent"></div>
            <span>AI-inferred intent</span>
            <div class="tld-confidence">${escapeHtml(data.intent?.confidence || "MEDIUM")} CONFIDENCE</div>
          </div>
          <p class="tld-summary">${escapeHtml(data.intent?.summary || "")}</p>
          <div class="tld-chips">${chips}</div>
        </div>
        <div class="tld-section">${categories}</div>
        <div class="tld-footer">
          <span>${shown} of ${search.results.length} results</span>
          ${
            showAllResults
              ? ""
              : `<button class="tld-viewall" type="button" data-view-all>View all <img src="${ASSET("chevron-right.svg")}" width="12" height="12" alt=""></button>`
          }
        </div>
      </div>
    `,
  });
}

async function analyze() {
  if (analyzing) return;
  analyzing = true;
  await ensureUi();
  showAllResults = false;

  const searchMode = isGoogleSearch();
  if (searchMode) {
    const search = extractSearch();
    renderMessage(
      "Search assistant",
      `<div class="tld-search-context">
        <p class="tld-context-label">Current Google search</p>
        <p class="tld-query">${escapeHtml(search.query || "Search")}</p>
        <p class="tld-meta">google.com · scanning ${search.results.length} results</p>
      </div>`,
      search.results.length
        ? "Grouping results by likely intent…"
        : "No organic results found on this search page.",
    );
    if (!search.results.length) {
      analyzing = false;
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TLD_ANALYZE",
        payload: { mode: "search", search },
      });
      if (!response?.ok) throw new Error(response?.error || "Analysis failed");
      renderSearch(response.result, search);
    } catch (error) {
      renderMessage(
        "Search assistant",
        `<div class="tld-search-context"><p class="tld-query">${escapeHtml(search.query)}</p></div>`,
        error.message,
      );
    } finally {
      analyzing = false;
    }
    return;
  }

  const page = extractReadingPage();
  renderMessage(
    "Reading assistant",
    `<div class="tld-page">
      <div class="tld-page-copy">
        <p class="tld-title">${escapeHtml(page.title)}</p>
        <p class="tld-meta">${escapeHtml(page.host)}</p>
      </div>
      ${statusPill("Working")}
    </div>`,
    page.text.length < 80
      ? "Not enough readable text on this page."
      : "Summarizing the page…",
  );
  if (page.text.length < 80) {
    analyzing = false;
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TLD_ANALYZE",
      payload: { mode: "reading", page },
    });
    if (!response?.ok) throw new Error(response?.error || "Analysis failed");
    renderReading(response.result, page);
  } catch (error) {
    renderMessage(
      "Reading assistant",
      `<div class="tld-page"><div class="tld-page-copy"><p class="tld-title">${escapeHtml(page.title)}</p></div></div>`,
      error.message,
    );
  } finally {
    analyzing = false;
  }
}

function toggle() {
  if (!host) {
    analyze();
    return;
  }
  const root = rootEl();
  if (root.classList.contains("tld-hidden")) {
    root.classList.remove("tld-hidden");
    return;
  }
  root.classList.add("tld-hidden");
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "TLD_TOGGLE") toggle();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => analyze(), { once: true });
} else {
  analyze();
}
