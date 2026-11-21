import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { test } from "node:test";
import { createApi } from "../src/api.js";
import { createClient } from "../src/client.js";
import { openBucketeer } from "../src/core/index.js";

test("HTTP exposes the core and returns useful errors for invalid requests", async () => {
  const core = openBucketeer(":memory:");
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const client = createClient(url);
  let closed = false;
  try {
    assert.deepEqual(await client.status(), { status: "ok" });
    assert.deepEqual(await client.listBudgets(), []);
    const saved = await client.createBudget({ name: "Household" });
    assert.deepEqual(await client.openBudget(saved.id), saved);
    const updated = await client.renameBudget(saved.id, { name: "Renamed" });
    assert.equal(updated.name, "Renamed");
    assert.deepEqual(await client.listBudgets(), [updated]);
    await assert.rejects(client.createBudget({ name: " " }), { code: "invalid_input" });
    await assert.rejects(client.openBudget("missing"), { code: "not_found" });
    await assert.rejects(client.renameBudget("missing", { name: "New" }), { code: "not_found" });

    for (const [body, contentType, expectedStatus, expectedCode] of [
      ["{", "application/json", 400, "invalid_json"],
      ["{}", "text/plain", 415, "unsupported_media_type"],
      [JSON.stringify({ name: "x".repeat(17_000) }), "application/json", 413, "payload_too_large"],
      [JSON.stringify({ id: saved.id, name: "Hijacked" }), "application/json", 400, "invalid_input"],
    ] as const) {
      const response = await fetch(`${url}/api/budgets`, { method: "POST", headers: { "content-type": contentType }, body });
      assert.equal(response.status, expectedStatus);
      assert.equal((await response.json()).error.code, expectedCode);
    }
    for (const body of ["null", "[]", '"x"', JSON.stringify({ id: "other", name: "Hijacked" })]) {
      const response = await fetch(`${url}/api/budgets/${saved.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body });
      assert.equal(response.status, 400);
      const error = (await response.json()).error;
      assert.equal(error.code, "invalid_input");
      if (body !== JSON.stringify({ id: "other", name: "Hijacked" })) assert.equal(error.message, "A budget name is required.");
    }
    const malformedId = await fetch(`${url}/api/budgets/%ZZ`);
    assert.equal(malformedId.status, 400);
    assert.equal((await malformedId.json()).error.code, "invalid_input");
    assert.deepEqual(await client.openBudget(saved.id), updated);

    // An unavailable SQLite connection must fail health rather than reporting a live process as healthy.
    core.close();
    closed = true;
    const unhealthy = await fetch(`${url}/health`);
    assert.equal(unhealthy.status, 503);
    assert.equal((await unhealthy.json()).error.code, "unhealthy");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!closed) core.close();
  }
});

test("HTTP exposes accounts with status codes for every error and serves the shared money module", async () => {
  const core = openBucketeer(":memory:");
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const client = createClient(url);
  const send = (path: string, method: string, body?: unknown) =>
    fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  try {
    const budget = await client.createBudget({ name: "Household" });
    const other = await client.createBudget({ name: "Other" });
    assert.deepEqual(await client.listAccounts(budget.id), []);
    const input = { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" } as const;
    const created = await send(`/api/budgets/${budget.id}/accounts`, "POST", input);
    assert.equal(created.status, 201);
    const checking = await created.json();
    assert.equal(created.headers.get("location"), `/api/accounts/${checking.id}`);
    assert.equal(checking.balance, 100_000);
    const visa = await client.createAccount(budget.id, { ...input, name: "Visa", type: "credit-card", startingBalance: -41_209 });
    assert.deepEqual(await client.listAccounts(budget.id), [checking, visa]);
    assert.deepEqual(await client.listAccounts(other.id), []);
    assert.deepEqual(await client.openAccount(visa.id), visa);

    const renamed = await client.editAccount(checking.id, { name: "Main checking" });
    assert.equal(renamed.name, "Main checking");
    assert.equal(renamed.createdAt, checking.createdAt);
    assert.equal((await client.editAccount(checking.id, { startingBalance: 0 })).balance, 0);
    const closed = await client.closeAccount(checking.id);
    assert.equal(closed.closed, true);
    assert.deepEqual(await client.reopenAccount(checking.id), { ...closed, closed: false, closedAt: null, updatedAt: (await client.openAccount(checking.id)).updatedAt });

    for (const [attempt, status, errorCode] of [
      [() => client.closeAccount(visa.id), 409, "balance_not_zero"],
      [() => client.createAccount(budget.id, { ...input, name: "VISA" }), 409, "name_taken"],
      [() => client.editAccount(visa.id, { name: "main checking" }), 409, "name_taken"],
      [() => client.createAccount(budget.id, { ...input, type: "bank" as never }), 400, "invalid_input"],
      [() => client.createAccount("missing", input), 404, "not_found"],
      [() => client.listAccounts("missing"), 404, "not_found"],
      [() => client.openAccount("missing"), 404, "not_found"],
      [() => client.editAccount("missing", { name: "X" }), 404, "not_found"],
      [() => client.closeAccount("missing"), 404, "not_found"],
      [() => client.reopenAccount("missing"), 404, "not_found"],
    ] as const) {
      await assert.rejects(attempt(), { code: errorCode }, `${status} ${errorCode}`);
    }
    const statuses = async (path: string, method: string, body?: unknown) => {
      const response = await send(path, method, body);
      return [response.status, (await response.json()).error.code];
    };
    assert.deepEqual(await statuses(`/api/accounts/${visa.id}/close`, "POST"), [409, "balance_not_zero"]);
    assert.deepEqual(await statuses(`/api/budgets/${budget.id}/accounts`, "POST", { ...input, name: "visa" }), [409, "name_taken"]);
    assert.deepEqual(await statuses(`/api/budgets/${budget.id}/accounts`, "POST", { ...input, startingDate: "2026-02-30" }), [400, "invalid_input"]);
    assert.deepEqual(await statuses(`/api/budgets/${budget.id}/accounts`, "POST", { ...input, name: "Hijack", id: visa.id }), [400, "invalid_input"]);
    assert.deepEqual(await statuses(`/api/accounts/${visa.id}`, "PATCH", { type: "cash" }), [400, "invalid_input"]);
    assert.deepEqual(await statuses(`/api/accounts/${visa.id}`, "PATCH", {}), [400, "invalid_input"]);
    assert.deepEqual(await statuses(`/api/accounts/${visa.id}`, "PATCH", null), [400, "invalid_input"]);
    assert.deepEqual(await statuses(`/api/budgets/${budget.id}/accounts`, "POST", "not an object"), [400, "invalid_input"]);
    for (const [path, method] of [
      ["/api/budgets/%ZZ/accounts", "GET"], ["/api/budgets/%ZZ/accounts", "POST"], ["/api/accounts/%ZZ", "GET"],
      ["/api/accounts/%ZZ", "PATCH"], ["/api/accounts/%ZZ/close", "POST"], ["/api/accounts/%ZZ/reopen", "POST"],
    ] as const) {
      assert.deepEqual(await statuses(path, method, method === "GET" ? undefined : {}), [400, "invalid_input"], `${method} ${path}`);
    }
    const malformedJson = await fetch(`${url}/api/accounts/${visa.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(malformedJson.status, 400);
    assert.equal((await malformedJson.json()).error.code, "invalid_json");
    const wrongType = await fetch(`${url}/api/accounts/${visa.id}`, { method: "PATCH", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(wrongType.status, 415);

    // Wrong methods on known routes behave like any unknown route: 404.
    for (const [path, method] of [
      [`/api/accounts/${visa.id}`, "PUT"], [`/api/accounts/${visa.id}`, "DELETE"], [`/api/accounts/${visa.id}/close`, "GET"],
      [`/api/accounts/${visa.id}/reopen`, "PATCH"], [`/api/budgets/${budget.id}/accounts`, "PUT"], [`/api/accounts/${visa.id}/other`, "POST"],
    ] as const) {
      assert.deepEqual(await statuses(path, method), [404, "not_found"], `${method} ${path}`);
    }
    assert.deepEqual(await client.openAccount(visa.id), visa);

    // Static assets: the shared money module (and its types import) and path-routed pages.
    const money = await fetch(`${url}/core/money.js`);
    assert.equal(money.status, 200);
    assert.match(money.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.match(await money.text(), /export function parseMoney/);
    assert.equal((await fetch(`${url}/core/types.js`)).status, 200);
    assert.equal((await fetch(`${url}/core/index.js`)).status, 404);
    assert.equal((await fetch(`${url}/core/database.js`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});

test("the built server serves index.html for path-routed account pages", async () => {
  // Static assets live next to the built server, so run dist/server.js itself.
  const child = spawn(process.execPath, [resolve("dist/server.js")], { env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DATABASE_PATH: ":memory:" }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    let output = "";
    for await (const chunk of child.stdout) {
      output += chunk;
      if (/listening on port \d+/.test(output)) break;
    }
    const url = `http://127.0.0.1:${/listening on port (\d+)/.exec(output)?.[1]}`;
    const root = await fetch(`${url}/`);
    assert.equal(root.status, 200);
    const html = await root.text();
    assert.match(html, /<html/);
    for (const path of ["/budgets/abc-123/accounts", "/budgets/abc-123/accounts/", "/budgets/a%20b/accounts", "/budgets/abc-123/buckets", "/budgets/abc-123/buckets/",
      "/budgets/abc-123/accounts/acc-1", "/budgets/abc-123/accounts/acc-1/"]) {
      const page = await fetch(`${url}${path}`);
      assert.equal(page.status, 200, path);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
      assert.equal(await page.text(), html);
    }
    for (const path of ["/budgets/x/accounts/a/extra", "/budgets//accounts", "/budgets/x/accounts//", "/budgets/x/buckets/extra", "/budgets//buckets", "/budgets/x", "/accounts"]) assert.equal((await fetch(`${url}${path}`)).status, 404, path);
    assert.equal((await fetch(`${url}/core/money.js`)).status, 200);
    // Compiled UI modules are served by name; unknown names and nested paths are not.
    for (const name of ["app", "theme", "dom", "sheet", "shell", "accounts", "buckets", "bucket-dialog", "reorder", "register"]) {
      const script = await fetch(`${url}/ui/${name}.js`);
      assert.equal(script.status, 200, name);
      assert.match(script.headers.get("content-type") ?? "", /^text\/javascript/);
    }
    for (const path of ["/ui/missing.js", "/ui/fonts.js/x", "/ui/Dom.js"]) assert.equal((await fetch(`${url}${path}`)).status, 404, path);
  } finally {
    child.kill();
    await once(child, "exit");
  }
});

test("HTTP exposes groups and buckets with status codes for every error and serves the shared colours module", async () => {
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T12:00:00.000Z") });
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const client = createClient(url);
  const send = (path: string, method: string, body?: unknown) =>
    fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const statuses = async (path: string, method: string, body?: unknown) => {
    const response = await send(path, method, body);
    return [response.status, (await response.json()).error.code];
  };
  try {
    const budget = await client.createBudget({ name: "Household" });
    assert.deepEqual(await client.listBucketTable(budget.id), { groups: [], buckets: [] });
    const createdGroup = await send(`/api/budgets/${budget.id}/groups`, "POST", { name: "Fixed" });
    assert.equal(createdGroup.status, 201);
    const fixed = await createdGroup.json();
    assert.equal(createdGroup.headers.get("location"), `/api/groups/${fixed.id}`);
    const everyday = await client.createGroup(budget.id, { name: "Everyday" });

    const createdBucket = await send(`/api/budgets/${budget.id}/buckets`, "POST", { name: "Rent", groupId: fixed.id, type: "recurring", amount: 165_000 });
    assert.equal(createdBucket.status, 201);
    const rent = await createdBucket.json();
    assert.equal(createdBucket.headers.get("location"), `/api/buckets/${rent.id}`);
    assert.deepEqual([rent.colour, rent.available, rent.order], ["sky", 0, 1]);
    const vacation = await client.createBucket(budget.id, { name: "Vacation", newGroupName: "Goals", type: "goal", amount: 300_000, goalMonth: "2027-08" });
    const clothing = await client.createBucket(budget.id, { name: "Clothing", groupId: everyday.id, type: "plain" });
    const table = await client.listBucketTable(budget.id);
    assert.deepEqual(table.groups.map((group) => group.name), ["Fixed", "Everyday", "Goals"]);
    assert.deepEqual(table.buckets, [rent, clothing, vacation]);
    assert.deepEqual(await client.openBucket(rent.id), rent);

    assert.deepEqual((await client.renameGroup(everyday.id, { name: "Day to day" })).name, "Day to day");
    assert.equal((await client.moveGroup(vacation.groupId!, { index: 0 })).order, 1);
    assert.equal((await client.editBucket(rent.id, { type: "plain" })).amount, null);
    const moved = await client.moveBucket(clothing.id, { groupId: fixed.id, index: 0 });
    assert.deepEqual([moved.groupId, moved.order], [fixed.id, 1]);
    const archived = await client.archiveBucket(clothing.id);
    assert.deepEqual([archived.bucket.archived, archived.returned], [true, 0]);
    const restored = await client.restoreBucket(clothing.id);
    assert.deepEqual([restored.archived, restored.order], [false, 2]);

    const deleted = await send(`/api/groups/${everyday.id}`, "DELETE");
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), "");
    assert.equal(await client.deleteGroup((await client.createGroup(budget.id, { name: "Spare" })).id), undefined);

    for (const [attempt, errorCode] of [
      [() => client.deleteGroup(fixed.id), "group_not_empty"],
      [() => client.createGroup(budget.id, { name: "fixed" }), "name_taken"],
      [() => client.createBucket(budget.id, { name: "RENT", groupId: fixed.id, type: "plain" }), "name_taken"],
      [() => client.createBucket(budget.id, { name: "Pink", groupId: fixed.id, type: "plain", colour: "pink" as never }), "invalid_input"],
      [() => client.editBucket(vacation.id, { goalMonth: "2020-01" }), "invalid_input"],
      [() => client.listBucketTable("missing"), "not_found"],
      [() => client.openBucket("missing"), "not_found"],
      [() => client.archiveBucket("missing"), "not_found"],
      [() => client.deleteGroup("missing"), "not_found"],
    ] as const) {
      await assert.rejects(attempt(), { code: errorCode }, errorCode);
    }
    assert.deepEqual(await statuses(`/api/groups/${fixed.id}`, "DELETE"), [409, "group_not_empty"]);
    assert.deepEqual(await statuses(`/api/budgets/${budget.id}/groups`, "POST", { name: "FIXED" }), [409, "name_taken"]);
    assert.deepEqual(await statuses(`/api/budgets/${budget.id}/buckets`, "POST", { name: "clothing", groupId: fixed.id, type: "plain" }), [409, "name_taken"]);
    assert.deepEqual(await statuses(`/api/budgets/${budget.id}/buckets`, "POST", { name: "X", groupId: fixed.id, type: "goal", amount: 1 }), [400, "invalid_input"]);
    assert.deepEqual(await statuses(`/api/budgets/${budget.id}/buckets`, "POST", { name: "X", groupId: fixed.id, type: "plain", available: 5 }), [400, "invalid_input"]);
    assert.deepEqual(await statuses(`/api/budgets/${budget.id}/buckets`, "POST", { name: "X", groupId: "missing", type: "plain" }), [404, "not_found"]);
    assert.deepEqual(await statuses(`/api/buckets/${rent.id}`, "PATCH", {}), [400, "invalid_input"]);
    // Validation errors name their field in the JSON body; errors with no single field omit it.
    const errorBody = async (path: string, method: string, body?: unknown) => (await (await send(path, method, body)).json()).error;
    assert.deepEqual(await errorBody(`/api/budgets/${budget.id}/buckets`, "POST", { name: "Clothing", groupId: fixed.id, type: "plain" }),
      { code: "name_taken", message: "A bucket with that name already exists in this budget.", field: "name" });
    assert.equal((await errorBody(`/api/budgets/${budget.id}/buckets`, "POST", { name: "Kids group", groupId: fixed.id, type: "goal", amount: 1 })).field, "month");
    assert.equal((await errorBody(`/api/budgets/${budget.id}/buckets`, "POST", { name: "X", groupId: fixed.id, type: "recurring", amount: 0 })).field, "amount");
    assert.equal((await errorBody(`/api/budgets/${budget.id}/groups`, "POST", { name: "fixed" })).field, "group");
    assert.equal((await errorBody(`/api/buckets/${rent.id}`, "PATCH", {})).field, undefined);
    // The revert route: refused with bucket_changed (409) when updatedAt is stale, applied when it matches.
    assert.deepEqual(await statuses(`/api/buckets/${rent.id}/revert`, "POST", { type: "plain", revertOf: "2000-01-01T00:00:00.000Z" }), [409, "bucket_changed"]);
    assert.deepEqual(await statuses(`/api/buckets/${rent.id}/revert`, "POST", { type: "plain" }), [400, "invalid_input"]);
    const revertible = await client.openBucket(rent.id);
    const reverted = await client.revertBucket(rent.id, { type: "recurring", amount: 165_100, revertOf: revertible.updatedAt });
    assert.deepEqual([reverted.type, reverted.amount], ["recurring", 165_100]);
    // A past month that is not the one before the undone edit is refused with 400.
    const goal = await client.createBucket(budget.id, { name: "Holiday", groupId: fixed.id, type: "goal", amount: 100, goalMonth: "2099-01" });
    const shifted = await client.editBucket(goal.id, { goalMonth: "2099-02" });
    assert.deepEqual(await statuses(`/api/buckets/${goal.id}/revert`, "POST", { goalMonth: "2020-01", revertOf: shifted.updatedAt }), [400, "invalid_input"]);
    assert.deepEqual(await statuses(`/api/buckets/${rent.id}/move`, "POST", { index: 0 }), [400, "invalid_input"]);
    assert.deepEqual(await statuses(`/api/groups/${fixed.id}/move`, "POST", { index: "first" }), [400, "invalid_input"]);
    assert.deepEqual(await statuses(`/api/groups/${fixed.id}`, "PATCH", { name: "" }), [400, "invalid_input"]);
    assert.deepEqual(await statuses("/api/buckets/missing/restore", "POST"), [404, "not_found"]);
    assert.deepEqual(await statuses("/api/groups/missing/move", "POST", { index: 0 }), [404, "not_found"]);
    for (const [path, method] of [
      ["/api/budgets/%ZZ/buckets", "GET"], ["/api/budgets/%ZZ/groups", "POST"], ["/api/groups/%ZZ", "PATCH"], ["/api/groups/%ZZ", "DELETE"],
      ["/api/buckets/%ZZ", "GET"], ["/api/buckets/%ZZ/archive", "POST"],
    ] as const) {
      assert.deepEqual(await statuses(path, method, method === "GET" || method === "DELETE" ? undefined : {}), [400, "invalid_input"], `${method} ${path}`);
    }
    for (const [path, method] of [
      [`/api/groups/${fixed.id}`, "GET"], [`/api/groups/${fixed.id}/move`, "GET"], [`/api/budgets/${budget.id}/groups`, "GET"],
      [`/api/buckets/${rent.id}`, "DELETE"], [`/api/buckets/${rent.id}/archive`, "GET"], [`/api/buckets/${rent.id}/other`, "POST"],
      [`/api/budgets/${budget.id}/buckets`, "PUT"],
    ] as const) {
      assert.deepEqual(await statuses(path, method), [404, "not_found"], `${method} ${path}`);
    }
    const wrongType = await fetch(`${url}/api/buckets/${rent.id}`, { method: "PATCH", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(wrongType.status, 415);

    const colours = await fetch(`${url}/core/colours.js`);
    assert.equal(colours.status, 200);
    assert.match(colours.headers.get("content-type") ?? "", /^text\/javascript/);
    const text = await colours.text();
    assert.match(text, /export function leastUsedColour/);
    assert.doesNotMatch(text, /^import /m);
    assert.equal((await fetch(`${url}/core/buckets.js`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});

test("HTTP exposes an account's transactions and Ready to assign, with status codes for every error", async () => {
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T12:00:00.000Z"), timeZone: "UTC" });
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const client = createClient(url);
  const send = (path: string, method: string, body?: unknown) =>
    fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const statuses = async (path: string, method: string, body?: unknown) => {
    const response = await send(path, method, body);
    return [response.status, (await response.json()).error.code];
  };
  const income = { kind: "income" } as const;
  try {
    const budget = await client.createBudget({ name: "Household" });
    const checking = await client.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" });
    await client.createAccount(budget.id, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });
    assert.deepEqual(await client.readyToAssign(budget.id), { readyToAssign: 58_791 });
    assert.deepEqual(await client.listTransactions(checking.id), { transactions: [] });

    const response = await send(`/api/accounts/${checking.id}/transactions`, "POST", { date: "2026-11-14", payee: "Acme", amount: 200_000, category: income });
    assert.equal(response.status, 201);
    const paycheck = await response.json();
    assert.equal(response.headers.get("location"), `/api/transactions/${paycheck.id}`);
    assert.deepEqual(await client.openTransaction(paycheck.id), paycheck);
    const bonus = await client.addTransaction(checking.id, { payee: "Bonus", amount: 5_000, category: income });
    assert.equal(bonus.date, "2026-11-20");
    assert.deepEqual(await client.listTransactions(checking.id), { transactions: [{ ...bonus, runningBalance: 305_000 }, { ...paycheck, runningBalance: 300_000 }] });
    assert.deepEqual(await client.readyToAssign(budget.id), { readyToAssign: 263_791 });
    assert.equal((await client.openAccount(checking.id)).balance, 305_000);

    const edited = await client.editTransaction(bonus.id, { amount: 6_000, memo: "Year end" });
    assert.deepEqual([edited.amount, edited.memo], [6_000, "Year end"]);
    const deleted = await send(`/api/transactions/${bonus.id}`, "DELETE");
    assert.equal(deleted.status, 204);
    assert.equal(await client.deleteTransaction(paycheck.id), undefined);
    assert.deepEqual(await client.readyToAssign(budget.id), { readyToAssign: 58_791 });

    const wallet = await client.createAccount(budget.id, { name: "Wallet", type: "cash", startingBalance: 0, startingDate: "2026-11-01" });
    await client.closeAccount(wallet.id);
    const transactions = `/api/accounts/${checking.id}/transactions`;
    assert.deepEqual(await statuses(`/api/accounts/${wallet.id}/transactions`, "POST", { amount: 100, category: income }), [409, "account_closed"]);
    assert.deepEqual(await statuses(transactions, "POST", { amount: -500, category: income }), [400, "invalid_input"]);
    assert.deepEqual(await statuses(transactions, "POST", { amount: 100, category: income, date: "2026-11-21" }), [400, "invalid_input"]);
    assert.deepEqual(await statuses(transactions, "POST", { amount: 100, category: income, id: "mine" }), [400, "invalid_input"]);
    assert.deepEqual(await statuses("/api/accounts/missing/transactions", "POST", { amount: 100, category: income }), [404, "not_found"]);
    assert.deepEqual(await statuses("/api/accounts/missing/transactions", "GET"), [404, "not_found"]);
    assert.deepEqual(await statuses(`/api/transactions/${bonus.id}`, "GET"), [404, "not_found"]);
    assert.deepEqual(await statuses(`/api/transactions/${bonus.id}`, "PATCH", { memo: "x" }), [404, "not_found"]);
    assert.deepEqual(await statuses(`/api/transactions/${bonus.id}`, "DELETE"), [404, "not_found"]);
    assert.deepEqual(await statuses("/api/budgets/missing/ready-to-assign", "GET"), [404, "not_found"]);
    for (const [path, method] of [
      ["/api/accounts/%ZZ/transactions", "GET"], ["/api/accounts/%ZZ/transactions", "POST"], ["/api/transactions/%ZZ", "GET"],
      ["/api/transactions/%ZZ", "PATCH"], ["/api/transactions/%ZZ", "DELETE"], ["/api/budgets/%ZZ/ready-to-assign", "GET"],
    ] as const) {
      assert.deepEqual(await statuses(path, method, method === "POST" || method === "PATCH" ? {} : undefined), [400, "invalid_input"], `${method} ${path}`);
    }
    for (const [path, method] of [[transactions, "PUT"], [transactions, "DELETE"], ["/api/transactions/x", "POST"], [`/api/budgets/${budget.id}/ready-to-assign`, "POST"]] as const) {
      assert.deepEqual(await statuses(path, method, method === "DELETE" ? undefined : {}), [404, "not_found"], `${method} ${path}`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});

test("HTTP files transactions to buckets, refuses archived ones, and serves payee history", async () => {
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T12:00:00.000Z"), timeZone: "UTC" });
  const server = createApi(core);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const client = createClient(url);
  const statuses = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return [response.status, (await response.json()).error.code];
  };
  try {
    const budget = await client.createBudget({ name: "Household" });
    const visa = await client.createAccount(budget.id, { name: "Visa", type: "credit-card", startingBalance: 0, startingDate: "2026-11-01" });
    const group = await client.createGroup(budget.id, { name: "Everyday" });
    const eatingOut = await client.createBucket(budget.id, { name: "Eating out", groupId: group.id, type: "plain" });
    const old = await client.createBucket(budget.id, { name: "Old", groupId: group.id, type: "plain" });
    const dinner = await client.addTransaction(visa.id, { payee: "Noodle Bar", amount: -12_000, category: { kind: "bucket", bucketId: eatingOut.id } });
    assert.equal((await client.openBucket(eatingOut.id)).available, -12_000);
    assert.deepEqual(await client.payees(budget.id), [{ payee: "Noodle Bar", category: { kind: "bucket", bucketId: eatingOut.id } }]);
    assert.deepEqual(await statuses(`/api/buckets/${eatingOut.id}/archive`, "POST"), [409, "bucket_overspent"]);
    await client.archiveBucket(old.id);
    assert.deepEqual(await statuses(`/api/accounts/${visa.id}/transactions`, "POST", { amount: -100, category: { kind: "bucket", bucketId: old.id } }), [409, "bucket_archived"]);
    assert.deepEqual(await statuses(`/api/transactions/${dinner.id}`, "PATCH", { category: { kind: "bucket", bucketId: old.id } }), [409, "bucket_archived"]);
    await client.addTransaction(visa.id, { amount: 13_000, category: { kind: "bucket", bucketId: eatingOut.id } });
    assert.deepEqual(await statuses(`/api/buckets/${eatingOut.id}/archive`, "POST"), [409, "bucket_has_money"]);
    assert.deepEqual(await statuses("/api/budgets/missing/payees", "GET"), [404, "not_found"]);
    assert.deepEqual(await statuses(`/api/budgets/${budget.id}/payees`, "POST", {}), [404, "not_found"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    core.close();
  }
});
