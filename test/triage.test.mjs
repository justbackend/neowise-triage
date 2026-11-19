import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, MODEL_TIMEOUT_MS } from "../server.mjs";

let server;
let base;

before(async () => {
  server = createApp({ log: () => {} }); // the real mock model, unchanged
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function triage(body) {
  const reply = await fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() };
}

const MANUAL = { status: "manual_review", topic: null, draft: null };

test("a normal request returns topic and draft", async () => {
  assert.deepEqual(await triage({ text: "Когда будет доставка заказа?" }), {
    status: 200,
    body: { status: "ready", topic: "delivery", draft: "Спасибо за обращение. Уточним детали заявки." },
  });
  assert.equal((await triage({ text: "Какая цена?" })).body.topic, "pricing");
  assert.equal((await triage({ text: "Здравствуйте" })).body.topic, "other");
});

for (const [name, body] of [
  ["broken JSON", "{not json"],
  ["missing text", {}],
  ["empty text", { text: "" }],
  ["whitespace text", { text: "   \n" }],
  ["non-string text", { text: 42 }],
  ["null body", "null"],
]) {
  test(`invalid input: ${name} -> 400`, async () => {
    assert.deepEqual(await triage(body), { status: 400, body: { status: "invalid_input" } });
  });
}

for (const tag of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`model failure ${tag} -> manual_review`, async () => {
    assert.deepEqual(await triage({ text: `Где моя доставка? ${tag}` }), { status: 200, body: MANUAL });
  });
}

test("model timeout -> manual_review within the 300 ms budget", async () => {
  const started = performance.now();
  const result = await triage({ text: "Где моя доставка? [timeout]" });
  const elapsed = performance.now() - started;
  assert.deepEqual(result, { status: 200, body: MANUAL });
  // The mock sleeps 1200 ms; we must answer long before that.
  assert.ok(elapsed < MODEL_TIMEOUT_MS + 400, `took ${Math.round(elapsed)} ms`);
});

test("deadline holds even if the model ignores the abort signal", async () => {
  const stubborn = createApp({ classify: () => new Promise(() => {}), log: () => {} });
  await new Promise((resolve) => stubborn.listen(0, "127.0.0.1", resolve));
  try {
    const reply = await fetch(`http://127.0.0.1:${stubborn.address().port}/api/triage`, {
      method: "POST",
      body: JSON.stringify({ text: "Где заказ?" }),
    });
    assert.deepEqual(await reply.json(), MANUAL);
  } finally {
    stubborn.closeAllConnections();
    await new Promise((resolve) => stubborn.close(resolve));
  }
});
