# WebHound

Chrome extension that shows a compact reading summary and key points in the top-right of a page. Summary sentences link back to the source section. Responses stream in as they are generated.

## Load the extension

1. Get an API key:
   - Gemini: [Google AI Studio](https://aistudio.google.com/apikey)
   - Grok: [xAI Console](https://console.x.ai/)
2. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → select the `extension/` folder.
3. Visit an article. In the WebHound panel, open **Settings** (⚙), paste the key and press **Confirm**. The key is checked with the provider, and the model list switches to that provider's models.
   - Gemini keys start with `AIza` (older Standard keys) or `AQ.` (the Auth keys AI Studio now issues). Grok keys start with `xai-`.
   - A key in an unfamiliar format is checked with both Gemini and xAI, and WebHound uses whichever one accepts it.

Click the toolbar icon to hide or show the panel.

## Features

- **Streaming summaries.** Summary sentences and key points appear as the model writes them. Summaries use only what the page says.
- **Elaborate.** The "Elaborate with web sources" button under a summary searches the web for background and context beyond the page and lists clickable sources. It uses Google Search grounding with Gemini and the Responses API `web_search` tool with Grok.
- **Ask about the page.** Type a question in the bar under the header. Answers can include definitions and general background knowledge, as long as the question is about the page's topic.
- **Highlight tools.** Select text on any page to get Shorten (always at least 30% fewer words, with the reduction shown), Reword and Explain. With a Grok key there is also Generate image (Grok Imagine), with **Save Image** and **Copy Image** buttons. Saved images are named from the first three meaningful words of the selection, e.g. `honey-bees-collect.jpg`.
- **April Fools mode** (Settings). Summaries, shortened text, rewordings, explanations and images become deliberately false, funny takes from a dog's point of view. Each one is labeled "April Fools mode" so it isn't mistaken for the real thing. Search-bar answers stay real.
- **Minimize.** The – button tucks WebHound into the nearest corner as a small icon. Move the mouse into that corner to reveal it and click to reopen. A dot on the icon shows when a summary is loading or ready. The minimized state is remembered across pages.
- **Privacy.**
  - The **privacy blacklist** (Settings) covers major banks, payment, investing, crypto, tax, health-portal, payroll, account and email sites by default and can be edited. On these sites nothing is sent to the AI and the panel shows "Could not produce summary due to privacy concerns".
  - Inputs, password and other secret-looking fields are never read or sent.
  - Emails, phone numbers and API tokens are redacted before anything is sent. Content containing card numbers, SSNs, IBANs or account numbers is especially vulnerable, so it is not sent by default.
  - Every privacy notice has a **Continue anyway** button. It applies to the current page until it is reloaded. Personal details are still redacted and password fields are still never sent.

## Layout

- `extension/` — Manifest V3 overlay (`content.js`, `overlay.css`) and service worker (`background.js`)
- `extension/lib/` — provider clients (`gemini.mjs`, `grok.mjs`, `ai.mjs`), SSE reader, model catalog, prompts/schemas, privacy blacklist
- `extension/assets/` — logos. `WebHoundHead.png` is the dog-head logo used in the panel; `icon-16/32/48/128.png` are the toolbar icons (head on a white tile).
