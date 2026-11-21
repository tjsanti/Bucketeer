import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetError, openBucketeer } from "../src/core/index.js";

const code = (expected: string) => (error: unknown) => error instanceof BudgetError && error.code === expected;
const income = { kind: "income" } as const;

/** A budget created on 2026-11-15 with Checking at 1,000.00 and Visa at −412.09; the clock is movable. */
function household(start = "2026-11-20T12:00:00.000Z") {
  let now = new Date(start);
  const core = openBucketeer(":memory:", { now: () => now, timeZone: "UTC" });
  const budget = core.createBudget({ name: "Household" });
  const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" });
  const visa = core.createAccount(budget.id, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });
  return { core, budget, checking, visa, setNow: (iso: string) => { now = new Date(iso); } };
}

test("income fills Ready to assign and the account's balance; a card's debt still reduces Ready to assign", () => {
  const { core, budget, checking, visa } = household();
  try {
    assert.equal(core.readyToAssign(budget.id), 58_791);
    const paycheck = core.addTransaction(checking.id, { date: "2026-11-14", payee: "  Acme Payroll ", memo: " November ", amount: 200_000, category: income });
    assert.deepEqual(paycheck, {
      id: paycheck.id, budgetId: budget.id, accountId: checking.id, date: "2026-11-14", payee: "Acme Payroll", memo: "November",
      amount: 200_000, category: income, createdAt: "2026-11-20T12:00:00.000Z", updatedAt: "2026-11-20T12:00:00.000Z",
    });
    assert.equal(core.readyToAssign(budget.id), 258_791);
    assert.equal(core.openAccount(checking.id).balance, 300_000);
    assert.equal(core.openAccount(visa.id).balance, -41_209);
    assert.deepEqual(core.openTransaction(paycheck.id), paycheck);
  } finally {
    core.close();
  }
});

test("income must be positive, and amounts share the accounts' bound", () => {
  const { core, checking } = household();
  try {
    for (const amount of [0, -500, 1.5, 100_000_000_000, "5"]) {
      assert.throws(() => core.addTransaction(checking.id, { amount, category: income }), code("invalid_input"), String(amount));
    }
    assert.equal(core.addTransaction(checking.id, { amount: 99_999_999_999, category: income }).amount, 99_999_999_999);
    const small = core.addTransaction(checking.id, { amount: 1, category: income });
    assert.throws(() => core.editTransaction(small.id, { amount: -1 }), code("invalid_input"));
    assert.throws(() => core.addTransaction(checking.id, { amount: 100 }), code("invalid_input"));
    assert.throws(() => core.addTransaction(checking.id, { amount: 100, category: { kind: "ready" } }), code("invalid_input"));
    assert.throws(() => core.addTransaction(checking.id, { amount: 100, category: income, id: "mine" }), code("invalid_input"));
    assert.throws(() => core.addTransaction("missing", { amount: 100, category: income }), code("not_found"));
  } finally {
    core.close();
  }
});

test("payee is 0 to 120 code points and memo 0 to 500, both trimmed; both default to empty", () => {
  const { core, checking } = household();
  try {
    const bare = core.addTransaction(checking.id, { amount: 100, category: income });
    assert.deepEqual([bare.payee, bare.memo], ["", ""]);
    const emoji = "🪣";
    const longest = core.addTransaction(checking.id, { amount: 100, category: income, payee: ` ${emoji.repeat(120)} `, memo: emoji.repeat(500) });
    assert.deepEqual([[...longest.payee].length, [...longest.memo].length], [120, 500]);
    assert.throws(() => core.addTransaction(checking.id, { amount: 100, category: income, payee: "x".repeat(121) }), code("invalid_input"));
    assert.throws(() => core.addTransaction(checking.id, { amount: 100, category: income, memo: "x".repeat(501) }), code("invalid_input"));
    assert.throws(() => core.addTransaction(checking.id, { amount: 100, category: income, payee: 7 }), code("invalid_input"));
    assert.equal(core.editTransaction(bare.id, { payee: "  Acme  " }).payee, "Acme");
  } finally {
    core.close();
  }
});

test("dates default to today in the server's zone, may precede the starting date, and are bounded", () => {
  // 03:00 UTC on Nov 21 is still Nov 20 in New York.
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-21T03:00:00.000Z"), timeZone: "America/New_York" });
  try {
    const budget = core.createBudget({ name: "Household" });
    const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-10" });
    assert.equal(core.addTransaction(checking.id, { amount: 100, category: income }).date, "2026-11-20");
    assert.throws(() => core.addTransaction(checking.id, { date: "2026-11-21", amount: 100, category: income }),
      (error) => code("invalid_input")(error) && (error as Error).message === "Transactions can't be dated in the future.");
    // Before the starting date: accepted, and it counts toward the balance.
    core.addTransaction(checking.id, { date: "2026-11-02", amount: 5_000, category: income });
    assert.equal(core.openAccount(checking.id).balance, 105_100);
    // The budget began in November 2026, so the earliest date is 2025-11-01.
    assert.equal(core.addTransaction(checking.id, { date: "2025-11-01", amount: 100, category: income }).date, "2025-11-01");
    assert.throws(() => core.addTransaction(checking.id, { date: "2025-10-31", amount: 100, category: income }), code("invalid_input"));
    assert.throws(() => core.addTransaction(checking.id, { date: "2026-02-30", amount: 100, category: income }), code("invalid_input"));
    const moved = core.addTransaction(checking.id, { amount: 100, category: income });
    assert.throws(() => core.editTransaction(moved.id, { date: "2026-11-21" }), code("invalid_input"));
    assert.equal(core.editTransaction(moved.id, { date: "2026-11-19" }).date, "2026-11-19");
  } finally {
    core.close();
  }
});

test("a closed account takes no new transactions, and closing still needs a zero balance", () => {
  const { core, budget, checking } = household();
  try {
    const wallet = core.createAccount(budget.id, { name: "Wallet", type: "cash", startingBalance: 0, startingDate: "2026-11-01" });
    const gift = core.addTransaction(wallet.id, { amount: 2_000, category: income, memo: "Birthday" });
    assert.throws(() => core.closeAccount(wallet.id), code("balance_not_zero"));
    core.deleteTransaction(gift.id);
    assert.throws(() => core.openTransaction(gift.id), code("not_found"));
    core.closeAccount(wallet.id);
    assert.throws(() => core.addTransaction(wallet.id, { amount: 100, category: income }), code("account_closed"));
    assert.ok(core.addTransaction(checking.id, { amount: 100, category: income }));
  } finally {
    core.close();
  }
});

test("editing income below what's been assigned is allowed, and Ready to assign can go negative", () => {
  const { core, budget, checking } = household();
  try {
    const paycheck = core.addTransaction(checking.id, { amount: 200_000, category: income });
    // Nothing is assigned until the month slice, so lower the starting balance to stand in for spending it.
    core.editAccount(checking.id, { startingBalance: 0 });
    assert.equal(core.readyToAssign(budget.id), 158_791);
    const edited = core.editTransaction(paycheck.id, { amount: 1_000, memo: "Corrected" });
    assert.deepEqual([edited.amount, edited.memo, edited.createdAt], [1_000, "Corrected", paycheck.createdAt]);
    assert.equal(core.readyToAssign(budget.id), -40_209);
    assert.throws(() => core.editTransaction(paycheck.id, {}), code("invalid_input"));
    assert.throws(() => core.editTransaction("missing", { memo: "x" }), code("not_found"));
  } finally {
    core.close();
  }
});

test("an account's register is newest first with running balances, and readyToAssign counts every account's income", () => {
  const { core, budget, checking, visa } = household();
  try {
    const first = core.addTransaction(checking.id, { date: "2026-11-05", payee: "Acme", amount: 200_000, category: income });
    const later = core.addTransaction(checking.id, { date: "2026-11-18", payee: "Side gig", amount: 5_000, category: income });
    const sameDay = core.addTransaction(checking.id, { date: "2026-11-05", payee: "Refund", amount: 1_000, category: income });
    core.addTransaction(visa.id, { date: "2026-11-06", payee: "Cashback", amount: 1_209, category: income });
    const { transactions } = core.listTransactions(checking.id);
    assert.deepEqual(transactions.map((row) => [row.id, row.runningBalance]), [[later.id, 306_000], [sameDay.id, 301_000], [first.id, 300_000]]);
    assert.deepEqual(core.listTransactions(visa.id).transactions.map((row) => row.runningBalance), [-40_000]);
    assert.equal(core.readyToAssign(budget.id), 58_791 + 207_209);
    assert.throws(() => core.listTransactions("missing"), code("not_found"));
  } finally {
    core.close();
  }
});
