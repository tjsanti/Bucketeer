import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { createApi } from "../src/api.js";
import { openBucketeer } from "../src/core/index.js";

test("CLI rain previews with --dry-run, applies, and rain undo reverses it", async () => {
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T12:00:00.000Z"), timeZone: "UTC" });
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveResult) => {
      execFile(process.execPath, [resolve("dist/cli.js"), ...args], { env: { ...process.env, BUCKETEER_URL: url, BUCKETEER_BUDGET: "" } }, (error, stdout, stderr) => {
        resolveResult({ code: error ? Number(error.code) || 1 : 0, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }
  try {
    const budget = core.createBudget({ name: "Household" });
    core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 170_000, startingDate: "2026-11-01" });
    const fuel = core.createBucket(budget.id, { name: "Fuel", newGroupName: "Fixed", type: "recurring", amount: 16_000 });
    const vacation = core.createBucket(budget.id, { name: "Vacation", groupId: fuel.groupId!, type: "goal", amount: 300_000, goalMonth: "2027-08" });
    const fills = [{ bucketId: fuel.id, amount: 16_000 }, { bucketId: vacation.id, amount: 30_000 }];

    assert.deepEqual(await cli("rain", "--budget", budget.id, "--dry-run"), { code: 0, stderr: "", stdout: "Fuel\t160.00\nVacation\t300.00\nTotal\t460.00" });
    const preview = await cli("rain", "--budget", budget.id, "--month", "2026-11", "--dry-run", "--json");
    assert.deepEqual(JSON.parse(preview.stdout), { fills, total: 46_000 });
    assert.equal(core.readyToAssign(budget.id), 170_000);

    const applied = await cli("rain", "--budget", budget.id, "--json");
    const rain = JSON.parse(applied.stdout);
    assert.deepEqual(rain, { rainId: rain.rainId, fills, total: 46_000 });
    assert.equal(core.readyToAssign(budget.id), 124_000);
    assert.deepEqual(await cli("rain", "--budget", budget.id), { code: 0, stderr: "", stdout: "Nothing to fill.\nTotal\t0.00" });

    assert.deepEqual(await cli("rain", "undo", rain.rainId), { code: 0, stderr: "", stdout: `Undid rain ${rain.rainId}.` });
    assert.equal(core.readyToAssign(budget.id), 170_000);
    const again = await cli("rain", "--budget", budget.id);
    assert.match(again.stdout, /^Fuel\t160\.00\nVacation\t300\.00\nTotal\t460\.00\nRain [0-9a-f-]{36}$/);

    const past = await cli("rain", "--budget", budget.id, "--month", "2026-10", "--json");
    assert.notEqual(past.code, 0);
    assert.equal(JSON.parse(past.stdout).error.code, "invalid_input");
    const missing = await cli("rain", "undo", "missing", "--json");
    assert.equal(JSON.parse(missing.stdout).error.code, "not_found");
    assert.notEqual((await cli("rain", "undo", rain.rainId, "--dry-run")).code, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});
