import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };
const INVALID_INPUT = { status: "invalid_input" };

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

class InvalidInput extends Error {}

async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInput("body too large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidInput("broken JSON");
  }
  const text = body?.text;
  if (typeof text !== "string" || text.trim() === "") throw new InvalidInput("text must be a non-empty string");
  return text;
}

// The model's answer is untrusted: getting a reply says nothing about its content.
// Returns { topic, draft } only when every field is usable, otherwise null.
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const { topic, draft } = data;
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft };
}

// Resolves with the model's raw output; rejects on a model error or after timeoutMs.
// The race keeps the deadline even if a provider ignores the abort signal.
async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`model timeout after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS, log = console.warn } = {}) {
  async function handleTriage(request, response) {
    let text;
    try {
      text = await readText(request);
    } catch (error) {
      if (error instanceof InvalidInput) return json(response, 400, INVALID_INPUT);
      throw error;
    }

    let result = null;
    try {
      result = parseModelOutput(await callModel(classify, text, timeoutMs));
      if (!result) log("triage: unusable model output -> manual_review");
    } catch (error) {
      log(`triage: ${error.message} -> manual_review`);
    }
    if (!result) return json(response, 200, MANUAL_REVIEW);
    return json(response, 200, { status: "ready", ...result });
  }

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch {
      if (!response.headersSent) json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}`));
}
