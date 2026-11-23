import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetError, openBucketeer } from "../src/core/index.js";

const code = (expected: string) => (error: unknown) => error instanceof BudgetError && error.code === expected;
const income = { kind: "income" } as const;

/**
 * A budget created on 2026-11-20 with Checking at 5,000.00 and two groups: Fixed (Rent, recurring 1,650) and
 * Everyday (Groceries, recurring 600; Vacation, goal 3,000 by 2027-08).
 */
function household() {
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T12:00:00.000Z"), timeZone: "UTC" });
  const budget = core.createBudget({ name: "Household" });
  const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 500_000, startingDate: "2026-11-01" });
  const rent = core.createBucket(budget.id, { name: "Rent", newGroupName: "Fixed", type: "recurring", amount: 165_000 });
  const groceries = core.createBucket(budget.id, { name: "Groceries", newGroupName: "Everyday", type: "recurring", amount: 60_000 });
  const vacation = core.createBucket(budget.id, { name: "Vacation", groupId: groceries.groupId!, type: "goal", amount: 300_000, goalMonth: "2027-08" });
  const spend = (bucketId: string, date: string, amount: number) => core.addTransaction(checking.id, { date, amount, category: { kind: "bucket", bucketId } });
  const row = (month: string, bucketId: string) => core.bucketMonth(budget.id, month).buckets.find((bucket) => bucket.id === bucketId)!;
  return { core, budget, checking, rent, groceries, vacation, spend, row };
}

test("assigning to a bucket adds to its assigned and Available that month and takes it from Ready to assign", () => {
  const { core, budget, rent, row } = household();
  try {
    const assigned = core.assign(rent.id, { month: "2026-11", amount: 165_000 });
    assert.deepEqual([assigned.id, assigned.month, assigned.assigned, assigned.spent, assigned.carriedIn, assigned.available], [rent.id, "2026-11", 165_000, 0, 0, 165_000]);
    assert.equal(core.readyToAssign(budget.id), 335_000);
    assert.deepEqual(row("2026-11", rent.id), assigned);
    // A take is a negative entry; the ledger keeps both.
    core.assign(rent.id, { month: "2026-11", amount: -15_000 });
    assert.deepEqual([row("2026-11", rent.id).assigned, row("2026-11", rent.id).available], [150_000, 150_000]);
    assert.equal(core.readyToAssign(budget.id), 350_000);
    // The money carries into later months but is assigned only in November.
    assert.deepEqual([row("2026-12", rent.id).assigned, row("2026-12", rent.id).carriedIn, row("2026-12", rent.id).available], [0, 150_000, 150_000]);
    assert.deepEqual([row("2026-10", rent.id).assigned, row("2026-10", rent.id).available], [0, 0]);
  } finally {
    core.close();
  }
});

test("assigning beyond Ready to assign, taking beyond the month's positive Available, and archived buckets are refused", () => {
  const { core, budget, rent, groceries, spend, row } = household();
  try {
    assert.throws(() => core.assign(rent.id, { month: "2026-11", amount: 500_001 }),
      (error: unknown) => code("not_enough_ready")(error) && (error as BudgetError).message === "Only $5,000.00 is ready to assign. You can add up to that.");
    core.assign(rent.id, { month: "2026-11", amount: 500_000 });
    assert.throws(() => core.assign(groceries.id, { month: "2026-11", amount: 1 }), code("not_enough_ready"));
    assert.equal(core.readyToAssign(budget.id), 0);

    // Taking: up to the bucket's Available in that month, never from a bucket at or below 0.
    assert.throws(() => core.assign(rent.id, { month: "2026-11", amount: -500_001 }), code("not_enough_available"));
    assert.throws(() => core.assign(rent.id, { month: "2026-10", amount: -1 }), code("not_enough_available"));
    assert.equal(core.assign(rent.id, { month: "2026-11", amount: -500_000 }).available, 0);
    spend(groceries.id, "2026-11-05", -4_000);
    assert.throws(() => core.assign(groceries.id, { month: "2026-11", amount: -1 }), code("not_enough_available"));
    assert.equal(row("2026-11", groceries.id).available, -4_000);

    const archived = core.createBucket(budget.id, { name: "Old", groupId: rent.groupId!, type: "plain" });
    core.archiveBucket(archived.id);
    assert.throws(() => core.assign(archived.id, { month: "2026-11", amount: 100 }), code("bucket_archived"));

    // Any month in the range; the amount is signed whole cents, never 0.
    for (const month of ["2025-10", "2027-12", "nope"]) assert.throws(() => core.assign(rent.id, { month, amount: 100 }), code("invalid_input"), month);
    for (const amount of [0, 1.5, "100", null]) assert.throws(() => core.assign(rent.id, { month: "2026-11", amount }), code("invalid_input"), String(amount));
    assert.throws(() => core.assign(rent.id, { month: "2026-11", amount: 100, rainId: "x" }), code("invalid_input"));
    assert.throws(() => core.assign("missing", { month: "2026-11", amount: 100 }), code("not_found"));
    assert.equal(core.readyToAssign(budget.id), 500_000);
  } finally {
    core.close();
  }
});

test("overspending carries into the next month as a negative carried in and Available", () => {
  const { core, groceries, spend, row } = household();
  try {
    core.assign(groceries.id, { month: "2026-10", amount: 60_000 });
    spend(groceries.id, "2026-10-12", -100_000);
    const october = row("2026-10", groceries.id);
    assert.deepEqual([october.assigned, october.spent, october.available], [60_000, 100_000, -40_000]);
    const november = row("2026-11", groceries.id);
    assert.deepEqual([november.carriedIn, november.assigned, november.spent, november.available], [-40_000, 0, 0, -40_000]);
    core.assign(groceries.id, { month: "2026-11", amount: 60_000 });
    assert.equal(row("2026-11", groceries.id).available, 20_000);
    assert.equal(row("2027-01", groceries.id).carriedIn, 20_000);
  } finally {
    core.close();
  }
});

test("money paid directly into a bucket is assigned to it in the month it is dated, and Spent stays gross", () => {
  const { core, budget, groceries, spend, row } = household();
  try {
    spend(groceries.id, "2026-11-03", -8_000);
    spend(groceries.id, "2026-11-04", 3_000);
    const november = row("2026-11", groceries.id);
    assert.deepEqual([november.assigned, november.spent, november.available], [3_000, 8_000, -5_000]);
    assert.equal(row("2026-10", groceries.id).assigned, 0);
    // A reimbursement doesn't come from Ready to assign.
    assert.equal(core.readyToAssign(budget.id), 500_000);
  } finally {
    core.close();
  }
});

test("assigning into a future month lowers the one Ready to assign every month shows", () => {
  const { core, budget, vacation } = household();
  try {
    core.assign(vacation.id, { month: "2027-02", amount: 30_000 });
    for (const month of ["2025-11", "2026-11", "2027-02", "2027-11"]) assert.equal(core.bucketMonth(budget.id, month).summary.readyToAssign, 470_000, month);
    assert.equal(core.readyToAssign(budget.id), 470_000);
    // Future money isn't in the bucket yet.
    assert.equal(core.openBucket(vacation.id).available, 0);
  } finally {
    core.close();
  }
});

test("group totals are the sums of the buckets the group shows that month, and every group is listed", () => {
  const { core, budget, rent, groceries, vacation, spend } = household();
  try {
    core.createGroup(budget.id, { name: "Empty" });
    core.assign(rent.id, { month: "2026-11", amount: 165_000 });
    core.assign(groceries.id, { month: "2026-11", amount: 60_000 });
    core.assign(vacation.id, { month: "2026-10", amount: 30_000 });
    spend(groceries.id, "2026-11-09", -7_525);
    spend(vacation.id, "2026-11-10", 1_000);
    const view = core.bucketMonth(budget.id, "2026-11");
    assert.deepEqual(view.groups.map((group) => [group.name, group.assigned, group.spent, group.available]), [
      ["Fixed", 165_000, 0, 165_000],
      ["Everyday", 61_000, 7_525, 83_475],
      ["Empty", 0, 0, 0],
    ]);
    assert.deepEqual(view.buckets.map((bucket) => bucket.name), ["Rent", "Groceries", "Vacation"]);
    assert.throws(() => core.bucketMonth(budget.id, "2028-01"), code("invalid_input"));
    assert.throws(() => core.bucketMonth("missing", "2026-11"), code("not_found"));
  } finally {
    core.close();
  }
});

test("an archived bucket appears only in the months it has a transaction or a ledger entry", () => {
  const { core, budget, groceries, spend } = household();
  try {
    const gifts = core.createBucket(budget.id, { name: "Gifts", groupId: groceries.groupId!, type: "plain" });
    spend(gifts.id, "2026-09-14", 2_500);
    core.assign(gifts.id, { month: "2026-10", amount: 1_000 });
    core.assign(gifts.id, { month: "2026-10", amount: -1_000 });
    spend(gifts.id, "2026-11-02", -2_500);
    core.archiveBucket(gifts.id);
    const names = (month: string) => core.bucketMonth(budget.id, month).buckets.map((bucket) => bucket.name);
    assert.deepEqual(names("2026-08"), ["Rent", "Groceries", "Vacation"]);
    assert.deepEqual(names("2026-09"), ["Rent", "Groceries", "Vacation", "Gifts"]);
    assert.deepEqual(names("2026-10"), ["Rent", "Groceries", "Vacation", "Gifts"]);
    assert.deepEqual(names("2026-11"), ["Rent", "Groceries", "Vacation", "Gifts"]);
    assert.deepEqual(names("2026-12"), ["Rent", "Groceries", "Vacation"]);
    const november = core.bucketMonth(budget.id, "2026-11");
    assert.deepEqual(november.groups.find((group) => group.id === groceries.groupId)!.spent, 2_500);
    assert.equal(november.buckets.at(-1)!.archived, true);
  } finally {
    core.close();
  }
});

test("the month summary counts Income, Assigned and Spent in that month, with money paid into buckets on both sides", () => {
  const { core, budget, checking, rent, groceries, vacation, spend } = household();
  const summary = (month: string) => core.bucketMonth(budget.id, month).summary;
  try {
    core.addTransaction(checking.id, { date: "2026-11-02", amount: 200_000, category: income });
    core.addTransaction(checking.id, { date: "2026-10-15", amount: 10_000, category: income });
    core.assign(rent.id, { month: "2026-11", amount: 165_000 });
    core.assign(vacation.id, { month: "2026-12", amount: 30_000 });
    spend(groceries.id, "2026-11-03", -8_000);
    spend(groceries.id, "2026-10-20", -2_000);
    core.addTransaction(checking.id, { date: "2026-11-04", amount: -5_000, category: { kind: "split", lines: [
      { bucketId: groceries.id, amount: -4_000, memo: "" }, { bucketId: rent.id, amount: -1_000, memo: "" },
    ] } });
    assert.deepEqual(summary("2026-11"), { month: "2026-11", readyToAssign: 515_000, income: 200_000, assigned: 165_000, spent: 13_000 });

    // A 30.00 reimbursement raises Income and Assigned by 30.00; Spent stays gross; Ready to assign doesn't move.
    spend(groceries.id, "2026-11-05", 3_000);
    assert.deepEqual(summary("2026-11"), { month: "2026-11", readyToAssign: 515_000, income: 203_000, assigned: 168_000, spent: 13_000 });

    assert.deepEqual(summary("2026-10"), { month: "2026-10", readyToAssign: 515_000, income: 10_000, assigned: 0, spent: 2_000 });
    assert.deepEqual(summary("2026-12"), { month: "2026-12", readyToAssign: 515_000, income: 0, assigned: 30_000, spent: 0 });
    // Money that moved through a bucket since archived still counts in its month.
    const old = core.createBucket(budget.id, { name: "Old", groupId: rent.groupId!, type: "plain" });
    spend(old.id, "2026-09-10", -1_000);
    spend(old.id, "2026-09-12", 1_000);
    core.archiveBucket(old.id);
    assert.deepEqual(summary("2026-09"), { month: "2026-09", readyToAssign: 515_000, income: 1_000, assigned: 1_000, spent: 1_000 });
  } finally {
    core.close();
  }
});

test("archiving a bucket with money returns it to Ready to assign with a take in the current month", () => {
  const { core, budget, groceries, spend, row } = household();
  try {
    const clothing = core.createBucket(budget.id, { name: "Clothing", groupId: groceries.groupId!, type: "plain" });
    core.assign(clothing.id, { month: "2026-10", amount: 20_000 });
    spend(clothing.id, "2026-11-03", -1_347);
    assert.equal(core.readyToAssign(budget.id), 480_000);
    const result = core.archiveBucket(clothing.id);
    assert.deepEqual([result.returned, result.bucket.archived, result.bucket.available], [18_653, true, 0]);
    assert.equal(core.readyToAssign(budget.id), 498_653);
    // The take is booked in November, so October keeps its history.
    assert.deepEqual([row("2026-11", clothing.id).assigned, row("2026-11", clothing.id).available], [-18_653, 0]);
    assert.equal(row("2026-10", clothing.id).available, 20_000);
    // Restoring doesn't put the money back.
    assert.equal(core.restoreBucket(clothing.id).available, 0);
    assert.equal(core.readyToAssign(budget.id), 498_653);
    // A bucket at 0 archives with nothing returned.
    assert.equal(core.archiveBucket(clothing.id).returned, 0);
    assert.equal(core.readyToAssign(budget.id), 498_653);
  } finally {
    core.close();
  }
});

test("over every month, the change in Ready to assign is strip Income − strip Assigned", () => {
  const { core, budget, checking, rent, groceries, spend } = household();
  try {
    const before = core.readyToAssign(budget.id);
    core.addTransaction(checking.id, { date: "2026-10-02", amount: 120_000, category: income });
    core.addTransaction(checking.id, { date: "2026-11-02", amount: 80_000, category: income });
    core.assign(rent.id, { month: "2026-11", amount: 165_000 });
    core.assign(groceries.id, { month: "2026-10", amount: 40_000 });
    core.assign(groceries.id, { month: "2027-01", amount: 20_000 });
    spend(groceries.id, "2026-11-05", 3_000);
    spend(groceries.id, "2026-11-06", -9_000);
    let change = 0;
    for (const month of ["2026-10", "2026-11", "2026-12", "2027-01"]) {
      const { income: money, assigned } = core.bucketMonth(budget.id, month).summary;
      change += money - assigned;
    }
    // 120,000 + 80,000 − 165,000 − 40,000 − 20,000
    assert.equal(change, -25_000);
    assert.equal(core.readyToAssign(budget.id) - before, -25_000);
  } finally {
    core.close();
  }
});

test("archiving is refused while a bucket is overspent or has entries in a future month", () => {
  const { core, budget, groceries, spend } = household();
  try {
    const gifts = core.createBucket(budget.id, { name: "Gifts", groupId: groceries.groupId!, type: "plain" });
    core.assign(gifts.id, { month: "2026-12", amount: 5_000 });
    assert.throws(() => core.archiveBucket(gifts.id), (error: unknown) => error instanceof BudgetError && error.code === "bucket_has_future" && error.message === "Gifts has money assigned in December.");
    core.assign(gifts.id, { month: "2026-12", amount: -5_000 });
    assert.throws(() => core.archiveBucket(gifts.id), code("bucket_has_future"));
    const later = core.createBucket(budget.id, { name: "Later", groupId: groceries.groupId!, type: "plain" });
    core.assign(later.id, { month: "2027-11", amount: 100 });
    assert.throws(() => core.archiveBucket(later.id), (error: unknown) => error instanceof BudgetError && error.message === "Later has money assigned in November 2027.");
    spend(groceries.id, "2026-11-04", -100);
    assert.throws(() => core.archiveBucket(groceries.id), code("bucket_overspent"));
    assert.equal(core.readyToAssign(budget.id), 499_900);
  } finally {
    core.close();
  }
});

test("a take is refused when a later month carrying the money would be left overspent", () => {
  const { core, budget, groceries, spend, row } = household();
  try {
    // October's 100.00 carries into November, where 80.00 of it is spent.
    core.assign(groceries.id, { month: "2026-10", amount: 10_000 });
    spend(groceries.id, "2026-11-05", -8_000);
    assert.equal(row("2026-10", groceries.id).available, 10_000);
    assert.equal(row("2026-11", groceries.id).available, 2_000);
    // The month view says how much a take can be: the lowest Available from that month on.
    assert.deepEqual([row("2026-10", groceries.id).takeable, row("2026-11", groceries.id).takeable], [2_000, 2_000]);
    assert.throws(() => core.assign(groceries.id, { month: "2026-10", amount: -2_001 }),
      (error: unknown) => code("not_enough_available")(error) && (error as BudgetError).message === "Groceries has $20.00 available. You can take up to that.");
    assert.equal(core.assign(groceries.id, { month: "2026-10", amount: -2_000 }).available, 8_000);
    assert.equal(row("2026-11", groceries.id).available, 0);
    assert.equal(row("2026-10", groceries.id).takeable, 0);

    // A take in this month also answers to a future month's entries.
    core.assign(groceries.id, { month: "2026-11", amount: 5_000 });
    core.assign(groceries.id, { month: "2027-01", amount: -3_000 });
    assert.deepEqual([row("2026-11", groceries.id).available, row("2026-11", groceries.id).takeable], [5_000, 2_000]);
    assert.throws(() => core.assign(groceries.id, { month: "2026-11", amount: -2_001 }), code("not_enough_available"));
    assert.equal(core.assign(groceries.id, { month: "2026-11", amount: -2_000 }).available, 3_000);
    assert.equal(core.readyToAssign(budget.id), 500_000 - 10_000 + 2_000 - 5_000 + 3_000 + 2_000);
  } finally {
    core.close();
  }
});
