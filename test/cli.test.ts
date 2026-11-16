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

test("CLI account commands handle dollars, signed amounts, budget selection, and errors", async () => {
  const core = openBucketeer(":memory:");
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  function run(env: Record<string, string>, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveResult) => {
      execFile(process.execPath, [resolve("dist/cli.js"), ...args], { env: { ...process.env, BUCKETEER_URL: url, BUCKETEER_BUDGET: "", ...env } }, (error, stdout, stderr) => {
        resolveResult({ code: error ? Number(error.code) || 1 : 0, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }
  const cli = (...args: string[]) => run({}, ...args);
  const json = async (...args: string[]) => {
    const result = await cli(...args, "--json");
    assert.equal(result.code, 0, result.stdout || result.stderr);
    return JSON.parse(result.stdout);
  };
  const failure = async (expected: string, ...args: string[]) => {
    const result = await cli(...args, "--json");
    assert.notEqual(result.code, 0, args.join(" "));
    assert.equal(JSON.parse(result.stdout).error.code, expected, args.join(" "));
    assert.ok(JSON.parse(result.stdout).error.message);
  };
  const localToday = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  })();
  try {
    const budget = core.createBudget({ name: "Household" });
    const other = core.createBudget({ name: "Other" });
    const b = ["--budget", budget.id];
    assert.deepEqual(await json("account", "list", ...b), []);
    assert.deepEqual(await cli("account", "list", ...b), { code: 0, stdout: "No accounts.", stderr: "" });

    const main = await json("account", "add", ...b, "--name", "Checking", "--type", "checking", "--starting-balance", "1,000.00", "--date", "2026-11-01");
    assert.equal(main.startingBalance, 100_000);
    assert.equal(main.balance, 100_000);
    assert.equal(main.startingDate, "2026-11-01");
    assert.equal(main.budgetId, budget.id);
    // Negative amounts work both separated and joined, with ASCII or U+2212 minus.
    const visa = await json("account", "add", ...b, "--name", "Visa", "--type", "credit-card", "--starting-balance", "-412.09");
    assert.equal(visa.startingBalance, -41_209);
    assert.equal(visa.startingDate, localToday);
    const amex = await json("account", "add", ...b, "--name", "Amex", "--type", "credit-card", "--starting-balance=-$5");
    assert.equal(amex.startingBalance, -500);
    const unicode = await json("account", "add", ...b, "--name", "Store card", "--type", "credit-card", "--starting-balance", "\u2212$1,234.50");
    assert.equal(unicode.startingBalance, -123_450);
    const wallet = await json("account", "add", ...b, "--name", "Wallet", "--type", "cash");
    assert.equal(wallet.startingBalance, 0);
    assert.deepEqual((await json("account", "list", ...b)).map((account: { name: string }) => account.name), ["Checking", "Visa", "Amex", "Store card", "Wallet"]);
    assert.deepEqual(await json("account", "list", "--budget", other.id), []);

    // Text output: id, name, type, balance (U+2212, grouped), and "closed" when closed.
    const list = (await cli("account", "list", ...b)).stdout.split("\n");
    assert.equal(list[0], `${main.id}\tChecking\tchecking\t1,000.00`);
    assert.equal(list[1], `${visa.id}\tVisa\tcredit-card\t\u2212412.09`);
    assert.equal(list[3], `${unicode.id}\tStore card\tcredit-card\t\u22121,234.50`);
    const textAdd = await cli("account", "add", ...b, "--name", "Jar", "--type", "cash", "--starting-balance", "12.5");
    assert.match(textAdd.stdout, /^[^\t]+\tJar\tcash\t12\.50$/);

    // BUCKETEER_BUDGET stands in for --budget on list and add; --budget wins.
    const viaEnv = await run({ BUCKETEER_BUDGET: other.id }, "account", "add", "--name", "Checking", "--type", "savings", "--json");
    assert.equal(JSON.parse(viaEnv.stdout).budgetId, other.id);
    assert.equal(JSON.parse((await run({ BUCKETEER_BUDGET: other.id }, "account", "list", "--json")).stdout).length, 1);
    assert.equal(JSON.parse((await run({ BUCKETEER_BUDGET: other.id }, "account", "list", ...b, "--json")).stdout).length, 6);

    const edited = await json("account", "edit", main.id, "--name", "Main checking", "--starting-balance", "-5.25", "--date", "2026-10-31");
    assert.deepEqual({ ...edited, name: main.name, startingBalance: main.startingBalance, balance: main.balance, startingDate: main.startingDate, updatedAt: main.updatedAt }, main);
    assert.deepEqual([edited.name, edited.startingBalance, edited.startingDate], ["Main checking", -525, "2026-10-31"]);
    assert.equal((await json("account", "edit", main.id, "--starting-balance=1000")).balance, 100_000);
    assert.equal((await cli("account", "edit", main.id, "--name", "Checking")).stdout, `${main.id}\tChecking\tchecking\t1,000.00`);

    const closed = await json("account", "close", wallet.id);
    assert.equal(closed.closed, true);
    assert.equal((await cli("account", "list", ...b)).stdout.split("\n").at(-2), `${wallet.id}\tWallet\tcash\t0.00\tclosed`);
    assert.equal((await json("account", "reopen", wallet.id)).closed, false);
    assert.equal((await cli("account", "close", wallet.id)).stdout, `${wallet.id}\tWallet\tcash\t0.00\tclosed`);

    await failure("balance_not_zero", "account", "close", visa.id);
    await failure("name_taken", "account", "add", ...b, "--name", "visa", "--type", "cash");
    await failure("invalid_input", "account", "add", ...b, "--name", "X", "--type", "brokerage");
    await failure("invalid_input", "account", "add", ...b, "--name", "X", "--type", "cash", "--date", "2026-02-30");
    await failure("invalid_input", "account", "add", ...b, "--name", "X", "--type", "cash", "--starting-balance", "1.234");
    await failure("invalid_input", "account", "add", ...b, "--name", "X", "--type", "cash", "--starting-balance", "ten");
    await failure("invalid_input", "account", "add", ...b, "--name", "X", "--type", "cash", "--starting-balance", "100000000000");
    await failure("invalid_input", "account", "edit", visa.id, "--starting-balance", "1,2");
    await failure("invalid_input", "account", "edit", visa.id);
    await failure("not_found", "account", "close", "missing");
    await failure("not_found", "account", "reopen", "missing");
    await failure("not_found", "account", "edit", "missing", "--name", "X");
    await failure("not_found", "account", "list", "--budget", "missing");
    await failure("not_found", "account", "add", "--budget", "missing", "--name", "X", "--type", "cash");
    // Usage errors: missing budget, missing required options, unexpected positionals or options.
    await failure("usage", "account", "list");
    await failure("usage", "account", "add", ...b, "--name", "X");
    await failure("usage", "account", "add", ...b, "--type", "cash");
    await failure("usage", "account", "add", "--name", "X", "--type", "cash");
    await failure("usage", "account", "edit", "--name", "X");
    await failure("usage", "account", "edit", visa.id, "--type", "cash");
    await failure("usage", "account", "close");
    await failure("usage", "account", "close", visa.id, "extra");
    await failure("usage", "account", "list", ...b, "--name", "X");
    await failure("usage", "account", "bogus");
    await failure("usage", "budget", "list", "--budget", budget.id);
    const text = await cli("account", "close", visa.id);
    assert.equal(text.stdout, "");
    assert.equal(text.stderr, "Balance must be 0.00.");
    const helpText = (await cli("--help")).stdout;
    for (const fragment of ["account list", "account add", "account edit", "account close", "account reopen", "BUCKETEER_BUDGET"]) assert.ok(helpText.includes(fragment), fragment);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});
