# WebHound Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship a Manifest V3 Chrome overlay that uses Gemini to summarize pages and regroup Google search results, matching the Figma Extension Popup.

**Architecture:** Content script extracts the page and renders a Shadow DOM overlay. Service worker holds the Gemini API key and calls `generateContent` with structured JSON. A Node CLI (`scripts/tldretriever.mjs`) reuses the same prompts/schemas for local testing.

**Tech Stack:** Chrome MV3, vanilla JS modules, Gemini REST, CSS matching Figma tokens.

**Spec:** `docs/superpowers/specs/2026-10-03-tldretriever-design.md`

## Global Constraints

- Overlay width 390px, top-right, tokens from spec (do not invent a second palette).
- Gemini model `gemini-2.5-flash`; structured JSON only.
- Search categories must cite input result indexes; never invent result URLs.
- Do not commit API keys.

## Review Focus

- Empty or paywalled pages: overlay explains that there is not enough text.
- Missing API key: overlay points at the options page.
- Ambiguous search with one likely intent: still allow 1 category.
- Heading text that does not match the live DOM: jump is a no-op with no crash.
- SERP layout changes: extraction returns `[]` and overlay shows a scan-failed state.

---

### Task 1: Shared Gemini client + schemas

**Files:** `lib/gemini.mjs`, `lib/schemas.mjs`

- [x] JSON schemas for reading + search responses
- [x] `generateStructured(apiKey, { model, prompt, schema })` wrapping REST generateContent

### Task 2: Page extractors + overlay

**Files:** `extension/content.js`, `extension/overlay.css`, `extension/background.js`, `extension/manifest.json`, `extension/options.html`

- [x] Detect Google `/search` vs reading mode
- [x] Extract headings, text, links, or SERP results
- [x] Render Figma-faithful overlay; jump links scroll to heading ids
- [x] Options page stores `geminiApiKey`

### Task 3: CLI script

**Files:** `scripts/tldretriever.mjs`

- [x] `summarize` and `rerank` commands reading JSON from stdin/file
- [x] Same schemas as the extension
