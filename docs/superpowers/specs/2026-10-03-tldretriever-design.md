# WebHound Design Spec

**Date:** 2026-10-03  
**Product:** WebHound Chrome extension  
**Figma:** [MHACKS-2026 — Extension Popup](https://www.figma.com/design/ULgF2fFK4yfLpmjMiVQCWl/MHACKS-2026?node-id=18-3)

## Intent

Save a few seconds of hunting on a page. On article-like pages, show a reading assistant in the top-right that summarizes the page, lists key points, jump-links to on-page sections, and useful related links. On Google Search, switch to a search assistant that infers what the short query might mean and regroups organic results into 1+ intent categories.

## Modes

1. **Reading assistant** (default) — any non-search page with extractable text.
2. **Search assistant** — Google Search result pages (`google.*/search`).

## UI (from Figma)

Dark forest overlay, 390px wide, 14px radius, shadow `0 10px 28px -4px rgba(0,0,0,0.4)`.

Tokens:

| Token | Value |
| --- | --- |
| Surface | `#0f1410` |
| Header | `#121a16` |
| Card | `#16201d` |
| Border | `#24312d` |
| Accent | `#315e52` |
| Status fill | `#17312f` |
| Title | `#f4f7f4` |
| Body | `#d7ded4` |
| Muted | `#8fa39a` |
| Teal label | `#73a698` |
| Type | Inter (UI), Lora (titles + summary) |

**Reading:** brand, page title, host · read-time, Ready pill, Summary, Key points, Jump to section (scrolls to heading), Useful links (open in new tab).

**Search:** brand, current query, results scanned, AI-inferred intent + confidence + priority chips, categorized ranked results with why-this-link copy, footer `N of M results` and View all.

## Model

Google Gemini (`gemini-2.5-flash`) via REST `generateContent` with `responseMimeType: application/json` and a mode-specific `responseSchema`.

- Reading prompt: page title, URL, truncated main text, heading list (id + text), outbound links.
- Search prompt: query, organic results (title, url, snippet). Model returns inferred intent, confidence, priorities, and categories that **only reference result indexes** from the input (no invented URLs).

API key lives in `chrome.storage.sync`, set on the options page. The service worker makes the network call (avoids page CORS).

## Page extraction

- Headings `h1–h3` get a stable `id` if missing (`tld-section-N`) so jump links can `scrollIntoView`.
- Main text from `article`, `[role=main]`, or `body`, stripped of nav/footer/script, capped at ~12k characters.
- Google organic results from common SERP containers; skip ads.

## Non-goals (v1)

- Non-Google search engines.
- Rewriting the SERP DOM in place (overlay only).
- Streaming tokens, accounts, or history sync.
