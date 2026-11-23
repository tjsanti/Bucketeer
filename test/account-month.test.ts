import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetError, openBucketeer } from "../src/core/index.js";

const code = (expected: string) => (error: unknown) => error instanceof BudgetError && error.code === expected;
const income = { kind: "income" } as const;

/** A budget created on 2026-11-20 with Checking at 1,000.00; the clock is movable. */
function household(start = "2026-11-20T12:00:00.000Z") {
  let now = new Date(start);
  const core = openBucketeer(":memory:", { now: () => now, timeZone: "UTC" });
  const budget = core.createBudget({ name: "Household" });
  const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" });
  return { core, budget, checking, setNow: (iso: string) => { now = new Date(iso); } };
}

test("the month range runs from the creation month − 12 to the current month + 12, and grows as the clock moves", () => {
  const { core, budget, setNow } = household();
  try {
    assert.deepEqual(core.monthRange(budget.id), { first: "2025-11", current: "2026-11", last: "2027-11" });
    setNow("2027-03-02T12:00:00.000Z");
    assert.deepEqual(core.monthRange(budget.id), { first: "2025-11", current: "2027-03", last: "2028-03" });
    assert.throws(() => core.monthRange("missing"), code("not_found"));
  } finally {
    core.close();
  }
});

test("an account month has the balance at the end of that month and only its transactions, with running balances counting all earlier ones", () => {
  const { core, checking } = household();
  try {
    const add = (date: string, amount: number) => core.addTransaction(checking.id, { date, amount, category: income });
    add("2026-09-30", 10_000);
    const oct1 = add("2026-10-01", 20_000);
    const oct31 = add("2026-10-31", 30_000);
    add("2026-11-01", 40_000);
    add("2026-11-19", 50_000);

    const october = core.accountMonth(checking.id, "2026-10");
    // 1,000.00 starting + 100.00 + 200.00 + 300.00; November's 400.00 and 500.00 are later.
    assert.equal(october.balance, 160_000);
    assert.deepEqual(october.transactions.map((row) => [row.id, row.runningBalance]), [[oct31.id, 160_000], [oct1.id, 130_000]]);
    const full = new Map(core.listTransactions(checking.id).transactions.map((row) => [row.id, row]));
    for (const row of october.transactions) assert.deepEqual(row, full.get(row.id));

    // The current month's balance is the balance today; a future month has nothing yet.
    assert.equal(core.accountMonth(checking.id, "2026-11").balance, 250_000);
    assert.deepEqual(core.accountMonth(checking.id, "2027-02"), { balance: 250_000, transactions: [] });
    // The starting balance counts in every month, whatever its date (ADR-0006).
    assert.deepEqual(core.accountMonth(checking.id, "2026-08"), { balance: 100_000, transactions: [] });
  } finally {
    core.close();
  }
});

test("an account month must be a YYYY-MM inside the month range", () => {
  const { core, checking } = household();
  try {
    assert.equal(core.accountMonth(checking.id, "2025-11").balance, 100_000);
    assert.equal(core.accountMonth(checking.id, "2027-11").balance, 100_000);
    for (const month of ["2025-10", "2027-12", "2026-13", "2026-1", "november", 202611]) {
      assert.throws(() => core.accountMonth(checking.id, month as string), code("invalid_input"), String(month));
    }
    assert.throws(() => core.accountMonth("missing", "2026-11"), code("not_found"));
  } finally {
    core.close();
  }
});

test("the overview's balances are each account's balance at the end of the month, closed accounts included", () => {
  const { core, budget, checking } = household();
  try {
    const savings = core.createAccount(budget.id, { name: "Savings", type: "savings", startingBalance: 0, startingDate: "2026-11-01" });
    core.addTransaction(checking.id, { date: "2026-10-15", amount: 20_000, category: income });
    core.addTransaction(checking.id, { date: "2026-11-02", amount: 5_000, category: income });
    core.closeAccount(savings.id);
    assert.deepEqual(core.accountBalances(budget.id, "2026-10"), { [checking.id]: 120_000, [savings.id]: 0 });
    assert.deepEqual(core.accountBalances(budget.id, "2026-11"), { [checking.id]: 125_000, [savings.id]: 0 });
    assert.throws(() => core.accountBalances(budget.id, "2028-01"), code("invalid_input"));
    assert.throws(() => core.accountBalances("missing", "2026-11"), code("not_found"));
  } finally {
    core.close();
  }
});
