export const GEMINI_MODEL = "gemini-3.1-flash-lite";
export const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

export const readingSchema = {
  type: "OBJECT",
  properties: {
    pageTitle: { type: "STRING" },
    source: { type: "STRING" },
    readMinutes: { type: "INTEGER" },
    summary: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING" },
          headingId: { type: "STRING" },
        },
        required: ["text", "headingId"],
      },
    },
    keyPoints: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          headingId: { type: "STRING" },
          title: { type: "STRING" },
          location: { type: "STRING" },
        },
        required: ["headingId", "title", "location"],
      },
    },
    usefulLinks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          source: { type: "STRING" },
          url: { type: "STRING" },
        },
        required: ["title", "source", "url"],
      },
    },
  },
  required: ["pageTitle", "source", "readMinutes", "summary", "keyPoints", "sections", "usefulLinks"],
};

export const searchSchema = {
  type: "OBJECT",
  properties: {
    query: { type: "STRING" },
    resultsScanned: { type: "INTEGER" },
    intent: {
      type: "OBJECT",
      properties: {
        summary: { type: "STRING" },
        confidence: {
          type: "STRING",
          enum: ["HIGH", "MEDIUM", "LOW"],
        },
        priorities: {
          type: "ARRAY",
          items: { type: "STRING" },
        },
      },
      required: ["summary", "confidence", "priorities"],
    },
    categories: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING" },
          rationale: { type: "STRING" },
          resultIndexes: {
            type: "ARRAY",
            items: { type: "INTEGER" },
          },
        },
        required: ["label", "rationale", "resultIndexes"],
      },
    },
    explanations: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          resultIndex: { type: "INTEGER" },
          why: { type: "STRING" },
        },
        required: ["resultIndex", "why"],
      },
    },
  },
  required: ["query", "resultsScanned", "intent", "categories", "explanations"],
};

export function readingPrompt(page) {
  return `You are WebHound, a reading assistant. Summarize this webpage so a user can jump to the part they want in a few seconds.

Return JSON only.

Rules:
- summary: 2-4 parts that read as one paragraph. Each part is one sentence. text is that sentence. headingId MUST be copied exactly from the input headings and must be the heading of the section that sentence came from, so the user can click it and jump there. Do not invent heading ids.
- keyPoints: 3 short bullets.
- sections: pick 3-6 of the provided headings that best outline the page. headingId MUST be copied exactly from the input headings. location is a short clause about what that section covers.
- usefulLinks: pick up to 3 outbound links from the page that help someone go deeper. Prefer distinct sources. If fewer exist, return fewer.
- readMinutes: estimate from word count (~200 wpm).
- source: hostname only.

PAGE TITLE: ${page.title}
URL: ${page.url}
HOST: ${page.host}

HEADINGS:
${page.headings.map((h) => `- id=${h.id} | ${h.text}`).join("\n") || "(none)"}

OUTBOUND LINKS:
${page.links.map((l) => `- ${l.title} | ${l.source} | ${l.url}`).join("\n") || "(none)"}

MAIN TEXT:
${page.text}`;
}

export function searchPrompt(search) {
  return `You are WebHound, a search-intent assistant. Short search queries are often ambiguous. Infer what the user likely wants and regroup the provided organic results into 1 or more categories that each represent a plausible intent.

Return JSON only.

Rules:
- Do not invent results or URLs. Only use resultIndexes from the numbered list.
- 1-4 categories. Each category has a short label, a one-line rationale, and 1-4 resultIndexes ranked best-first.
- A result may appear in more than one category if it genuinely fits.
- intent.summary: one sentence stating the most likely need.
- intent.confidence: HIGH if the query is specific, MEDIUM if mixed, LOW if very vague.
- intent.priorities: 2-4 short chips (2-4 words) for the primary intent.
- explanations: one why-string per result that appears in any category.

QUERY: ${search.query}

RESULTS:
${search.results
  .map(
    (r, i) =>
      `[${i}] ${r.title}\n    url: ${r.url}\n    source: ${r.source}\n    snippet: ${r.snippet}`,
  )
  .join("\n")}`;
}
