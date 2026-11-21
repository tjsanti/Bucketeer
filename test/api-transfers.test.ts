import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApi } from "../src/api.js";
import { createClient } from "../src/client.js";
import { openBucketeer } from "../src/core/index.js";

test("HTTP takes transfers and lists the budget's recent activity, honouring its limit", async () => {
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
    const visa = core.createAccount(budget.id, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });
    const payment = await client.addTransaction(checking.id, { date: "2026-11-12", amount: -41_209, category: { kind: "transfer", accountId: visa.id } });
    assert.equal((await client.openAccount(visa.id)).balance, 0);
    for (let day = 13; day <= 15; day++) await client.addTransaction(checking.id, { date: `2026-11-${day}`, amount: 100, category: { kind: "income" } });

    const all = await client.recentTransactions(budget.id, 10);
    assert.equal(all.length, 4);
    assert.deepEqual(all.at(-1), payment);
    assert.deepEqual((await client.recentTransactions(budget.id, 2)).map((row) => row.date), ["2026-11-15", "2026-11-14"]);
    // Without a limit, the ten newest.
    const plain = await fetch(`${url}/api/budgets/${budget.id}/transactions`);
    assert.equal((await plain.json()).length, 4);

    await assert.rejects(client.recentTransactions(budget.id, 0), { code: "invalid_input" });
    const bad = await fetch(`${url}/api/budgets/${budget.id}/transactions?limit=lots`);
    assert.equal(bad.status, 400);
    await assert.rejects(client.recentTransactions("missing", 5), { code: "not_found" });
    await assert.rejects(client.addTransaction(checking.id, { amount: -100, category: { kind: "transfer", accountId: checking.id } }), { code: "invalid_input" });
    await client.deleteTransaction(payment.id);
    assert.equal((await client.openAccount(visa.id)).balance, -41_209);
  } finally {
    server.close();
    core.close();
  }
});
