import { generateGrok } from "./grok.mjs";
import { DEFAULT_MODEL, providerForModel, resolveModel } from "./models.mjs";
import { GEMINI_ENDPOINT } from "./schemas.mjs";

async function generateGemini({ apiKey, prompt, schema, model, fetchImpl }) {
  if (!apiKey) {
    throw new Error("Missing Gemini API key");
  }

  const url = `${GEMINI_ENDPOINT}/${model}:generateContent`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const message =
      payload?.error?.message || `Gemini request failed (${response.status})`;
    throw new Error(message);
  }

  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("");
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }
}

export async function generateStructured({
  apiKey,
  prompt,
  schema,
  model = DEFAULT_MODEL,
  schemaName = "tld_response",
  fetchImpl = fetch,
}) {
  const resolved = resolveModel(model);
  if (providerForModel(resolved) === "grok") {
    return generateGrok({
      apiKey,
      prompt,
      schema,
      model: resolved,
      schemaName,
      fetchImpl,
    });
  }
  return generateGemini({ apiKey, prompt, schema, model: resolved, fetchImpl });
}
