import { readErrorMessage, readSse } from "./sse.mjs";
import { GEMINI_ENDPOINT } from "./schemas.mjs";

function checkKey(apiKey) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) throw new Error("Missing Gemini API key");
  if (/[^\x00-\xFF]/u.test(key)) {
    throw new Error("The Gemini API key contains unsupported characters. Paste the key again.");
  }
  return key;
}

/**
 * Streams a Gemini response. `onText` receives each text delta; resolves with the full text.
 * Pass `schema` to request structured JSON output, or `search: true` to ground the answer in
 * Google Search results (reported once at the end through `onGrounding`).
 */
export async function streamGemini({ apiKey, model, prompt, schema, search = false, signal, onText, onGrounding, fetchImpl = fetch }) {
  const key = checkKey(apiKey);
  const generationConfig = { temperature: 0.3 };
  if (schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = schema;
  }

  const response = await fetchImpl(`${GEMINI_ENDPOINT}/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
      ...(search ? { tools: [{ google_search: {} }] } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Gemini request failed (${response.status})`));
  }

  let full = "";
  let blockReason = "";
  const sources = new Map();
  const queries = new Set();
  await readSse(response, (data) => {
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return undefined;
    }
    if (chunk?.error) throw new Error(chunk.error.message || "Gemini stream error");
    blockReason ||= chunk?.promptFeedback?.blockReason || "";
    const grounding = chunk?.candidates?.[0]?.groundingMetadata;
    for (const item of grounding?.groundingChunks || []) {
      if (item.web?.uri && !sources.has(item.web.uri)) sources.set(item.web.uri, { url: item.web.uri, title: item.web.title || "" });
    }
    for (const query of grounding?.webSearchQueries || []) queries.add(query);
    const text = (chunk?.candidates?.[0]?.content?.parts || [])
      .filter((part) => !part.thought)
      .map((part) => part.text || "")
      .join("");
    if (text) {
      full += text;
      onText?.(text);
    }
    return undefined;
  });

  if (!full) {
    throw new Error(blockReason ? `Gemini blocked the request (${blockReason})` : "Gemini returned an empty response");
  }
  if (search) onGrounding?.({ sources: [...sources.values()], queries: [...queries] });
  return full;
}

/** Returns true (valid), false (rejected) or null (could not check). */
export async function verifyGeminiKey(apiKey, fetchImpl = fetch) {
  const key = checkKey(apiKey);
  try {
    const response = await fetchImpl(`${GEMINI_ENDPOINT}?pageSize=1`, {
      headers: { "x-goog-api-key": key },
    });
    if (response.ok || response.status === 429) return { valid: true };
    if ([400, 401, 403].includes(response.status)) {
      return { valid: false, message: await readErrorMessage(response, "Gemini rejected this API key.") };
    }
    return { valid: null };
  } catch {
    return { valid: null };
  }
}
