import { GROK_IMAGE_MODEL } from "./models.mjs";
import { readErrorMessage, readSse } from "./sse.mjs";

export const GROK_BASE = "https://api.x.ai/v1";
export const GROK_ENDPOINT = `${GROK_BASE}/chat/completions`;

const TYPE_MAP = {
  OBJECT: "object",
  STRING: "string",
  ARRAY: "array",
  INTEGER: "integer",
  NUMBER: "number",
  BOOLEAN: "boolean",
};

export function toJsonSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const type =
    TYPE_MAP[schema.type] ||
    (typeof schema.type === "string" ? schema.type.toLowerCase() : undefined);
  const out = {};
  if (type) out.type = type;
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)]),
    );
    out.additionalProperties = false;
  }
  if (schema.items) out.items = toJsonSchema(schema.items);
  if (schema.required) out.required = schema.required;
  if (schema.minItems !== undefined) out.minItems = schema.minItems;
  if (schema.maxItems !== undefined) out.maxItems = schema.maxItems;
  return out;
}

function checkKey(apiKey) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) throw new Error("Missing Grok API key");
  if (/[^\x00-\xFF]/u.test(key)) {
    throw new Error("The Grok API key contains unsupported characters. Paste the key again.");
  }
  return key;
}

function deltaText(delta) {
  const content = delta?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text || "").join("");
  return "";
}

/**
 * Streams a Grok chat completion. `onText` receives each text delta; resolves with the full text.
 * Pass `schema` to request structured JSON output.
 */
export async function streamGrok({
  apiKey,
  model,
  prompt,
  schema,
  schemaName = "tld_response",
  signal,
  onText,
  fetchImpl = fetch,
}) {
  const key = checkKey(apiKey);
  const body = { model, stream: true, messages: [{ role: "user", content: prompt }] };
  if (schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema: toJsonSchema(schema) },
    };
  }

  const response = await fetchImpl(GROK_ENDPOINT, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Grok request failed (${response.status})`));
  }

  let full = "";
  await readSse(response, (data) => {
    if (data.trim() === "[DONE]") return false;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return undefined;
    }
    if (chunk?.error) throw new Error(chunk.error.message || "Grok stream error");
    const text = deltaText(chunk?.choices?.[0]?.delta);
    if (text) {
      full += text;
      onText?.(text);
    }
    return undefined;
  });

  if (!full) throw new Error("Grok returned an empty response");
  return full;
}

/**
 * Streams a Grok answer that can search the web. Live search was removed from Chat Completions,
 * so this uses the Responses API with the server-side `web_search` tool. Cited sources are
 * reported once at the end through `onGrounding`.
 */
export async function streamGrokSearch({ apiKey, model, prompt, signal, onText, onGrounding, fetchImpl = fetch }) {
  const key = checkKey(apiKey);
  const response = await fetchImpl(`${GROK_BASE}/responses`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      stream: true,
      input: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search" }],
    }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Grok request failed (${response.status})`));
  }

  let full = "";
  const sources = new Map();
  const addSource = (url, title = "") => {
    if (typeof url === "string" && /^https?:\/\//i.test(url) && !sources.has(url)) sources.set(url, { url, title: title || "" });
  };
  const collect = (result) => {
    for (const citation of result?.citations || []) {
      addSource(typeof citation === "string" ? citation : citation?.url, citation?.title);
    }
    let text = "";
    for (const item of result?.output || []) {
      for (const part of item?.content || []) {
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
        for (const annotation of part?.annotations || []) addSource(annotation?.url, annotation?.title);
      }
    }
    return text;
  };

  await readSse(response, (data) => {
    if (data.trim() === "[DONE]") return false;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return undefined;
    }
    switch (event?.type) {
      case "response.output_text.delta":
        if (event.delta) {
          full += event.delta;
          onText?.(event.delta);
        }
        return undefined;
      case "response.output_text.annotation.added":
        addSource(event.annotation?.url, event.annotation?.title);
        return undefined;
      case "response.completed": {
        const text = collect(event.response);
        if (!full && text) {
          full = text;
          onText?.(text);
        }
        return false;
      }
      case "response.failed":
      case "error":
        throw new Error(event.response?.error?.message || event.error?.message || event.message || "Grok search failed");
      default:
        return undefined;
    }
  });

  onGrounding?.({ sources: [...sources.values()], queries: [] });
  if (!full) throw new Error("Grok returned an empty response");
  return full;
}

/** Generates one image with Grok Imagine. Resolves with { dataUrl, revisedPrompt }. */
export async function generateGrokImage({ apiKey, prompt, signal, fetchImpl = fetch }) {
  const key = checkKey(apiKey);
  const response = await fetchImpl(`${GROK_BASE}/images/generations`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: GROK_IMAGE_MODEL, prompt, n: 1, response_format: "b64_json" }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Grok image request failed (${response.status})`));
  }
  const payload = await response.json();
  const image = payload?.data?.[0];
  if (!image?.b64_json && !image?.url) throw new Error("Grok returned no image");
  let dataUrl = image.url || "";
  if (image.b64_json) {
    dataUrl = image.b64_json.startsWith("data:")
      ? image.b64_json
      : `data:${image.mime_type || "image/jpeg"};base64,${image.b64_json}`;
  }
  return { dataUrl, revisedPrompt: image.revised_prompt || "" };
}

/** Returns true (valid), false (rejected) or null (could not check). */
export async function verifyGrokKey(apiKey, fetchImpl = fetch) {
  const key = checkKey(apiKey);
  try {
    const response = await fetchImpl(`${GROK_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (response.ok || response.status === 429) return { valid: true };
    if ([400, 401, 403].includes(response.status)) {
      return { valid: false, message: await readErrorMessage(response, "xAI rejected this API key.") };
    }
    return { valid: null };
  } catch {
    return { valid: null };
  }
}
