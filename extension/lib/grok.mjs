export const GROK_ENDPOINT = "https://api.x.ai/v1/chat/completions";

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
  return out;
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part.text || "").join("");
  }
  return "";
}

export async function generateGrok({
  apiKey,
  prompt,
  schema,
  model,
  schemaName = "tld_response",
  fetchImpl = fetch,
}) {
  if (!apiKey) {
    throw new Error("Missing Grok API key");
  }

  const response = await fetchImpl(GROK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema: toJsonSchema(schema),
        },
      },
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const message =
      payload?.error?.message || `Grok request failed (${response.status})`;
    throw new Error(message);
  }

  const text = messageText(payload?.choices?.[0]?.message);
  if (!text) {
    throw new Error("Grok returned an empty response");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Grok returned invalid JSON");
  }
}
