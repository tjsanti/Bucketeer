import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetError, openBucketeer } from "../src/core/index.js";

const code = (expected: string) => (error: unknown) => error instanceof BudgetError && error.code === expected;

/**
 * A budget created on 2026-11-20. Rent (recurring 1,650, already assigned this month) above Fuel (recurring 160)
 * above Vacation (goal 3,000 by 2027-08, so 10 months left including November) above Clothing (plain), with
 * `ready` left in Ready to assign.
 */
function household(ready: number) {
  const core = openBucketeer(":memory:", { now: () => new Date("2026-11-20T12:00:00.000Z"), timeZone: "UTC" });
  const budget = core.createBudget({ name: "Household" });
  const checking = core.createAccount(budget.id, { name: "Checking", type: "checking", startingBalance: 165_000 + ready, startingDate: "2026-11-01" });
  const rent = core.createBucket(budget.id, { name: "Rent", newGroupName: "Fixed", type: "recurring", amount: 165_000 });
  const fuel = core.createBucket(budget.id, { name: "Fuel", groupId: rent.groupId!, type: "recurring", amount: 16_000 });
  const vacation = core.createBucket(budget.id, { name: "Vacation", newGroupName: "Saving", type: "goal", amount: 300_000, goalMonth: "2027-08" });
  const clothing = core.createBucket(budget.id, { name: "Clothing", groupId: vacation.groupId!, type: "plain" });
  core.assign(rent.id, { month: "2026-11", amount: 165_000 });
  const spend = (bucketId: string, date: string, amount: number) => core.addTransaction(checking.id, { date, amount, category: { kind: "bucket", bucketId } });
  const row = (month: string, bucketId: string) => core.bucketMonth(budget.id, month).buckets.find((bucket) => bucket.id === bucketId)!;
  return { core, budget, checking, rent, fuel, vacation, clothing, spend, row };
}

test("rain fills each bucket's need in bucket order and leaves the rest ready", () => {
  const { core, budget, fuel, vacation, clothing, rent, row } = household(170_000);
  try {
    assert.deepEqual([rent, fuel, vacation, clothing].map((bucket) => row("2026-11", bucket.id).need), [0, 16_000, 30_000, 0]);
    const rain = core.rain(budget.id, "2026-11");
    assert.deepEqual([rain.fills, rain.total], [[{ bucketId: fuel.id, amount: 16_000 }, { bucketId: vacation.id, amount: 30_000 }], 46_000]);
    assert.equal(typeof rain.rainId, "string");
    assert.equal(core.readyToAssign(budget.id), 124_000);
    assert.deepEqual([row("2026-11", fuel.id).assigned, row("2026-11", vacation.id).available, row("2026-11", clothing.id).assigned], [16_000, 30_000, 0]);
    assert.deepEqual([fuel, vacation].map((bucket) => row("2026-11", bucket.id).need), [0, 0]);
  } finally {
    core.close();
  }
});

test("when the money runs out, that bucket gets a partial fill and the buckets below get nothing", () => {
  const { core, budget, fuel, vacation } = household(40_000);
  try {
    const rain = core.rain(budget.id, "2026-11");
    assert.deepEqual([rain.fills, rain.total], [[{ bucketId: fuel.id, amount: 16_000 }, { bucketId: vacation.id, amount: 24_000 }], 40_000]);
    assert.equal(core.readyToAssign(budget.id), 0);
  } finally {
    core.close();
  }
});

test("a second rain in the same month gives nothing, and with nothing ready nothing is written", () => {
  const { core, budget, fuel, row } = household(170_000);
  try {
    core.rain(budget.id, "2026-11");
    assert.deepEqual([core.rain(budget.id, "2026-11").fills, core.rain(budget.id, "2026-11").total], [[], 0]);
    assert.equal(core.readyToAssign(budget.id), 124_000);
    // With Ready to assign at 0 (or below), even buckets with a need get nothing.
    core.assign(fuel.id, { month: "2026-12", amount: 124_000 });
    assert.equal(row("2026-12", fuel.id).need, 0);
    const empty = core.rain(budget.id, "2026-12");
    assert.deepEqual([empty.fills, empty.total], [[], 0]);
    assert.equal(core.readyToAssign(budget.id), 0);
    assert.equal("rainId" in empty, false);
  } finally {
    core.close();
  }
});

test("an overspent recurring bucket gets only its monthly need and stays below its monthly amount", () => {
  const { core, budget, fuel, vacation, spend, row } = household(500_000);
  try {
    // Fuel overspent by 40 in October carries in at −40; rain still gives it just 160 in November.
    spend(fuel.id, "2026-10-10", -4_000);
    const rain = core.rain(budget.id, "2026-11");
    assert.equal(rain.fills.find((fill) => fill.bucketId === fuel.id)?.amount, 16_000);
    assert.equal(row("2026-11", fuel.id).available, 12_000);

    assert.ok(row("2026-11", fuel.id).available < 16_000);
  } finally {
    core.close();
  }
});

test("an overdue goal needs its whole remainder", () => {
  const { core, budget, vacation, row } = household(500_000);
  try {
    // Due in December: November's share is half, and in January (overdue) the whole of what's left.
    core.editBucket(vacation.id, { type: "goal", amount: 300_000, goalMonth: "2026-12" });
    assert.equal(row("2026-11", vacation.id).need, 150_000);
    core.assign(vacation.id, { month: "2026-11", amount: 100_000 });
    assert.equal(row("2027-01", vacation.id).need, 200_000);
    assert.equal(core.planRain(budget.id, "2027-01").fills.find((fill) => fill.bucketId === vacation.id)?.amount, 200_000);
  } finally {
    core.close();
  }
});

test("rain is only for the current month or later, inside the range, and a later month draws from the same pool", () => {
  const { core, budget, rent, fuel, row } = household(170_000);
  try {
    for (const month of ["2026-10", "2027-12", "2026-13"]) assert.throws(() => core.rain(budget.id, month), code("invalid_input"), month);
    assert.throws(() => core.planRain(budget.id, "2026-10"), code("invalid_input"));
    assert.throws(() => core.rain("missing", "2026-11"), code("not_found"));
    // Three months ahead nothing is assigned yet, so Rent needs its 1,650 again and Fuel gets the last 50.
    const rain = core.rain(budget.id, "2027-02");
    assert.deepEqual(rain.fills, [{ bucketId: rent.id, amount: 165_000 }, { bucketId: fuel.id, amount: 5_000 }]);
    assert.equal(core.readyToAssign(budget.id), 0);
    assert.deepEqual(core.rain(budget.id, "2026-11").fills, []);
    assert.equal(row("2027-02", fuel.id).assigned, 5_000);
    assert.equal(row("2026-11", fuel.id).assigned, 0);
  } finally {
    core.close();
  }
});

test("the preview writes nothing and is exactly what rain applies", () => {
  const { core, budget } = household(40_000);
  try {
    const preview = core.planRain(budget.id, "2026-11");
    assert.equal(core.readyToAssign(budget.id), 40_000);
    assert.deepEqual(core.planRain(budget.id, "2026-11"), preview);
    const { rainId, ...applied } = core.rain(budget.id, "2026-11");
    assert.ok(rainId);
    assert.deepEqual(applied, preview);
  } finally {
    core.close();
  }
});

test("undo reverses the whole rain, or is refused with money_moved once a filled bucket holds less than its fill", () => {
  const { core, budget, fuel, vacation, spend, row } = household(170_000);
  try {
    const first = core.rain(budget.id, "2026-11");
    core.undoRain(first.rainId!);
    assert.equal(core.readyToAssign(budget.id), 170_000);
    assert.deepEqual([row("2026-11", fuel.id).assigned, row("2026-11", vacation.id).assigned], [0, 0]);
    assert.throws(() => core.undoRain(first.rainId!), code("not_found"));

    const second = core.rain(budget.id, "2026-11");
    spend(fuel.id, "2026-11-15", -1);
    assert.throws(() => core.undoRain(second.rainId!), code("money_moved"));
    // Refused whole: Vacation keeps its fill too.
    assert.deepEqual([row("2026-11", vacation.id).assigned, core.readyToAssign(budget.id)], [30_000, 124_000]);
  } finally {
    core.close();
  }
});

test("undo is refused with money_moved when a later month would be left with less than the fill", () => {
  const { core, budget, fuel, row } = household(16_000);
  try {
    const rain = core.rain(budget.id, "2026-11");
    // December takes Fuel's money back, so November still shows the fill but December holds none of it.
    core.assign(fuel.id, { month: "2026-12", amount: -16_000 });
    assert.equal(row("2026-11", fuel.id).available, 16_000);
    assert.throws(() => core.undoRain(rain.rainId!), code("money_moved"));
    assert.equal(row("2026-12", fuel.id).available, 0);
  } finally {
    core.close();
  }
});
