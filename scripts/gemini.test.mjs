import test from "node:test";
import assert from "node:assert/strict";
import { generateStructured } from "../lib/gemini.mjs";
import { GEMINI_MODELS, GROK_MODELS, resolveModel } from "../lib/models.mjs";
import { readingPrompt, readingSchema, searchPrompt } from "../lib/schemas.mjs";

test("generateStructured parses Gemini JSON text", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: '{"summary":"ok"}' }],
          },
        },
      ],
    }),
  });

  const result = await generateStructured({
    apiKey: "test-key",
    prompt: "hi",
    schema: { type: "OBJECT" },
    fetchImpl,
  });
  assert.equal(result.summary, "ok");
});

test("generateStructured surfaces API errors", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: "API key not valid" } }),
  });

  await assert.rejects(
    () =>
      generateStructured({
        apiKey: "bad",
        prompt: "hi",
        schema: { type: "OBJECT" },
        fetchImpl,
      }),
    /API key not valid/,
  );
});

test("readingPrompt includes heading ids", () => {
  const prompt = readingPrompt({
    title: "Demo",
    url: "https://example.com",
    host: "example.com",
    headings: [{ id: "tld-section-0", text: "Intro" }],
    links: [],
    text: "Hello world",
  });
  assert.match(prompt, /id=tld-section-0/);
  assert.match(prompt, /headingId MUST be copied exactly/);
});

test("listed models are the gemini and grok catalogs", () => {
  assert.deepEqual(GEMINI_MODELS, [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
  ]);
  assert.deepEqual(GROK_MODELS, [
    "grok-4.7",
    "grok-4.6",
    "grok-4.5",
    "grok-4.3",
    "grok-4.20-0309-non-reasoning",
    "grok-4.20-0309-reasoning",
  ]);
  assert.equal(resolveModel("not-a-model"), "gemini-3.1-flash-lite");
});

test("generateStructured calls Gemini generateContent for a Gemini model", async () => {
  let requested;
  const fetchImpl = async (url, init) => {
    requested = { url, init };
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"summary":"ok"}' }] } }],
      }),
    };
  };

  await generateStructured({
    apiKey: "gemini-key",
    prompt: "hi",
    schema: { type: "OBJECT" },
    model: "gemini-3.8-flash",
    fetchImpl,
  });

  assert.equal(
    requested.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
  );
  assert.equal(requested.init.headers["x-goog-api-key"], "gemini-key");
});

test("generateStructured calls Grok chat completions with a JSON schema", async () => {
  let requested;
  const fetchImpl = async (url, init) => {
    requested = { url, body: JSON.parse(init.body), headers: init.headers };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"summary":"grouped"}' } }],
      }),
    };
  };

  const result = await generateStructured({
    apiKey: "grok-key",
    prompt: "rerank",
    schema: readingSchema,
    schemaName: "tld_reading",
    model: "grok-4.20-0309-reasoning",
    fetchImpl,
  });

  assert.equal(result.summary, "grouped");
  assert.equal(requested.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(requested.headers.Authorization, "Bearer grok-key");
  assert.equal(requested.body.model, "grok-4.20-0309-reasoning");
  assert.equal(requested.body.response_format.type, "json_schema");
  assert.equal(requested.body.response_format.json_schema.strict, true);
  assert.equal(requested.body.response_format.json_schema.schema.type, "object");
  assert.equal(
    requested.body.response_format.json_schema.schema.additionalProperties,
    false,
  );
});

test("searchPrompt numbers results", () => {
  const prompt = searchPrompt({
    query: "anc headphones",
    results: [
      {
        title: "Sony",
        url: "https://example.com/sony",
        source: "example.com",
        snippet: "ANC",
      },
    ],
  });
  assert.match(prompt, /\[0\] Sony/);
});
