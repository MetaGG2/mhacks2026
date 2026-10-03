# WebHound

Chrome extension that pops a reading assistant in the top-right of a page: summary, key points, jump-to-section, and useful links. On Google Search it infers likely intent and regroups results into categories.

Design: [Figma — Extension Popup](https://www.figma.com/design/ULgF2fFK4yfLpmjMiVQCWl/MHACKS-2026?node-id=18-3)

## Load the extension

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).
2. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → select the `extension/` folder.
3. Open the extension **Options** page and paste the API key.
4. Visit an article. The overlay should appear. On Google Search it switches to intent categories.

Click the toolbar icon to hide or show the panel.

## CLI (same Gemini prompts as the extension)

```bash
export GEMINI_API_KEY=your_key

node scripts/tldretriever.mjs summarize scripts/examples/page.json
node scripts/tldretriever.mjs rerank scripts/examples/search.json
```

## Layout

- `extension/` — Manifest V3 overlay
- `lib/` — Gemini REST client and JSON schemas
- `docs/superpowers/` — design spec and implementation plan
