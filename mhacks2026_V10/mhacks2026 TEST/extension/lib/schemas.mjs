export const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

export const readingSchema = {
  type: "OBJECT",
  properties: {
    summary: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING" },
          headingId: { type: "STRING" },
        },
        required: ["text", "headingId"],
        // Text first so streamed sentences can be shown before their link target arrives.
        propertyOrdering: ["text", "headingId"],
      },
    },
    keyPoints: {
      type: "ARRAY",
      items: { type: "STRING" },
      minItems: 3,
      maxItems: 3,
    },
  },
  required: ["summary", "keyPoints"],
  propertyOrdering: ["summary", "keyPoints"],
};

export function summaryCountFor(text) {
  return Math.min(6, Math.max(2, Math.ceil(text.length / 1200)));
}

function headingList(page) {
  return page.headings.map((heading) => `- id=${heading.id} | ${heading.text}`).join("\n") || "(none)";
}

const PRIVACY_RULE =
  "Text shown as [REDACTED ...] was removed for privacy. Never guess, reconstruct or ask about redacted values.";

// April Fools mode: playful, deliberately wrong output narrated by a dog.
const DOG_VOICE = `APRIL FOOLS MODE: You are a goofy, easily distracted dog narrating. Your output must be deliberately FALSE and funny:
- Loosely inspired by the real text, but confidently and absurdly wrong, the way a dog would misunderstand it.
- Lean on dog things: squirrels, treats, walks, belly rubs, naps, the vacuum, the mail carrier conspiracy, chasing tails.
- Keep it family-friendly and good-natured. No insults or mean jokes, no made-up claims about real, living people, and no medical, legal, financial or safety advice, even joking.`;

export function readingPrompt(page, { aprilFools = false } = {}) {
  const summaryCount = summaryCountFor(page.text);
  const intro = aprilFools
    ? "You are WebHound, a dog. Write a fake, funny 'summary' of this webpage from your dog's-eye view."
    : "You are WebHound. Give a concise reading summary of this webpage.";
  const content = aprilFools
    ? `- summary: exactly ${summaryCount} short, silly sentences forming one paragraph. Each one hilariously misreads a different section.
- keyPoints: exactly 3 ridiculous dog "takeaways", one short sentence each (no more than 12 words).`
    : `- summary: exactly ${summaryCount} short sentences forming one cohesive paragraph. Use more sentences for longer pages, and explain a distinct important part in each.
- keyPoints: exactly 3 concise bullets containing only the three most important takeaways.
- Use ONLY information stated in the page text below. Do not add outside facts, background, definitions or opinions, even if you know them.
- Rank keyPoints by importance. Prefer central conclusions, decisions, facts, or actions over minor details.
- Keep each key point to one short sentence of no more than 12 words.`;
  return `${intro}

Return JSON only. Output the "summary" array before "keyPoints".
${aprilFools ? `\n${DOG_VOICE}\n` : ""}
Rules:
${content}
- headingId MUST be copied exactly from the input headings and must identify the section the sentence came from.
- Use each headingId at most once. Do not repeat an idea or location.
- Do not include page title, URL, source, links, or section lists.
- ${PRIVACY_RULE}

HEADINGS:
${headingList(page)}

PAGE TEXT:
${page.text}`;
}

export function askPrompt(page, question) {
  return `You are WebHound, a reading assistant. Answer the reader's question about the webpage below and its subject.

Rules:
- Use the page content first. You may also use general knowledge: define terms, explain background concepts, give examples, or fill in details the page leaves out.
- If the page itself says something specific about the question, include it, and make clear when your general knowledge goes beyond or differs from what the page says.
- Stay on the page's general topic. If the question has nothing to do with what the page discusses, say in one sentence that you can only help with this page's subject, and suggest a related question instead.
- Be concise: at most 6 sentences, or a short "- " bullet list when listing things.
- Plain text only. No headings, tables or links.
- ${PRIVACY_RULE}

PAGE TITLE: ${page.title}

HEADINGS:
${headingList(page)}

PAGE TEXT:
${page.text}

QUESTION: ${question}`;
}

export function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

/** Shorten must remove at least 30% of the words. */
export function shortenLimit(text) {
  return Math.max(1, Math.floor(countWords(text) * 0.7));
}

function shortenTask(text, funny) {
  const words = countWords(text);
  const limit = shortenLimit(text);
  const target = Math.max(1, Math.round(words * 0.6));
  const budget = `The selected text has ${words} words. Your version MUST be at most ${limit} words (at least 30% shorter); aim for about ${target}.`;
  return funny
    ? `Shorten the selected text the way a dog would retell it, getting the meaning hilariously wrong. ${budget} Return only the shortened text.`
    : `Shorten the selected text. ${budget} Keep the key facts and the original meaning and tone; cut filler, repetition, examples and minor details. Return only the shortened text.`;
}

export function shortenRetryPrompt(draft, limit, { aprilFools = false } = {}) {
  return `Shorten this text to at most ${limit} words. It currently has ${countWords(draft)} words. ${aprilFools ? "Keep the silly dog voice." : "Keep the key facts and meaning."} Return only the shortened text, with no preamble.

TEXT:
"""
${draft}
"""`;
}

/** "Elaborate" deliberately goes beyond the page, using web search for outside sources. */
export function elaboratePrompt(page, summary) {
  return `You are WebHound, a research assistant. The reader just read a summary of the webpage below and wants to learn more about its topic.

Search the web and elaborate using other reliable sources:
- Add background, context, definitions, related facts or recent developments that the page itself does not cover. Don't just restate the page or the summary.
- If reliable sources disagree with or update something the page says, mention it briefly.
- Prefer reputable sources such as official sites, established publications and reference works.
- Write 2 short paragraphs, or 1 short paragraph plus up to 4 "- " bullets. Plain text only.
- Do not include URLs, links or citation markers in the text; sources are listed separately.
- ${PRIVACY_RULE} Never search for redacted values.

PAGE TITLE: ${page.title}

SUMMARY THE READER SAW:
${summary || "(none)"}

HEADINGS:
${headingList(page)}

PAGE EXCERPT:
${String(page.text || "").slice(0, 6000)}`;
}

const SELECTION_TASKS = {
  shorten: (text) => shortenTask(text, false),
  reword:
    "Reword the selected text using different phrasing while keeping the same meaning, tone and roughly the same length. Return only the reworded text.",
  explain:
    "Explain what the selected text means. Define any jargon, acronyms or references and add the context a general reader would need. Use 2 to 5 sentences.",
};

const APRIL_FOOLS_TASKS = {
  shorten: (text) => shortenTask(text, true),
  reword:
    "Reword the selected text the way a dog would retell it, about the same length, getting the meaning hilariously wrong. Return only the reworded text.",
  explain:
    "Explain what the selected text 'really' means, according to a dog. Be confident, detailed and completely wrong. 2 to 5 sentences.",
};

export const SELECTION_ACTIONS = Object.keys(SELECTION_TASKS);

export function selectionPrompt(action, text, title = "", { aprilFools = false } = {}) {
  const entry = (aprilFools ? APRIL_FOOLS_TASKS : SELECTION_TASKS)[action];
  if (!entry) throw new Error("Unknown text action");
  const task = typeof entry === "function" ? entry(text) : entry;
  return `You are WebHound, a ${aprilFools ? "dog" : "reading assistant"}.
${aprilFools ? `\n${DOG_VOICE}\n` : ""}
Task: ${task}
Plain text only. No preamble such as "Here is".
${PRIVACY_RULE}
${title ? `\nThe text comes from a page titled: ${title}\n` : ""}
SELECTED TEXT:
"""
${text}
"""`;
}

export function imagePrompt(text, { aprilFools = false } = {}) {
  const clipped = text.replace(/\s+/g, " ").trim().slice(0, 900);
  if (aprilFools) {
    return `A funny, colorful cartoon showing a dog's hilariously wrong idea of what the following passage is about, drawn from the dog's point of view: dog-sized perspective, with squirrels, treats, tennis balls or a suspicious mail carrier worked in. Family-friendly. No text, captions or lettering in the image.\n\nPassage: ${clipped}`;
  }
  return `A clear, detailed illustration that visually represents the following passage. No text, captions or lettering in the image.\n\nPassage: ${clipped}`;
}
