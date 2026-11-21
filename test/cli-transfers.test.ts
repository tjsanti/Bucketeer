import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { createApi } from "../src/api.js";
import { openBucketeer } from "../src/core/index.js";

test("CLI tx add --transfer moves money between accounts and prints Transfer → the other account", async () => {
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
    const visa = core.createAccount(budget.id, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });

    const added = await cli("tx", "add", "--account", checking.id, "--amount", "-412.09", "--transfer", visa.id, "--date", "2026-11-18", "--payee", "Visa payment");
    assert.equal(added.code, 0, added.stderr);
    const [id, ...rest] = added.stdout.split("\t");
    assert.deepEqual(rest, ["2026-11-18", "Visa payment", "Transfer → Visa", "−412.09", "587.91"]);
    assert.equal(core.openAccount(visa.id).balance, 0);
    assert.equal(core.readyToAssign(budget.id), 58_791);

    const otherSide = core.listTransactions(visa.id).transactions[0]!;
    assert.deepEqual(await cli("tx", "list", "--account", visa.id), { code: 0, stderr: "", stdout: `${otherSide.id}\t2026-11-18\t\tTransfer → Checking\t412.09\t0.00` });

    const json = JSON.parse((await cli("tx", "edit", otherSide.id, "--amount", "400", "--json")).stdout);
    assert.equal(json.amount, 40_000);
    assert.equal(core.openTransaction(id!).amount, -40_000);

    const twice = await cli("tx", "add", "--account", checking.id, "--amount", "-1", "--transfer", visa.id, "--income", "--json");
    assert.equal(JSON.parse(twice.stdout).error.code, "usage");
    const self = await cli("tx", "add", "--account", checking.id, "--amount", "-1", "--transfer", checking.id, "--json");
    assert.equal(JSON.parse(self.stdout).error.code, "invalid_input");

    assert.equal((await cli("tx", "delete", otherSide.id)).code, 0);
    assert.deepEqual([core.listTransactions(checking.id).transactions.length, core.openAccount(visa.id).balance], [0, -41_209]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});
