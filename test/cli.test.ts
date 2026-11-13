import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { createApi } from "../src/api.js";
import { openBucketeer } from "../src/core/index.js";

test("CLI preserves JSON error codes and provides useful text output for every command", async () => {
  const core = openBucketeer(":memory:");
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveResult) => {
      execFile(process.execPath, [resolve("dist/cli.js"), ...args], { env: { ...process.env, BUCKETEER_URL: url } }, (error, stdout, stderr) => {
        resolveResult({ code: error ? Number(error.code) || 1 : 0, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }
  try {
    assert.deepEqual(await cli("status"), { code: 0, stdout: "ok", stderr: "" });
    assert.deepEqual(JSON.parse((await cli("status", "--json")).stdout), { status: "ok" });
    assert.deepEqual(await cli("budget", "list"), { code: 0, stdout: "No saved budgets.", stderr: "" });
    const savedResult = await cli("budget", "save", "--name", "Household", "--json");
    assert.equal(savedResult.code, 0);
    const saved = JSON.parse(savedResult.stdout);
    assert.equal(saved.name, "Household");
    assert.deepEqual(JSON.parse((await cli("budget", "list", "--json")).stdout), [saved]);
    assert.deepEqual(JSON.parse((await cli("budget", "open", saved.id, "--json")).stdout), saved);
    const updated = JSON.parse((await cli("budget", "save", "--id", saved.id, "--name", "New name", "--json")).stdout);
    assert.equal(updated.name, "New name");
    assert.equal(updated.id, saved.id);
    assert.equal(updated.createdAt, saved.createdAt);
    const expectedText = `${saved.id}\tNew name`;
    assert.deepEqual(await cli("budget", "list"), { code: 0, stdout: expectedText, stderr: "" });
    assert.deepEqual(await cli("budget", "open", saved.id), { code: 0, stdout: expectedText, stderr: "" });
    assert.deepEqual(await cli("budget", "save", "--id", saved.id, "--name", "Final name"), { code: 0, stdout: `${saved.id}\tFinal name`, stderr: "" });
    const textCreate = await cli("budget", "save", "--name", "Work");
    assert.equal(textCreate.code, 0);
    assert.equal(textCreate.stderr, "");
    const [createdId, createdName] = textCreate.stdout.split("\t");
    assert.ok(createdId);
    assert.equal(createdName, "Work");
    assert.equal(JSON.parse((await cli("budget", "open", createdId, "--json")).stdout).name, "Work");
    for (const [args, expectedCode] of [
      [["budget", "open", "missing"], "not_found"],
      [["budget", "save", "--name", " "], "invalid_input"],
      [["budget", "save"], "usage"],
      [["status", "extra"], "usage"],
      [["--unknown"], "cli_error"],
    ] as const) {
      const result = await cli(...args, "--json");
      assert.notEqual(result.code, 0);
      assert.equal(JSON.parse(result.stdout).error.code, expectedCode);
      assert.ok(JSON.parse(result.stdout).error.message);
    }
    const missing = await cli("budget", "open", "missing");
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /Budget not found/);
    const unreachable = await cli("status", "--url", "http://127.0.0.1:1", "--json");
    assert.notEqual(unreachable.code, 0);
    assert.equal(JSON.parse(unreachable.stdout).error.code, "unreachable");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});
