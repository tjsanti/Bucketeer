import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApi } from "../src/api.js";
import { createClient } from "../src/client.js";
import { openBucketeer } from "../src/core/index.js";

test("HTTP previews, applies and undoes a rain, and serves each bucket's need", async () => {
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T12:00:00.000Z"), timeZone: "UTC" });
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const client = createClient(url);
  try {
    const budget = core.createBudget({ name: "Household" });
    const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 40_000, startingDate: "2026-11-01" });
    const fuel = core.createBucket(budget.id, { name: "Fuel", newGroupName: "Fixed", type: "recurring", amount: 16_000 });
    const vacation = core.createBucket(budget.id, { name: "Vacation", groupId: fuel.groupId!, type: "goal", amount: 300_000, goalMonth: "2027-08" });

    assert.deepEqual((await client.bucketMonth(budget.id, "2026-11")).buckets.map((bucket) => bucket.need), [16_000, 30_000]);
    const expected = { fills: [{ bucketId: fuel.id, amount: 16_000 }, { bucketId: vacation.id, amount: 24_000 }], total: 40_000 };
    assert.deepEqual(await client.planRain(budget.id, "2026-11"), expected);
    assert.equal(core.readyToAssign(budget.id), 40_000);

    const response = await fetch(`${url}/api/budgets/${budget.id}/months/2026-11/rain`, { method: "POST" });
    assert.equal(response.status, 201);
    const rain = await response.json();
    assert.deepEqual({ fills: rain.fills, total: rain.total }, expected);
    assert.equal(core.readyToAssign(budget.id), 0);
    assert.deepEqual(await client.rain(budget.id, "2026-11"), { fills: [], total: 0 });

    core.addTransaction(checking.id, { date: "2026-11-15", amount: -1, category: { kind: "bucket", bucketId: fuel.id } });
    await assert.rejects(client.undoRain(rain.rainId), { code: "money_moved" });
    const refused = await fetch(`${url}/api/rains/${rain.rainId}/undo`, { method: "POST" });
    assert.equal(refused.status, 409);
    core.addTransaction(checking.id, { date: "2026-11-15", amount: 1, category: { kind: "bucket", bucketId: fuel.id } });
    assert.equal(await client.undoRain(rain.rainId), undefined);
    assert.equal(core.readyToAssign(budget.id), 40_000);

    // A rain sent with the plan it previewed is refused, 409, if the plan has changed since.
    const stale = await client.planRain(budget.id, "2026-11");
    core.assign(fuel.id, { month: "2026-11", amount: 1_000 });
    const changed = await fetch(`${url}/api/budgets/${budget.id}/months/2026-11/rain`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expect: stale }),
    });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).error.code, "rain_changed");
    const fresh = await client.planRain(budget.id, "2026-11");
    assert.deepEqual((await client.rain(budget.id, "2026-11", fresh)).total, fresh.total);

    await assert.rejects(client.rain(budget.id, "2026-10"), { code: "invalid_input" });
    await assert.rejects(client.planRain(budget.id, "2026-10"), { code: "invalid_input" });
    await assert.rejects(client.undoRain("missing"), { code: "not_found" });
  } finally {
    server.close();
    core.close();
  }
});
