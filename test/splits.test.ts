import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetError, openBucketeer } from "../src/core/index.js";

const code = (expected: string) => (error: unknown) => error instanceof BudgetError && error.code === expected;

/** Checking at 1,000.00 and Visa at −412.09, with plain buckets A and B; the clock reads 2026-11-20. */
function household() {
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T12:00:00.000Z"), timeZone: "UTC" });
  const budget = core.createBudget({ name: "Household" });
  const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" });
  const visa = core.createAccount(budget.id, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });
  const group = core.createGroup(budget.id, { name: "Everyday" });
  const a = core.createBucket(budget.id, { name: "Groceries", groupId: group.id, type: "plain" });
  const b = core.createBucket(budget.id, { name: "Household", groupId: group.id, type: "plain" });
  // A bucket's figures this month.
  const now = (bucketId: string) => core.bucketMonth(budget.id, "2026-11").buckets.find((bucket) => bucket.id === bucketId)!;
  return { core, budget, checking, visa, a, b, now };
}

const split = (...lines: [string, number, string?][]) => ({
  kind: "split",
  lines: lines.map(([bucketId, amount, memo]) => ({ bucketId, amount, memo: memo ?? "" })),
});

test("a −80 split as −50 and −30 draws each line from its own bucket", () => {
  const { core, budget, visa, a, b, now } = household();
  try {
    const shop = core.addTransaction(visa.id, { payee: "Superstore", amount: -8_000, category: split([a.id, -5_000, " food "], [b.id, -3_000]) });
    assert.deepEqual(shop.category, { kind: "split", lines: [{ bucketId: a.id, amount: -5_000, memo: "food" }, { bucketId: b.id, amount: -3_000, memo: "" }] });
    assert.deepEqual(core.openTransaction(shop.id), shop);
    assert.deepEqual([now(a.id).available, now(a.id).spent], [-5_000, 5_000]);
    assert.deepEqual([now(b.id).available, now(b.id).spent], [-3_000, 3_000]);
    assert.equal(core.openAccount(visa.id).balance, -49_209);
    assert.equal(core.readyToAssign(budget.id), 58_791);
    assert.deepEqual(core.listTransactions(visa.id).transactions[0]?.category, shop.category);
  } finally {
    core.close();
  }
});

test("a split's lines must sum to the amount, share its sign, number at least two and be buckets", () => {
  const { core, visa, checking, a, b, now } = household();
  try {
    const refused = [
      split([a.id, -5_000], [b.id, -2_000]),
      split([a.id, -10_000], [b.id, 2_000]),
      split([a.id, -8_000]),
      { kind: "split", lines: [] },
      { kind: "split" },
      split([a.id, -8_000], [b.id, 0]),
      split([a.id, -4_000.5], [b.id, -3_999.5]),
      { kind: "split", lines: [{ bucketId: a.id, amount: -5_000 }, { bucketId: b.id, amount: -3_000, memo: "" }] },
      { kind: "split", lines: [{ kind: "income", amount: -5_000, memo: "" }, { bucketId: b.id, amount: -3_000, memo: "" }] },
      { kind: "split", lines: [{ bucketId: a.id, amount: -5_000, memo: "", extra: 1 }, { bucketId: b.id, amount: -3_000, memo: "" }] },
      split([a.id, -5_000, "x".repeat(501)], [b.id, -3_000]),
    ];
    for (const category of refused) {
      assert.throws(() => core.addTransaction(visa.id, { amount: -8_000, category }), code("invalid_input"), JSON.stringify(category).slice(0, 120));
    }
    assert.throws(() => core.addTransaction(visa.id, { amount: -8_000, category: split([a.id, -5_000], ["missing", -3_000]) }), code("not_found"));
    // A positive split works the same way: each line is money into its bucket.
    core.addTransaction(checking.id, { amount: 3_000, category: split([a.id, 1_000], [b.id, 2_000]) });
    assert.deepEqual([now(a.id).available, now(a.id).spent], [1_000, 0]);
    // The same bucket twice is allowed; both lines count.
    core.addTransaction(visa.id, { amount: -300, category: split([b.id, -100], [b.id, -200]) });
    assert.equal(core.openBucket(b.id).available, 1_700);
  } finally {
    core.close();
  }
});

test("a split refuses archived buckets on new lines but keeps ones already filed", () => {
  const { core, budget, visa, checking, a, b } = household();
  try {
    const group = core.listBucketTable(budget.id).groups[0]!;
    const c = core.createBucket(budget.id, { name: "Gifts", groupId: group.id, type: "plain" });
    const old = core.addTransaction(visa.id, { amount: -800, category: split([a.id, -500], [c.id, -300]) });
    core.addTransaction(checking.id, { amount: 300, category: { kind: "bucket", bucketId: c.id } });
    core.archiveBucket(c.id);
    assert.throws(() => core.addTransaction(visa.id, { amount: -800, category: split([a.id, -500], [c.id, -300]) }), code("bucket_archived"));
    assert.equal(core.editTransaction(old.id, { memo: "kept" }).memo, "kept");
    // Re-sending the same lines with other amounts keeps the archived bucket.
    core.editTransaction(old.id, { amount: -900, category: split([a.id, -600], [c.id, -300]) });
    // Adding the archived bucket to a split that didn't have it is refused.
    const other = core.addTransaction(visa.id, { amount: -800, category: split([a.id, -500], [b.id, -300]) });
    assert.throws(() => core.editTransaction(other.id, { category: split([a.id, -500], [c.id, -300]) }), code("bucket_archived"));
  } finally {
    core.close();
  }
});

test("editing a split moves money between buckets, and the edit can be put back", () => {
  const { core, visa, a, b } = household();
  try {
    const shop = core.addTransaction(visa.id, { amount: -8_000, category: split([a.id, -5_000], [b.id, -3_000]) });
    // Changing the amount alone leaves the lines unbalanced.
    assert.throws(() => core.editTransaction(shop.id, { amount: -9_000 }), code("invalid_input"));
    const edited = core.editTransaction(shop.id, { amount: -9_000, category: split([a.id, -2_000], [b.id, -7_000]) });
    assert.deepEqual(edited.category, split([a.id, -2_000], [b.id, -7_000]));
    assert.deepEqual([core.openBucket(a.id).available, core.openBucket(b.id).available], [-2_000, -7_000]);
    // Undo is a PATCH back to the earlier fields.
    core.editTransaction(shop.id, { amount: shop.amount, category: shop.category });
    assert.deepEqual([core.openBucket(a.id).available, core.openBucket(b.id).available], [-5_000, -3_000]);
    // Turning the split into one bucket clears its lines, and back again.
    core.editTransaction(shop.id, { category: { kind: "bucket", bucketId: b.id } });
    assert.deepEqual([core.openBucket(a.id).available, core.openBucket(b.id).available], [0, -8_000]);
    assert.deepEqual(core.editTransaction(shop.id, { category: shop.category }).category, shop.category);
    core.deleteTransaction(shop.id);
    assert.deepEqual([core.openBucket(a.id).available, core.openBucket(b.id).available], [0, 0]);
  } finally {
    core.close();
  }
});

test("payees remember a split with its lines", () => {
  const { core, budget, visa, a, b } = household();
  try {
    const shop = core.addTransaction(visa.id, { payee: "Superstore", amount: -8_000, category: split([a.id, -5_000], [b.id, -3_000]) });
    assert.deepEqual(core.payees(budget.id), [{ payee: "Superstore", category: shop.category }]);
  } finally {
    core.close();
  }
});
