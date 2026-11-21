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
      (error: unknown) => code("not_enough_ready")(error) && (error as BudgetError).message === "Only $5,000.00 is ready to assign.");
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
