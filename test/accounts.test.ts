import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BudgetError, openBucketeer } from "../src/core/index.js";

const checking = { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" };
const visa = { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" };
const code = (expected: string) => (error: unknown) => error instanceof BudgetError && error.code === expected;

test("accounts are created with server-assigned fields, listed in order, and survive reopening", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-15T09:00:00.000Z") });
  const directory = mkdtempSync(join(tmpdir(), "bucketeer-accounts-"));
  const filename = join(directory, "accounts.sqlite");
  let core = openBucketeer(filename);
  try {
    const budget = core.createBudget({ name: "Household" });
    assert.deepEqual(core.listAccounts(budget.id), []);
    const first = core.createAccount(budget.id, { ...checking, name: "  Checking  " });
    assert.deepEqual(first, {
      id: first.id, budgetId: budget.id, name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01",
      balance: 100_000, order: 1, closed: false, closedAt: null, createdAt: "2026-11-15T09:00:00.000Z", updatedAt: "2026-11-15T09:00:00.000Z",
    });
    const second = core.createAccount(budget.id, visa);
    const third = core.createAccount(budget.id, { name: "Wallet", type: "cash", startingBalance: 0, startingDate: "2026-11-02" });
    assert.deepEqual([first.order, second.order, third.order], [1, 2, 3]);
    assert.equal(second.balance, -41_209);
    assert.deepEqual(core.listAccounts(budget.id), [first, second, third]);
    assert.deepEqual(core.openAccount(second.id), second);
    core.close();
    core = openBucketeer(filename);
    assert.deepEqual(core.listAccounts(budget.id), [first, second, third]);
    assert.equal(core.createAccount(budget.id, { ...checking, name: "Savings", type: "savings" }).order, 4);
  } finally {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accounts are scoped to their budget and names only collide within one", () => {
  const core = openBucketeer(":memory:");
  try {
    const a = core.createBudget({ name: "A" });
    const b = core.createBudget({ name: "B" });
    const inA = core.createAccount(a.id, checking);
    const inB = core.createAccount(b.id, checking);
    assert.equal(inB.order, 1);
    assert.deepEqual(core.listAccounts(a.id), [inA]);
    assert.deepEqual(core.listAccounts(b.id), [inB]);
    assert.equal(core.readyToAssign(a.id), 100_000);
    assert.throws(() => core.createAccount("missing", checking), code("not_found"));
    assert.throws(() => core.listAccounts("missing"), code("not_found"));
    assert.throws(() => core.readyToAssign("missing"), code("not_found"));
  } finally {
    core.close();
  }
});

test("readyToAssign sums every starting balance, closed accounts included", () => {
  const core = openBucketeer(":memory:");
  try {
    const budget = core.createBudget({ name: "Household" });
    assert.equal(core.readyToAssign(budget.id), 0);
    core.createAccount(budget.id, checking);
    core.createAccount(budget.id, visa);
    assert.equal(core.readyToAssign(budget.id), 58_791);
    const wallet = core.createAccount(budget.id, { name: "Wallet", type: "cash", startingBalance: 0, startingDate: "2026-11-01" });
    core.closeAccount(wallet.id);
    assert.equal(core.readyToAssign(budget.id), 58_791);
    core.editAccount(wallet.id, { startingBalance: 0, name: "Old wallet" });
    assert.equal(core.readyToAssign(budget.id), 58_791);
  } finally {
    core.close();
  }
});

test("account input is validated strictly", () => {
  const core = openBucketeer(":memory:");
  try {
    const budget = core.createBudget({ name: "Household" });
    const bad: unknown[] = [
      null, [], "x", {}, { ...checking, name: " " }, { ...checking, name: 5 }, { ...checking, name: "\0" }, { ...checking, name: "x".repeat(121) },
      { ...checking, type: "brokerage" }, { ...checking, type: undefined }, { ...checking, type: "Checking" },
      { ...checking, startingBalance: 1.5 }, { ...checking, startingBalance: "100" }, { ...checking, startingBalance: Number.NaN },
      { ...checking, startingBalance: 100_000_000_000 }, { ...checking, startingBalance: -100_000_000_000 }, { ...checking, startingBalance: 2 ** 60 },
      { ...checking, startingBalance: undefined }, { name: "X", type: "cash", startingDate: "2026-11-01" },
      { ...checking, startingDate: "2026-02-30" }, { ...checking, startingDate: "2026-13-01" }, { ...checking, startingDate: "2025-02-29" }, { ...checking, startingDate: "2026-1-1" },
      { ...checking, startingDate: "2026-11-01T00:00:00Z" }, { ...checking, startingDate: 20261101 }, { ...checking, startingDate: undefined },
      { ...checking, id: "mine" }, { ...checking, budgetId: budget.id }, { ...checking, balance: 5 }, { ...checking, closed: true }, { ...checking, order: 9 },
      { ...checking, createdAt: "2020-01-01T00:00:00.000Z" }, { ...checking, extra: true },
    ];
    for (const input of bad) assert.throws(() => core.createAccount(budget.id, input), code("invalid_input"), JSON.stringify(input));
    assert.deepEqual(core.listAccounts(budget.id), []);
    for (const input of [{ ...checking, startingBalance: 99_999_999_999 }, { ...checking, name: "Neg", startingBalance: -99_999_999_999 }, { ...checking, name: "Leap", startingDate: "2028-02-29" }, { ...checking, name: "🪣".repeat(120) }]) {
      assert.doesNotThrow(() => core.createAccount(budget.id, input));
    }
    assert.throws(() => core.createAccount(budget.id, { ...checking, name: "🪣".repeat(121) }), code("invalid_input"));
  } finally {
    core.close();
  }
});

test("names are unique per budget, case-insensitively, across open and closed accounts", () => {
  const core = openBucketeer(":memory:");
  try {
    const budget = core.createBudget({ name: "Household" });
    const main = core.createAccount(budget.id, checking);
    const other = core.createAccount(budget.id, { ...checking, name: "Savings", type: "savings", startingBalance: 0 });
    for (const name of ["checking", "CHECKING", "  Checking "]) assert.throws(() => core.createAccount(budget.id, { ...checking, name }), code("name_taken"));
    core.closeAccount(other.id);
    assert.throws(() => core.createAccount(budget.id, { ...checking, name: "savings" }), code("name_taken"));
    assert.throws(() => core.editAccount(main.id, { name: "SAVINGS" }), code("name_taken"));
    assert.equal(core.editAccount(main.id, { name: "CHECKING" }).name, "CHECKING");
    assert.equal(core.listAccounts(budget.id).length, 2);
  } finally {
    core.close();
  }
});

test("editing changes only the supplied fields and keeps identity", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-15T09:00:00.000Z") });
  const core = openBucketeer(":memory:");
  try {
    const budget = core.createBudget({ name: "Household" });
    const original = core.createAccount(budget.id, checking);
    t.mock.timers.tick(60_000);
    const renamed = core.editAccount(original.id, { name: " Main checking " });
    assert.deepEqual(renamed, { ...original, name: "Main checking", updatedAt: "2026-11-15T09:01:00.000Z" });
    const changed = core.editAccount(original.id, { startingBalance: 250_050, startingDate: "2026-10-31" });
    assert.equal(changed.startingBalance, 250_050);
    assert.equal(changed.balance, 250_050);
    assert.equal(changed.startingDate, "2026-10-31");
    assert.equal(changed.name, "Main checking");
    assert.equal(changed.createdAt, original.createdAt);
    assert.equal(core.readyToAssign(budget.id), 250_050);
    for (const input of [{}, null, [], { type: "savings" }, { name: "X", type: "cash" }, { id: "x", name: "X" }, { balance: 1 }, { closed: true }, { name: "" }, { startingBalance: 0.5 }, { startingDate: "2026-02-30" }, { name: undefined }]) {
      assert.throws(() => core.editAccount(original.id, input), code("invalid_input"), JSON.stringify(input));
    }
    assert.deepEqual(core.openAccount(original.id), changed);
    assert.throws(() => core.editAccount("missing", { name: "X" }), code("not_found"));
    assert.throws(() => core.openAccount("missing"), code("not_found"));
  } finally {
    core.close();
  }
});

test("closing needs a zero balance, is reversible, and keeps closed accounts at zero", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-15T09:00:00.000Z") });
  const core = openBucketeer(":memory:");
  try {
    const budget = core.createBudget({ name: "Household" });
    const main = core.createAccount(budget.id, checking);
    const wallet = core.createAccount(budget.id, { name: "Wallet", type: "cash", startingBalance: 0, startingDate: "2026-11-01" });
    assert.throws(() => core.closeAccount(main.id), (error: unknown) => error instanceof BudgetError && error.code === "balance_not_zero" && error.message === "Balance must be 0.00.");
    assert.equal(core.openAccount(main.id).closed, false);
    t.mock.timers.tick(1000);
    const closed = core.closeAccount(wallet.id);
    assert.equal(closed.closed, true);
    assert.equal(closed.closedAt, "2026-11-15T09:00:01.000Z");
    assert.equal(closed.updatedAt, "2026-11-15T09:00:01.000Z");
    assert.deepEqual(core.listAccounts(budget.id).map((account) => [account.name, account.closed]), [["Checking", false], ["Wallet", true]]);
    // Idempotent: closing again changes nothing.
    t.mock.timers.tick(1000);
    assert.deepEqual(core.closeAccount(wallet.id), closed);
    // Closed accounts may be renamed (closedAt kept) but never given a balance.
    const renamed = core.editAccount(wallet.id, { name: "Old wallet", startingBalance: 0 });
    assert.equal(renamed.closedAt, closed.closedAt);
    assert.throws(() => core.editAccount(wallet.id, { name: "Rich wallet", startingBalance: 500 }), code("balance_not_zero"));
    assert.equal(core.openAccount(wallet.id).name, "Old wallet");
    assert.equal(core.editAccount(wallet.id, { startingDate: "2026-10-01" }).closed, true);
    const reopened = core.reopenAccount(wallet.id);
    assert.equal(reopened.closed, false);
    assert.equal(reopened.closedAt, null);
    assert.equal(reopened.order, wallet.order);
    assert.deepEqual(core.reopenAccount(wallet.id), reopened);
    assert.equal(core.editAccount(wallet.id, { startingBalance: 500 }).balance, 500);
    assert.throws(() => core.closeAccount("missing"), code("not_found"));
    assert.throws(() => core.reopenAccount("missing"), code("not_found"));
  } finally {
    core.close();
  }
});

test("the database refuses invalid account rows and schema creation is idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "bucketeer-schema-"));
  const filename = join(directory, "schema.sqlite");
  try {
    const core = openBucketeer(filename);
    const budget = core.createBudget({ name: "Household" });
    core.close();
    openBucketeer(filename).close();
    const raw = new DatabaseSync(filename);
    raw.exec("PRAGMA foreign_keys = ON");
    const insert = (budgetId: string, type: string, balance: number, date: string) => raw.prepare(
      "INSERT INTO accounts (id, budget_id, name, type, starting_balance, starting_date, sort_order, created_at, updated_at) VALUES ('x', ?, 'n', ?, ?, ?, 1, 't', 't')",
    ).run(budgetId, type, balance, date);
    assert.throws(() => insert("missing", "cash", 0, "2026-01-01"));
    assert.throws(() => insert(budget.id, "other", 0, "2026-01-01"));
    assert.throws(() => insert(budget.id, "cash", 100_000_000_000, "2026-01-01"));
    assert.throws(() => insert(budget.id, "cash", 0, "2026-02-30"));
    assert.throws(() => insert(budget.id, "cash", 0, "yesterday"));
    assert.doesNotThrow(() => insert(budget.id, "cash", 0, "2026-02-28"));
    raw.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a new account without a starting date starts today in the server's time zone", () => {
  // 03:00 UTC on the 20th is still the 19th in Los Angeles.
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T03:00:00.000Z"), timeZone: "America/Los_Angeles" });
  try {
    const budget = core.createBudget({ name: "Household" });
    const { startingDate: _, ...undated } = checking;
    assert.equal(core.createAccount(budget.id, undated).startingDate, "2026-11-19");
  } finally {
    core.close();
  }
});
