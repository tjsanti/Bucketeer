import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApi } from "../src/api.js";
import { createClient } from "../src/client.js";
import { openBucketeer } from "../src/core/index.js";

test("HTTP exposes the core and returns useful errors for invalid requests", async () => {
  const core = openBucketeer(":memory:");
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const client = createClient(url);
  let closed = false;
  try {
    assert.deepEqual(await client.status(), { status: "ok" });
    assert.deepEqual(await client.listBudgets(), []);
    const saved = await client.createBudget({ name: "Household" });
    assert.deepEqual(await client.openBudget(saved.id), saved);
    const updated = await client.renameBudget(saved.id, { name: "Renamed" });
    assert.equal(updated.name, "Renamed");
    assert.deepEqual(await client.listBudgets(), [updated]);
    await assert.rejects(client.createBudget({ name: " " }), { code: "invalid_input" });
    await assert.rejects(client.openBudget("missing"), { code: "not_found" });
    await assert.rejects(client.renameBudget("missing", { name: "New" }), { code: "not_found" });

    for (const [body, contentType, expectedStatus, expectedCode] of [
      ["{", "application/json", 400, "invalid_json"],
      ["{}", "text/plain", 415, "unsupported_media_type"],
      [JSON.stringify({ name: "x".repeat(17_000) }), "application/json", 413, "payload_too_large"],
      [JSON.stringify({ id: saved.id, name: "Hijacked" }), "application/json", 400, "invalid_input"],
    ] as const) {
      const response = await fetch(`${url}/api/budgets`, { method: "POST", headers: { "content-type": contentType }, body });
      assert.equal(response.status, expectedStatus);
      assert.equal((await response.json()).error.code, expectedCode);
    }
    for (const body of ["null", "[]", '"x"', JSON.stringify({ id: "other", name: "Hijacked" })]) {
      const response = await fetch(`${url}/api/budgets/${saved.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body });
      assert.equal(response.status, 400);
      const error = (await response.json()).error;
      assert.equal(error.code, "invalid_input");
      if (body !== JSON.stringify({ id: "other", name: "Hijacked" })) assert.equal(error.message, "A budget name is required.");
    }
    const malformedId = await fetch(`${url}/api/budgets/%ZZ`);
    assert.equal(malformedId.status, 400);
    assert.equal((await malformedId.json()).error.code, "invalid_input");
    assert.deepEqual(await client.openBudget(saved.id), updated);

    // An unavailable SQLite connection must fail health rather than reporting a live process as healthy.
    core.close();
    closed = true;
    const unhealthy = await fetch(`${url}/health`);
    assert.equal(unhealthy.status, 503);
    assert.equal((await unhealthy.json()).error.code, "unhealthy");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!closed) core.close();
  }
});
