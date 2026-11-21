import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { createApi } from "../src/api.js";
import { openBucketeer } from "../src/core/index.js";

test("CLI tx add and edit take repeated --line <bucketId>:<amount> and show the category as Split (n)", async () => {
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
  const errorCode = async (...args: string[]) => {
    const result = await cli(...args, "--json");
    assert.notEqual(result.code, 0, args.join(" "));
    return JSON.parse(result.stdout).error.code;
  };
  try {
    const budget = core.createBudget({ name: "Household" });
    const visa = core.createAccount(budget.id, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });
    const group = core.createGroup(budget.id, { name: "Everyday" });
    const a = core.createBucket(budget.id, { name: "Groceries", groupId: group.id, type: "plain" });
    const b = core.createBucket(budget.id, { name: "Household", groupId: group.id, type: "plain" });
    const add = ["tx", "add", "--account", visa.id, "--amount", "-80", "--date", "2026-11-19", "--payee", "Superstore"];

    const text = await cli(...add, "--line", `${a.id}:-50`, "--line", `${b.id}:-30.00`);
    assert.equal(text.code, 0, text.stdout);
    const [id, ...rest] = text.stdout.split("\t");
    assert.deepEqual(rest, ["2026-11-19", "Superstore", "Split (2)", "−80.00", "−492.09"]);
    assert.deepEqual([core.openBucket(a.id).available, core.openBucket(b.id).available], [-5_000, -3_000]);
    assert.deepEqual(core.openTransaction(id!).category, {
      kind: "split", lines: [{ bucketId: a.id, amount: -5_000, memo: "" }, { bucketId: b.id, amount: -3_000, memo: "" }],
    });

    assert.equal(await errorCode(...add, "--line", `${a.id}:-50`, "--line", `${b.id}:-20`), "invalid_input");
    assert.equal(await errorCode(...add, "--line", `${a.id}:-100`, "--line", `${b.id}:20`), "invalid_input");
    assert.equal(await errorCode(...add, "--line", `${a.id}:-80`), "invalid_input");
    assert.equal(await errorCode(...add, "--line", `${a.id}`, "--line", `${b.id}:-30`), "invalid_input");
    assert.equal(await errorCode(...add, "--line", `${a.id}:-50`, "--line", `${b.id}:-30`, "--bucket", a.id), "usage");

    const edited = JSON.parse((await cli("tx", "edit", id!, "--amount", "-90", "--line", `${a.id}:-10`, "--line", `${b.id}:-80`, "--json")).stdout);
    assert.deepEqual(edited.category.lines.map((line: { amount: number }) => line.amount), [-1_000, -8_000]);
    assert.deepEqual([core.openBucket(a.id).available, core.openBucket(b.id).available], [-1_000, -8_000]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});
