#!/usr/bin/env node
/**
 * WebHound Gemini CLI
 *
 * Usage:
 *   export GEMINI_API_KEY=...
 *   export XAI_API_KEY=...
 *   node scripts/tldretriever.mjs summarize page.json
 *   node scripts/tldretriever.mjs rerank search.json --model grok-4.7
 *
 * page.json shape:
 *   { "title", "url", "host", "headings": [{ "id", "text" }], "links": [{ "title", "source", "url" }], "text" }
 *
 * search.json shape:
 *   { "query", "results": [{ "title", "url", "source", "snippet" }] }
 */
import { readFile } from "node:fs/promises";
import { generateStructured } from "../lib/gemini.mjs";
import { providerForModel, resolveModel } from "../lib/models.mjs";
import {
  readingPrompt,
  readingSchema,
  searchPrompt,
  searchSchema,
} from "../lib/schemas.mjs";

function parseArgs(argv) {
  const args = [...argv];
  let model = process.env.TLD_MODEL;
  const flag = args.indexOf("--model");
  if (flag !== -1) {
    model = args[flag + 1];
    args.splice(flag, 2);
  }
  const [command, filePath] = args;
  return { command, filePath, model };
}

const { command, filePath, model: requestedModel } = parseArgs(process.argv.slice(2));

async function readInput() {
  if (filePath) {
    return JSON.parse(await readFile(filePath, "utf8"));
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error("Pass a JSON file path or pipe JSON on stdin.");
  }
  return JSON.parse(raw);
}

async function main() {
  if (command !== "summarize" && command !== "rerank") {
    throw new Error(
      "Usage: node scripts/tldretriever.mjs <summarize|rerank> [file.json] [--model <id>]",
    );
  }
  if (requestedModel && !providerForModel(requestedModel)) {
    throw new Error(`Unknown model: ${requestedModel}`);
  }

  const model = resolveModel(requestedModel);
  const provider = providerForModel(model);
  const apiKey =
    provider === "grok" ? process.env.XAI_API_KEY : process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      provider === "grok"
        ? "Set XAI_API_KEY in the environment."
        : "Set GEMINI_API_KEY in the environment.",
    );
  }

  const input = await readInput();
  const result =
    command === "summarize"
      ? await generateStructured({
          apiKey,
          model,
          prompt: readingPrompt(input),
          schema: readingSchema,
          schemaName: "tld_reading",
        })
      : await generateStructured({
          apiKey,
          model,
          prompt: searchPrompt(input),
          schema: searchSchema,
          schemaName: "tld_search",
        });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
