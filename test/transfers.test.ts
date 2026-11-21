import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetError, openBucketeer } from "../src/core/index.js";

const code = (expected: string) => (error: unknown) => error instanceof BudgetError && error.code === expected;

/** A budget with Checking at 1,000.00 and Visa at −412.09, on 2026-11-20 UTC. */
function household() {
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T12:00:00.000Z"), timeZone: "UTC" });
  const budget = core.createBudget({ name: "Household" });
  const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" });
  const visa = core.createAccount(budget.id, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });
  return { core, budget, checking, visa };
}

const transfer = (accountId: string) => ({ kind: "transfer", accountId });

test("a transfer pays the card off without touching Ready to assign", () => {
  const { core, budget, checking, visa } = household();
  try {
    const payment = core.addTransaction(checking.id, { date: "2026-11-18", amount: -41_209, memo: "Pay off", category: transfer(visa.id) });
    assert.equal(payment.accountId, checking.id);
    assert.equal(payment.amount, -41_209);
    assert.equal(payment.category.kind, "transfer");
    assert.deepEqual(core.openAccount(visa.id).balance, 0);
    assert.deepEqual(core.openAccount(checking.id).balance, 100_000 - 41_209);
    assert.equal(core.readyToAssign(budget.id), 58_791);

    const [other] = core.listTransactions(visa.id).transactions;
    assert.ok(other);
    assert.equal(payment.category.kind === "transfer" && payment.category.accountId, visa.id);
    assert.deepEqual([other.amount, other.date, other.memo, other.runningBalance], [41_209, "2026-11-18", "Pay off", 0]);
    assert.deepEqual(other.category, { kind: "transfer", accountId: checking.id, transferId: payment.category.kind === "transfer" ? payment.category.transferId : "" });
    assert.deepEqual(core.openTransaction(payment.id), payment);
  } finally {
    core.close();
  }
});

test("a transfer needs a different, open account in the same budget", () => {
  const { core, budget, checking, visa } = household();
  try {
    const other = core.createBudget({ name: "Other" });
    const foreign = core.createAccount(other.id, { name: "Savings", type: "savings", startingBalance: 0, startingDate: "2026-11-01" });
    const wallet = core.createAccount(budget.id, { name: "Wallet", type: "cash", startingBalance: 0, startingDate: "2026-11-01" });
    core.closeAccount(wallet.id);
    assert.throws(() => core.addTransaction(checking.id, { amount: -100, category: transfer(checking.id) }), code("invalid_input"));
    assert.throws(() => core.addTransaction(checking.id, { amount: -100, category: transfer(foreign.id) }), code("invalid_input"));
    assert.throws(() => core.addTransaction(checking.id, { amount: -100, category: transfer(wallet.id) }), code("account_closed"));
    assert.throws(() => core.addTransaction(wallet.id, { amount: -100, category: transfer(checking.id) }), code("account_closed"));
    assert.throws(() => core.addTransaction(checking.id, { amount: -100, category: transfer("missing") }), code("not_found"));
    for (const category of [{ kind: "transfer" }, { kind: "transfer", accountId: 7 }, { kind: "transfer", accountId: visa.id, extra: 1 }]) {
      assert.throws(() => core.addTransaction(checking.id, { amount: -100, category }), code("invalid_input"), JSON.stringify(category));
    }
    // Nothing was written by the refusals.
    assert.deepEqual([core.listTransactions(checking.id).transactions.length, core.listTransactions(visa.id).transactions.length], [0, 0]);
  } finally {
    core.close();
  }
});

test("an amount or date edit moves both sides; a memo or payee edit stays on one side", () => {
  const { core, budget, checking, visa } = household();
  try {
    const payment = core.addTransaction(checking.id, { date: "2026-11-18", amount: -41_209, memo: "Pay off", category: transfer(visa.id) });
    const otherSide = () => core.listTransactions(visa.id).transactions[0]!;
    const edited = core.editTransaction(payment.id, { amount: -20_000, date: "2026-11-19" });
    assert.deepEqual(edited.category, payment.category);
    assert.deepEqual([otherSide().amount, otherSide().date], [20_000, "2026-11-19"]);
    assert.deepEqual([core.openAccount(checking.id).balance, core.openAccount(visa.id).balance], [80_000, -21_209]);

    core.editTransaction(payment.id, { memo: "Half", payee: "Visa payment" });
    assert.deepEqual([otherSide().memo, otherSide().payee], ["Pay off", ""]);
    // Editing from the other side moves this side.
    core.editTransaction(otherSide().id, { amount: 41_209, memo: "Received" });
    assert.deepEqual([core.openTransaction(payment.id).amount, core.openTransaction(payment.id).memo], [-41_209, "Half"]);
    // Resending the category with its transferId, as an Undo does, is no change.
    assert.deepEqual(core.editTransaction(payment.id, { category: payment.category }).category, payment.category);
    assert.equal(core.readyToAssign(budget.id), 58_791);
  } finally {
    core.close();
  }
});

test("deleting either side removes both", () => {
  const { core, checking, visa } = household();
  try {
    const first = core.addTransaction(checking.id, { amount: -1_000, category: transfer(visa.id) });
    core.deleteTransaction(first.id);
    const second = core.addTransaction(visa.id, { amount: 2_000, category: transfer(checking.id) });
    assert.equal(core.listTransactions(checking.id).transactions[0]!.amount, -2_000);
    core.deleteTransaction(core.listTransactions(checking.id).transactions[0]!.id);
    assert.throws(() => core.openTransaction(second.id), code("not_found"));
    assert.deepEqual([core.listTransactions(checking.id).transactions.length, core.listTransactions(visa.id).transactions.length], [0, 0]);
    assert.deepEqual([core.openAccount(checking.id).balance, core.openAccount(visa.id).balance], [100_000, -41_209]);
  } finally {
    core.close();
  }
});

test("refiling to or from a transfer creates, moves or removes the other side", () => {
  const { core, budget, checking, visa } = household();
  try {
    const savings = core.createAccount(budget.id, { name: "Savings", type: "savings", startingBalance: 0, startingDate: "2026-11-01" });
    const group = core.createGroup(budget.id, { name: "Everyday" });
    const fuel = core.createBucket(budget.id, { name: "Fuel", groupId: group.id, type: "plain" });
    const spend = core.addTransaction(checking.id, { amount: -5_000, memo: "Oops", category: { kind: "bucket", bucketId: fuel.id } });
    const moved = core.editTransaction(spend.id, { category: transfer(savings.id) });
    assert.equal(moved.category.kind, "transfer");
    assert.deepEqual([core.openAccount(savings.id).balance, core.openBucket(fuel.id).available], [5_000, 0]);
    assert.equal(core.listTransactions(savings.id).transactions[0]!.memo, "Oops");

    core.editTransaction(spend.id, { category: transfer(visa.id) });
    assert.deepEqual([core.openAccount(savings.id).balance, core.openAccount(visa.id).balance], [0, -36_209]);
    assert.equal(core.listTransactions(savings.id).transactions.length, 0);
    assert.throws(() => core.editTransaction(spend.id, { category: transfer(checking.id) }), code("invalid_input"));

    core.editTransaction(spend.id, { category: { kind: "bucket", bucketId: fuel.id } });
    assert.deepEqual([core.openAccount(visa.id).balance, core.openBucket(fuel.id).available], [-41_209, -5_000]);
    assert.equal(core.listTransactions(visa.id).transactions.length, 0);
  } finally {
    core.close();
  }
});

test("a pair whose other account is closed keeps its amount and can't be deleted", () => {
  const { core, budget, checking } = household();
  try {
    const wallet = core.createAccount(budget.id, { name: "Wallet", type: "cash", startingBalance: 0, startingDate: "2026-11-01" });
    // Emptying the wallet into checking leaves it at 0, so it can close.
    core.addTransaction(wallet.id, { amount: 2_000, category: { kind: "income" } });
    const emptied = core.addTransaction(checking.id, { amount: 2_000, category: transfer(wallet.id) });
    core.closeAccount(wallet.id);
    assert.throws(() => core.editTransaction(emptied.id, { amount: 1_000 }), code("account_closed"));
    assert.throws(() => core.deleteTransaction(emptied.id), code("account_closed"));
    assert.equal(core.editTransaction(emptied.id, { memo: "Wallet emptied", date: "2026-11-19" }).memo, "Wallet emptied");
  } finally {
    core.close();
  }
});

test("recent activity is the budget's newest transactions, each transfer once by its money-out side", () => {
  const { core, budget, checking, visa } = household();
  try {
    core.addTransaction(checking.id, { date: "2026-11-10", payee: "Acme", amount: 200_000, category: { kind: "income" } });
    const payment = core.addTransaction(visa.id, { date: "2026-11-12", amount: 41_209, category: transfer(checking.id) });
    const gift = core.addTransaction(visa.id, { date: "2026-11-15", payee: "Cashback", amount: 500, category: { kind: "income" } });
    const recent = core.listBudgetTransactions(budget.id, { limit: 10 });
    assert.equal(recent.length, 3);
    assert.deepEqual(recent.map((row) => [row.accountId, row.amount]), [[visa.id, 500], [checking.id, -41_209], [checking.id, 200_000]]);
    assert.deepEqual(recent[1]!.category, { kind: "transfer", accountId: visa.id, transferId: payment.category.kind === "transfer" ? payment.category.transferId : "" });
    assert.deepEqual(core.listBudgetTransactions(budget.id, { limit: 1 }).map((row) => row.id), [gift.id]);
    for (const limit of [0, 101, 1.5, "5", undefined]) {
      assert.throws(() => core.listBudgetTransactions(budget.id, { limit }), code("invalid_input"), String(limit));
    }
    assert.throws(() => core.listBudgetTransactions("missing", { limit: 5 }), code("not_found"));
  } finally {
    core.close();
  }
});

test("a split refiled as a transfer gives its buckets their money back", () => {
  const { core, budget, checking, visa } = household();
  try {
    const group = core.createGroup(budget.id, { name: "Everyday" });
    const food = core.createBucket(budget.id, { name: "Food", groupId: group.id, type: "plain" });
    const fuel = core.createBucket(budget.id, { name: "Fuel", groupId: group.id, type: "plain" });
    const split = core.addTransaction(checking.id, { amount: -8_000, category: { kind: "split", lines: [
      { bucketId: food.id, amount: -5_000, memo: "" }, { bucketId: fuel.id, amount: -3_000, memo: "" }] } });
    core.editTransaction(split.id, { category: transfer(visa.id) });
    assert.deepEqual([core.openBucket(food.id).available, core.openBucket(fuel.id).available, core.openAccount(visa.id).balance], [0, 0, -33_209]);
  } finally {
    core.close();
  }
});
