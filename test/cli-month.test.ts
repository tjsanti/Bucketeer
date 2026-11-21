import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { createApi } from "../src/api.js";
import { openBucketeer } from "../src/core/index.js";

test("CLI tx list --month shows only that month and ends with the end-of-month balance", async () => {
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
    const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" });
    const october = core.addTransaction(checking.id, { date: "2026-10-15", payee: "Acme", amount: 20_000, category: { kind: "income" } });
    core.addTransaction(checking.id, { date: "2026-11-02", payee: "Refund", amount: 5_000, category: { kind: "income" } });
    const a = ["tx", "list", "--account", checking.id];

    assert.deepEqual(await cli(...a, "--month", "2026-10"), {
      code: 0, stderr: "", stdout: `${october.id}\t2026-10-15\tAcme\tIncome\t200.00\t1,200.00\nBalance at end of 2026-10\t1,200.00`,
    });
    assert.deepEqual(await cli(...a, "--month", "2026-09"), { code: 0, stderr: "", stdout: "No transactions.\nBalance at end of 2026-09\t1,000.00" });
    const json = await cli(...a, "--month", "2026-10", "--json");
    assert.deepEqual(JSON.parse(json.stdout), { balance: 120_000, transactions: [{ ...october, runningBalance: 120_000 }] });

    const tooLate = await cli(...a, "--month", "2028-01", "--json");
    assert.notEqual(tooLate.code, 0);
    assert.equal(JSON.parse(tooLate.stdout).error.code, "invalid_input");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});

test("CLI assign moves money into a bucket's month and month prints the Buckets page", async () => {
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
    const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 200_000, startingDate: "2026-11-01" });
    const rent = core.createBucket(budget.id, { name: "Rent", newGroupName: "Fixed", type: "recurring", amount: 165_000 });
    const gifts = core.createBucket(budget.id, { name: "Gifts", groupId: rent.groupId!, type: "goal", amount: 50_000, goalMonth: "2026-12" });
    core.addTransaction(checking.id, { date: "2026-11-03", amount: -2_500, category: { kind: "bucket", bucketId: gifts.id } });

    // --month defaults to the server's current month.
    assert.deepEqual(await cli("assign", rent.id, "--amount", "1,650"), { code: 0, stderr: "", stdout: "Fixed\tRent\t1,650.00/month\t1,650.00\t0.00\t1,650.00" });
    assert.equal(core.readyToAssign(budget.id), 35_000);
    const taken = JSON.parse((await cli("assign", rent.id, "--amount", "-50", "--month", "2026-11", "--json")).stdout);
    assert.equal(taken.assigned, 160_000);
    assert.deepEqual(taken, core.bucketMonth(budget.id, "2026-11").buckets[0]);
    const future = JSON.parse((await cli("assign", gifts.id, "--amount", "100", "--month", "2026-12", "--json")).stdout);
    assert.deepEqual([future.month, future.carriedIn, future.assigned, future.available], ["2026-12", -2_500, 10_000, 7_500]);

    assert.deepEqual(await cli("month", "--budget", budget.id), {
      code: 0, stderr: "",
      stdout: "2026-11\tReady to assign\t300.00\nFixed\tRent\t1,650.00/month\t1,600.00\t0.00\t1,600.00\nFixed\tGifts\t500.00 by 2026-12\t0.00\t25.00\t−25.00",
    });
    assert.deepEqual(JSON.parse((await cli("month", "--budget", budget.id, "--month", "2026-12", "--json")).stdout), core.bucketMonth(budget.id, "2026-12"));

    const refused = await cli("assign", rent.id, "--amount", "301", "--json");
    assert.notEqual(refused.code, 0);
    assert.deepEqual(JSON.parse(refused.stdout).error, { code: "not_enough_ready", message: "Only $300.00 is ready to assign." });
    const tooMuch = await cli("assign", gifts.id, "--amount", "-1");
    assert.deepEqual([tooMuch.code, tooMuch.stderr], [1, "Gifts has nothing available to take."]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});
