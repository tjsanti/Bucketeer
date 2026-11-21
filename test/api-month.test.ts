import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApi } from "../src/api.js";
import { createClient } from "../src/client.js";
import { openBucketeer } from "../src/core/index.js";

test("HTTP exposes the month range with today, account months and month-end balances", async () => {
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
    const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" });
    const october = core.addTransaction(checking.id, { date: "2026-10-15", amount: 20_000, category: { kind: "income" } });
    core.addTransaction(checking.id, { date: "2026-11-02", amount: 5_000, category: { kind: "income" } });

    // With the range comes the server's today, which new transactions default to (ADR-0007).
    assert.deepEqual(await client.monthRange(budget.id), { first: "2025-11", current: "2026-11", last: "2027-11", today: "2026-11-20" });
    assert.deepEqual(await client.accountMonth(checking.id, "2026-10"), { balance: 120_000, transactions: [{ ...october, runningBalance: 120_000 }] });
    assert.deepEqual(await client.accountBalances(budget.id, "2026-10"), { [checking.id]: 120_000 });

    await assert.rejects(client.monthRange("missing"), { code: "not_found" });
    await assert.rejects(client.accountMonth(checking.id, "2030-01"), { code: "invalid_input", field: "month" });
    await assert.rejects(client.accountMonth("missing", "2026-11"), { code: "not_found" });
    await assert.rejects(client.accountBalances(budget.id, "nope"), { code: "invalid_input" });
    const missingMonth = await fetch(`${url}/api/budgets/${budget.id}/account-balances`);
    assert.equal(missingMonth.status, 400);
    assert.equal((await missingMonth.json()).error.code, "invalid_input");
  } finally {
    server.close();
    core.close();
  }
});

test("HTTP serves a month of buckets and assigns into a month", async () => {
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T12:00:00.000Z"), timeZone: "UTC" });
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = createClient(`http://127.0.0.1:${address.port}`);
  try {
    const budget = core.createBudget({ name: "Household" });
    core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 200_000, startingDate: "2026-11-01" });
    const rent = core.createBucket(budget.id, { name: "Rent", newGroupName: "Fixed", type: "recurring", amount: 165_000 });

    const assigned = await client.assign(rent.id, { month: "2026-12", amount: 165_000 });
    assert.deepEqual(assigned, core.bucketMonth(budget.id, "2026-12").buckets[0]);
    assert.deepEqual([assigned.month, assigned.assigned, assigned.available], ["2026-12", 165_000, 165_000]);
    assert.deepEqual(await client.bucketMonth(budget.id, "2026-12"), core.bucketMonth(budget.id, "2026-12"));
    assert.equal((await client.bucketMonth(budget.id, "2026-11")).summary.readyToAssign, 35_000);

    await assert.rejects(client.assign(rent.id, { month: "2026-12", amount: 35_001 }), { code: "not_enough_ready", message: "Only $350.00 is ready to assign. You can add up to that.", field: "amount" });
    await assert.rejects(client.assign(rent.id, { month: "2026-11", amount: -1 }), { code: "not_enough_available" });
    await assert.rejects(client.assign(rent.id, { month: "2030-01", amount: 1 }), { code: "invalid_input", field: "month" });
    await assert.rejects(client.assign("missing", { month: "2026-11", amount: 1 }), { code: "not_found" });
    await assert.rejects(client.bucketMonth(budget.id, "2030-01"), { code: "invalid_input" });
    const status = await fetch(`http://127.0.0.1:${address.port}/api/buckets/${rent.id}/assign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ month: "2026-11", amount: 999_999_999 }) });
    assert.equal(status.status, 409);
  } finally {
    server.close();
    core.close();
  }
});
