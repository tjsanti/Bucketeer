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

test("CLI group and bucket commands handle dollars, positions, text output, and errors", async () => {
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
  // A goal month comfortably in the future, whatever today is.
  const future = `${new Date().getFullYear() + 2}-08`;
  try {
    const budget = core.createBudget({ name: "Household" });
    const b = ["--budget", budget.id];
    assert.deepEqual(await json("bucket", "list", ...b), { groups: [], buckets: [] });
    assert.deepEqual(await cli("bucket", "list", ...b), { code: 0, stdout: "No buckets.", stderr: "" });
    assert.deepEqual(await json("group", "list", ...b), []);
    assert.deepEqual(await cli("group", "list", ...b), { code: 0, stdout: "No groups.", stderr: "" });

    const fixed = await json("group", "add", ...b, "--name", "Fixed");
    assert.deepEqual([fixed.name, fixed.order, fixed.budgetId], ["Fixed", 1, budget.id]);
    const everydayText = await cli("group", "add", ...b, "--name", "Everyday");
    const [everydayId, everydayName] = everydayText.stdout.split("\t");
    assert.equal(everydayName, "Everyday");

    const rent = await json("bucket", "add", ...b, "--name", "Rent", "--group", fixed.id, "--type", "recurring", "--amount", "1,650");
    assert.deepEqual([rent.amount, rent.colour, rent.available, rent.goalMonth], [165_000, "sky", 0, null]);
    const vacation = await json("bucket", "add", ...b, "--name", "Vacation", "--new-group", "Goals", "--type", "goal", "--amount", "3000", "--by", future);
    assert.deepEqual([vacation.amount, vacation.goalMonth], [300_000, future]);
    const clothingText = await cli("bucket", "add", ...b, "--name", "Clothing", "--group", everydayId!);
    assert.match(clothingText.stdout, /^[^\t]+\tEveryday\tClothing\tplain\t\t0\.00$/);
    const clothingId = clothingText.stdout.split("\t")[0]!;
    const groups = await json("group", "list", ...b);
    assert.deepEqual(groups.map((group: { name: string }) => group.name), ["Fixed", "Everyday", "Goals"]);
    const goals = groups[2];
    assert.equal(vacation.groupId, goals.id);
    assert.deepEqual((await cli("group", "list", ...b)).stdout.split("\n"), groups.map((group: { id: string; name: string }) => `${group.id}\t${group.name}`));

    assert.deepEqual((await cli("bucket", "list", ...b)).stdout.split("\n"), [
      `${rent.id}\tFixed\tRent\trecurring\t1,650.00/month\t0.00`,
      `${clothingId}\tEveryday\tClothing\tplain\t\t0.00`,
      `${vacation.id}\tGoals\tVacation\tgoal\t3,000.00 by ${future}\t0.00`,
    ]);
    // BUCKETEER_BUDGET stands in for --budget.
    assert.equal(JSON.parse((await run({ BUCKETEER_BUDGET: budget.id }, "bucket", "list", "--json")).stdout).buckets.length, 3);

    // Edit: amount alone keeps the type; switching to plain clears the amount.
    assert.equal((await json("bucket", "edit", rent.id, "--amount", "1700")).amount, 170_000);
    const plainRent = await json("bucket", "edit", rent.id, "--type", "plain");
    assert.deepEqual([plainRent.type, plainRent.amount], ["plain", null]);
    assert.equal((await cli("bucket", "edit", rent.id, "--name", "Housing", "--colour", "plum")).stdout, `${rent.id}\tFixed\tHousing\tplain\t\t0.00`);
    assert.equal((await json("bucket", "edit", rent.id, "--new-group", "Home")).order, 1);
    assert.equal((await json("bucket", "edit", rent.id, "--group", fixed.id)).groupId, fixed.id);

    // Positions are 1-based; --group defaults to the bucket's own group.
    const moved = await json("bucket", "move", clothingId, "--group", fixed.id, "--position", "1");
    assert.deepEqual([moved.groupId, moved.order], [fixed.id, 1]);
    assert.equal((await json("bucket", "move", clothingId, "--position", "9")).order, 2);
    assert.equal((await cli("bucket", "move", clothingId, "--position", "1")).stdout, `${clothingId}\tFixed\tClothing\tplain\t\t0.00`);
    assert.equal((await json("group", "move", goals.id, "--position", "1")).order, 1);
    assert.equal((await cli("group", "rename", goals.id, "--name", "Saving")).stdout, `${goals.id}\tSaving`);

    const archived = await json("bucket", "archive", clothingId);
    assert.deepEqual([archived.bucket.archived, archived.returned], [true, 0]);
    assert.equal((await cli("bucket", "archive", clothingId)).stdout, `${clothingId}\tFixed\tClothing\tplain\t\t0.00\tarchived`);
    assert.equal((await json("bucket", "list", ...b)).buckets.length, 2);
    const withArchived = await json("bucket", "list", ...b, "--archived");
    assert.equal(withArchived.buckets.at(-1).id, clothingId);
    assert.equal((await cli("bucket", "list", ...b, "--archived")).stdout.split("\n").at(-1), `${clothingId}\tFixed\tClothing\tplain\t\t0.00\tarchived`);
    await failure("name_taken", "bucket", "add", ...b, "--name", "clothing", "--group", fixed.id);
    const restored = await json("bucket", "restore", clothingId);
    assert.deepEqual([restored.archived, restored.groupId, restored.order], [false, fixed.id, 2]);

    await failure("group_not_empty", "group", "delete", fixed.id);
    assert.deepEqual(await json("group", "delete", everydayId!), { id: everydayId, deleted: true });
    const spare = await json("group", "add", ...b, "--name", "Spare");
    assert.equal((await cli("group", "delete", spare.id)).stdout, `Deleted group ${spare.id}.`);

    await failure("invalid_input", "bucket", "edit", vacation.id, "--by", "2020-01");
    await failure("invalid_input", "bucket", "add", ...b, "--name", "Car", "--group", fixed.id, "--type", "goal", "--amount", "100");
    await failure("invalid_input", "bucket", "add", ...b, "--name", "Car", "--group", fixed.id, "--colour", "pink");
    await failure("invalid_input", "bucket", "add", ...b, "--name", "Car", "--group", fixed.id, "--type", "recurring");
    await failure("invalid_input", "bucket", "add", ...b, "--name", "Car", "--group", fixed.id, "--type", "recurring", "--amount", "-5");
    await failure("invalid_input", "bucket", "add", ...b, "--name", "Car", "--group", fixed.id, "--type", "recurring", "--amount", "1.234");
    await failure("invalid_input", "bucket", "add", ...b, "--name", "Car", "--group", fixed.id, "--type", "weekly");
    await failure("invalid_input", "bucket", "move", clothingId, "--position", "0");
    await failure("invalid_input", "bucket", "move", clothingId, "--position", "-1");
    await failure("invalid_input", "group", "move", fixed.id, "--position", "first");
    await failure("name_taken", "group", "add", ...b, "--name", "fixed");
    await failure("not_found", "bucket", "archive", "missing");
    await failure("not_found", "bucket", "restore", "missing");
    await failure("not_found", "bucket", "edit", "missing", "--name", "X");
    await failure("not_found", "bucket", "move", "missing", "--position", "1");
    await failure("not_found", "bucket", "add", ...b, "--name", "Car", "--group", "missing");
    await failure("not_found", "group", "delete", "missing");
    await failure("not_found", "group", "rename", "missing", "--name", "X");
    await failure("not_found", "bucket", "list", "--budget", "missing");
    // Usage errors: --amount or --by without a type on add, group choice, missing positions.
    await failure("usage", "bucket", "add", ...b, "--name", "Car", "--group", fixed.id, "--amount", "100");
    await failure("usage", "bucket", "add", ...b, "--name", "Car", "--group", fixed.id, "--by", future);
    await failure("usage", "bucket", "add", ...b, "--name", "Car");
    await failure("usage", "bucket", "add", ...b, "--name", "Car", "--group", fixed.id, "--new-group", "X");
    await failure("usage", "bucket", "add", "--name", "Car", "--group", fixed.id);
    await failure("usage", "bucket", "edit", rent.id, "--group", fixed.id, "--new-group", "X");
    await failure("usage", "bucket", "move", clothingId);
    await failure("usage", "group", "move", fixed.id);
    await failure("usage", "group", "add", ...b);
    await failure("usage", "group", "rename", fixed.id);
    await failure("usage", "group", "list");
    await failure("usage", "bucket", "list", ...b, "--name", "X");
    await failure("usage", "account", "list", ...b, "--archived");
    const text = await cli("group", "delete", fixed.id);
    assert.equal(text.stdout, "");
    assert.match(text.stderr, /Move or archive/);
    const helpText = (await cli("--help")).stdout;
    for (const fragment of ["group list", "group delete", "bucket add", "bucket move", "bucket archive", "bucket restore", "--colour"]) assert.ok(helpText.includes(fragment), fragment);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});
