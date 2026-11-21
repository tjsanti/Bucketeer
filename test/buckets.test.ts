import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BUCKET_COLOURS, isBucketColour, leastUsedColour } from "../src/core/colours.js";
import { BudgetError, openBucketeer } from "../src/core/index.js";

const code = (expected: string, message?: RegExp) => (error: unknown) =>
  error instanceof BudgetError && error.code === expected && (!message || message.test(error.message));

// A mutable injected clock. Mid-month and midday, so local and UTC months agree.
function setup(start = "2026-11-20T12:00:00.000Z") {
  let now = new Date(start);
  const core = openBucketeer(":memory:", { now: () => now });
  const budget = core.createBudget({ name: "Household" });
  return { core, budget, setNow: (iso: string) => { now = new Date(iso); } };
}

test("colours: palette order and the least-used rule", () => {
  assert.deepEqual([...BUCKET_COLOURS], ["sky", "denim", "blue", "slate", "teal", "mint", "green", "forest", "lime", "olive", "sun", "cocoa", "peach", "tangerine", "rose", "plum"]);
  assert.equal(leastUsedColour([]), "sky");
  assert.equal(leastUsedColour([{ colour: "sky" }]), "denim");
  assert.equal(leastUsedColour([{ colour: "denim" }]), "sky");
  assert.equal(leastUsedColour(BUCKET_COLOURS.map((colour) => ({ colour }))), "sky");
  assert.equal(leastUsedColour([...BUCKET_COLOURS.map((colour) => ({ colour })), { colour: "sky" }, { colour: "blue" }]), "denim");
  assert.equal(leastUsedColour(BUCKET_COLOURS.filter((colour) => colour !== "plum").map((colour) => ({ colour }))), "plum");
  assert.ok(isBucketColour("plum"));
  for (const value of ["pink", "Sky", "", null, 3]) assert.equal(isBucketColour(value), false);
});

test("groups are created in order, renamed, unique per budget ignoring case, and scoped to their budget", () => {
  const { core, budget } = setup();
  try {
    assert.deepEqual(core.listBucketTable(budget.id), { groups: [], buckets: [] });
    const fixed = core.createGroup(budget.id, { name: "  Fixed " });
    assert.deepEqual(fixed, { id: fixed.id, budgetId: budget.id, name: "Fixed", order: 1, createdAt: "2026-11-20T12:00:00.000Z", updatedAt: "2026-11-20T12:00:00.000Z" });
    const everyday = core.createGroup(budget.id, { name: "Everyday" });
    assert.equal(everyday.order, 2);
    assert.throws(() => core.createGroup(budget.id, { name: "FIXED" }), code("name_taken"));
    assert.throws(() => core.renameGroup(everyday.id, { name: "fixed" }), code("name_taken"));
    assert.equal(core.renameGroup(fixed.id, { name: "FIXED" }).name, "FIXED");
    const other = core.createBudget({ name: "Other" });
    assert.equal(core.createGroup(other.id, { name: "Fixed" }).order, 1);
    assert.deepEqual(core.listBucketTable(budget.id).groups.map((group) => group.name), ["FIXED", "Everyday"]);
    for (const input of [null, {}, { name: "" }, { name: "x".repeat(61) }, { name: "a\0" }, { name: 5 }, { name: "X", order: 1 }, { name: "X", id: "x" }]) {
      assert.throws(() => core.createGroup(budget.id, input), code("invalid_input"), JSON.stringify(input));
      assert.throws(() => core.renameGroup(fixed.id, input), code("invalid_input"), JSON.stringify(input));
    }
    assert.doesNotThrow(() => core.createGroup(budget.id, { name: "🪣".repeat(60) }));
    assert.throws(() => core.createGroup("missing", { name: "X" }), code("not_found"));
    assert.throws(() => core.renameGroup("missing", { name: "X" }), code("not_found"));
    assert.throws(() => core.listBucketTable("missing"), code("not_found"));
  } finally {
    core.close();
  }
});

test("type shapes after create and edit, keeping the amount where it still applies", () => {
  const { core, budget } = setup();
  try {
    const group = core.createGroup(budget.id, { name: "Fixed" });
    const rent = core.createBucket(budget.id, { name: "Rent", groupId: group.id, type: "recurring", amount: 165_000 });
    assert.deepEqual(rent, {
      id: rent.id, budgetId: budget.id, groupId: group.id, name: "Rent", colour: "sky", type: "recurring", amount: 165_000, goalMonth: null,
      available: 0, spent: 0, order: 1, archived: false, archivedAt: null, createdAt: "2026-11-20T12:00:00.000Z", updatedAt: "2026-11-20T12:00:00.000Z",
    });
    const plain = core.createBucket(budget.id, { name: "Clothing", groupId: group.id, type: "plain" });
    assert.deepEqual([plain.type, plain.amount, plain.goalMonth], ["plain", null, null]);
    assert.deepEqual([core.createBucket(budget.id, { name: "Gifts", groupId: group.id, type: "plain", amount: null, goalMonth: null }).amount], [null]);

    // recurring -> goal keeps the amount and needs a month; goal -> recurring keeps it and drops the month.
    assert.throws(() => core.editBucket(rent.id, { type: "goal" }), code("invalid_input"));
    const goal = core.editBucket(rent.id, { type: "goal", goalMonth: "2027-01" });
    assert.deepEqual([goal.type, goal.amount, goal.goalMonth], ["goal", 165_000, "2027-01"]);
    const recurring = core.editBucket(rent.id, { type: "recurring" });
    assert.deepEqual([recurring.type, recurring.amount, recurring.goalMonth], ["recurring", 165_000, null]);
    assert.equal(core.editBucket(rent.id, { amount: 170_000 }).amount, 170_000);
    // -> plain clears both; plain -> recurring needs an amount again.
    const cleared = core.editBucket(rent.id, { type: "plain" });
    assert.deepEqual([cleared.type, cleared.amount, cleared.goalMonth], ["plain", null, null]);
    assert.throws(() => core.editBucket(rent.id, { type: "recurring" }), code("invalid_input"));
    assert.equal(core.editBucket(rent.id, { type: "recurring", amount: 1 }).amount, 1);

    for (const input of [
      { type: "recurring" }, { type: "recurring", amount: 0 }, { type: "recurring", amount: -5 }, { type: "recurring", amount: 1.5 },
      { type: "recurring", amount: 100_000_000_000 }, { type: "recurring", amount: "100" }, { type: "recurring", amount: 100, goalMonth: "2027-01" },
      { type: "goal", amount: 100 }, { type: "goal", goalMonth: "2027-01" }, { type: "goal", amount: 100, goalMonth: null },
      { type: "plain", amount: 100 }, { type: "plain", goalMonth: "2027-01" }, { type: "Plain" }, { type: "bogus" }, {},
    ]) {
      assert.throws(() => core.createBucket(budget.id, { name: "Bad", groupId: group.id, ...input }), code("invalid_input"), JSON.stringify(input));
    }
    assert.throws(() => core.editBucket(plain.id, { amount: 100 }), code("invalid_input"));
    assert.throws(() => core.editBucket(plain.id, { goalMonth: "2027-01" }), code("invalid_input"));
    assert.equal(core.createBucket(budget.id, { name: "Max", groupId: group.id, type: "recurring", amount: 99_999_999_999 }).amount, 99_999_999_999);
  } finally {
    core.close();
  }
});

test("a goal month is checked against the injected current month only when it is set or changed", () => {
  const { core, budget, setNow } = setup("2026-11-15T12:00:00.000Z");
  try {
    const group = core.createGroup(budget.id, { name: "Goals" });
    const make = (name: string, goalMonth: unknown) => core.createBucket(budget.id, { name, groupId: group.id, type: "goal", amount: 300_000, goalMonth });
    assert.throws(() => make("Past", "2026-10"), code("invalid_input"));
    for (const month of ["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", "Nov 2026", 202611]) assert.throws(() => make("Bad", month), code("invalid_input"), String(month));
    const thisMonth = make("Now", "2026-11");
    const vacation = make("Vacation", "2026-12");
    assert.equal(thisMonth.goalMonth, "2026-11");

    // Time passes: both goals are overdue but still editable, including resending the same month.
    setNow("2027-02-10T12:00:00.000Z");
    assert.equal(core.editBucket(vacation.id, { name: "Trip" }).goalMonth, "2026-12");
    assert.equal(core.editBucket(vacation.id, { amount: 350_000, goalMonth: "2026-12" }).amount, 350_000);
    assert.equal(core.editBucket(vacation.id, { colour: "plum" }).colour, "plum");
    // Changing it to another past month, or setting one on a switch to goal, is refused.
    assert.throws(() => core.editBucket(vacation.id, { goalMonth: "2027-01" }), code("invalid_input"));
    assert.throws(() => core.editBucket(vacation.id, { goalMonth: "2020-01" }), code("invalid_input"));
    assert.equal(core.editBucket(vacation.id, { goalMonth: "2027-02" }).goalMonth, "2027-02");
    const rent = core.createBucket(budget.id, { name: "Rent", groupId: group.id, type: "recurring", amount: 100 });
    assert.throws(() => core.editBucket(rent.id, { type: "goal", goalMonth: "2027-01" }), code("invalid_input"));
    assert.equal(core.editBucket(rent.id, { type: "goal", goalMonth: "2027-03" }).goalMonth, "2027-03");
    assert.equal(core.openBucket(vacation.id).updatedAt, "2027-02-10T12:00:00.000Z");
  } finally {
    core.close();
  }
});

test("revertBucket only lets the month from before the undone edit be past", () => {
  const { core, budget, setNow } = setup("2026-06-10T12:00:00.000Z");
  try {
    const group = core.createGroup(budget.id, { name: "Goals" });
    const trip = core.createBucket(budget.id, { name: "Trip", groupId: group.id, type: "goal", amount: 300_000, goalMonth: "2026-06" });
    const future = core.createBucket(budget.id, { name: "Car", groupId: group.id, type: "goal", amount: 500_000, goalMonth: "2027-01" });
    setNow("2026-11-20T12:00:00.000Z");
    // Overdue goal -> recurring: the old past month is restorable, any other past month is not.
    const recurring = core.editBucket(trip.id, { type: "recurring" });
    assert.throws(() => core.revertBucket(trip.id, { type: "goal", amount: 300_000, goalMonth: "2020-01", revertOf: recurring.updatedAt }), code("invalid_input", /past/));
    const back = core.revertBucket(trip.id, { type: "goal", amount: 300_000, goalMonth: "2026-06", revertOf: recurring.updatedAt });
    assert.deepEqual([back.type, back.goalMonth], ["goal", "2026-06"]);
    // A different past month on an otherwise valid revert is refused, with the month field.
    const moved = core.editBucket(trip.id, { goalMonth: "2027-03" });
    assert.throws(() => core.revertBucket(trip.id, { goalMonth: "2020-01", revertOf: moved.updatedAt }), (error: unknown) =>
      error instanceof BudgetError && error.code === "invalid_input" && error.field === "month");
    assert.equal(core.openBucket(trip.id).goalMonth, "2027-03");
    // The previous month was in the future, so no past month is restorable.
    const movedFuture = core.editBucket(future.id, { goalMonth: "2027-05" });
    assert.throws(() => core.revertBucket(future.id, { goalMonth: "2026-06", revertOf: movedFuture.updatedAt }), code("invalid_input", /past/));
    assert.equal(core.revertBucket(future.id, { goalMonth: "2027-01", revertOf: movedFuture.updatedAt }).goalMonth, "2027-01");
  } finally {
    core.close();
  }
});

test("revertBucket puts back an overdue goal month and a type change, only while the bucket is unchanged", () => {
  const { core, budget, setNow } = setup("2026-06-10T12:00:00.000Z");
  try {
    const group = core.createGroup(budget.id, { name: "Goals" });
    const trip = core.createBucket(budget.id, { name: "Trip", groupId: group.id, type: "goal", amount: 300_000, goalMonth: "2026-06" });
    setNow("2026-11-20T12:00:00.000Z");
    // The goal is overdue. Moving it on is fine; a plain edit back is refused, but a revert restores it.
    const moved = core.editBucket(trip.id, { goalMonth: "2027-03" });
    assert.throws(() => core.editBucket(trip.id, { goalMonth: "2026-06" }), code("invalid_input", /past/));
    const reverted = core.revertBucket(trip.id, { goalMonth: "2026-06", revertOf: moved.updatedAt });
    assert.equal(reverted.goalMonth, "2026-06");

    // An overdue goal switched to recurring, then reverted to goal with its old month.
    setNow("2026-11-21T12:00:00.000Z");
    const recurring = core.editBucket(trip.id, { type: "recurring" });
    assert.deepEqual([recurring.type, recurring.goalMonth, recurring.amount], ["recurring", null, 300_000]);
    setNow("2026-11-22T12:00:00.000Z");
    const back = core.revertBucket(trip.id, { type: "goal", amount: 300_000, goalMonth: "2026-06", revertOf: recurring.updatedAt });
    assert.deepEqual([back.type, back.goalMonth, back.amount], ["goal", "2026-06", 300_000]);

    // Stale: anything that touched the bucket since refuses the revert and changes nothing.
    setNow("2026-11-23T12:00:00.000Z");
    const edited = core.editBucket(trip.id, { goalMonth: "2027-01" });
    setNow("2026-11-24T12:00:00.000Z");
    core.editBucket(trip.id, { colour: "plum" });
    assert.throws(() => core.revertBucket(trip.id, { goalMonth: "2026-06", revertOf: edited.updatedAt }), code("bucket_changed"));
    assert.equal(core.openBucket(trip.id).goalMonth, "2027-01");
    // Shape errors still apply to a revert, and revertOf is required.
    assert.throws(() => core.revertBucket(trip.id, { goalMonth: "2026-13", revertOf: core.openBucket(trip.id).updatedAt }), code("invalid_input"));
    assert.throws(() => core.revertBucket(trip.id, { goalMonth: "2026-06" }), code("invalid_input", /revertOf/));
    assert.throws(() => core.revertBucket(trip.id, { revertOf: core.openBucket(trip.id).updatedAt }), code("invalid_input"));
  } finally {
    core.close();
  }
});

test("validation errors carry the field they belong to", () => {
  const { core, budget } = setup();
  try {
    const group = core.createGroup(budget.id, { name: "Kids group" });
    const field = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        assert.ok(error instanceof BudgetError);
        return error.field;
      }
      assert.fail("Expected an error.");
    };
    const make = (input: Record<string, unknown>) => () => core.createBucket(budget.id, { groupId: group.id, type: "plain", name: "X", ...input });
    assert.equal(field(make({ name: "" })), "name");
    assert.equal(field(make({ colour: "pink" })), "colour");
    assert.equal(field(make({ type: "weekly" })), "type");
    assert.equal(field(make({ type: "recurring", amount: 0 })), "amount");
    assert.equal(field(make({ type: "recurring" })), "amount");
    assert.equal(field(make({ type: "plain", amount: 100 })), "amount");
    assert.equal(field(make({ type: "goal", amount: 100 })), "month");
    assert.equal(field(make({ type: "goal", amount: 100, goalMonth: "2020-01" })), "month");
    assert.equal(field(make({ type: "goal", amount: 100, goalMonth: "soon" })), "month");
    assert.equal(field(make({ groupId: "missing" })), "group");
    assert.equal(field(make({ newGroupName: "Kids group", groupId: undefined })), "group");
    assert.equal(field(() => core.createGroup(budget.id, { name: "kids group" })), "group");
    // A bucket name that contains other fields' words is still a name clash.
    for (const name of ["Kids group", "Car amount", "Goal month"]) {
      core.createBucket(budget.id, { name, groupId: group.id, type: "plain" });
      assert.equal(field(make({ name: name.toUpperCase() })), "name", name);
    }
    const archived = core.createBucket(budget.id, { name: "Old Kids group", groupId: group.id, type: "plain" });
    core.archiveBucket(archived.id);
    assert.equal(field(make({ name: "old kids group" })), "name");
  } finally {
    core.close();
  }
});

test("colour defaults to the least used among active buckets and is validated", () => {
  const { core, budget } = setup();
  try {
    const group = core.createGroup(budget.id, { name: "All" });
    const add = (name: string, colour?: string) => core.createBucket(budget.id, { name, groupId: group.id, type: "plain", ...(colour !== undefined && { colour }) });
    assert.equal(add("A").colour, "sky");
    assert.equal(add("B").colour, "denim");
    assert.equal(add("C", "blue").colour, "blue");
    assert.equal(add("D").colour, "slate");
    const sky = core.listBucketTable(budget.id).buckets[0]!;
    core.archiveBucket(sky.id);
    // Archived buckets do not count, so sky is free again.
    assert.equal(add("E").colour, "sky");
    for (const colour of ["pink", "Sky", ""]) assert.throws(() => add(`Bad ${colour}`, colour), code("invalid_input"));
    assert.throws(() => core.editBucket(sky.id, { colour: "plum" }), code("invalid_input", /Restore/));
    const other = core.createBudget({ name: "Other" });
    const otherGroup = core.createGroup(other.id, { name: "All" });
    assert.equal(core.createBucket(other.id, { name: "A", groupId: otherGroup.id, type: "plain" }).colour, "sky");
  } finally {
    core.close();
  }
});

test("create with a new group is atomic, and exactly one of groupId and newGroupName is required", () => {
  const { core, budget } = setup();
  try {
    const fixed = core.createGroup(budget.id, { name: "Fixed" });
    core.createBucket(budget.id, { name: "Rent", groupId: fixed.id, type: "plain" });
    const vacation = core.createBucket(budget.id, { name: "Vacation", newGroupName: " Goals ", type: "goal", amount: 300_000, goalMonth: "2027-08" });
    const goals = core.listBucketTable(budget.id).groups[1]!;
    assert.deepEqual([goals.name, goals.order, vacation.groupId, vacation.order], ["Goals", 2, goals.id, 1]);
    // Failed buckets leave no orphan group.
    assert.throws(() => core.createBucket(budget.id, { name: "rent", newGroupName: "Orphan", type: "plain" }), code("name_taken"));
    assert.throws(() => core.createBucket(budget.id, { name: "Car", newGroupName: "Orphan", type: "goal", amount: 100 }), code("invalid_input"));
    assert.throws(() => core.createBucket(budget.id, { name: "Car", newGroupName: "Orphan", type: "plain", colour: "pink" }), code("invalid_input"));
    assert.throws(() => core.createBucket(budget.id, { name: "Car", newGroupName: "goals", type: "plain" }), code("name_taken"));
    assert.deepEqual(core.listBucketTable(budget.id).groups.map((group) => group.name), ["Fixed", "Goals"]);
    assert.throws(() => core.createBucket(budget.id, { name: "Car", groupId: fixed.id, newGroupName: "X", type: "plain" }), code("invalid_input"));
    assert.throws(() => core.createBucket(budget.id, { name: "Car", type: "plain" }), code("invalid_input"));
    assert.throws(() => core.createBucket(budget.id, { name: "Car", groupId: "missing", type: "plain" }), code("not_found"));
    const other = core.createBudget({ name: "Other" });
    assert.throws(() => core.createBucket(other.id, { name: "Car", groupId: fixed.id, type: "plain" }), code("not_found"));
    assert.throws(() => core.createBucket("missing", { name: "Car", newGroupName: "X", type: "plain" }), code("not_found"));
    for (const input of [null, [], "x", { groupId: fixed.id, type: "plain" }, { name: " ", groupId: fixed.id, type: "plain" }, { name: "x".repeat(61), groupId: fixed.id, type: "plain" },
      { name: "Car", groupId: fixed.id }, { name: "Car", groupId: 5, type: "plain" }, { name: "Car", newGroupName: "", type: "plain" },
      { name: "Car", groupId: fixed.id, type: "plain", available: 0 }, { name: "Car", groupId: fixed.id, type: "plain", id: "x" }, { name: "Car", groupId: fixed.id, type: "plain", order: 1 },
      { name: "Car", groupId: fixed.id, type: "plain", archived: true }]) {
      assert.throws(() => core.createBucket(budget.id, input), code("invalid_input"), JSON.stringify(input));
    }
    assert.equal(core.listBucketTable(budget.id).buckets.length, 2);
    // Edit can also create the group, appending the bucket to it.
    const moved = core.editBucket(vacation.id, { newGroupName: "Someday" });
    const someday = core.listBucketTable(budget.id).groups[2]!;
    assert.deepEqual([someday.name, moved.groupId, moved.order], ["Someday", someday.id, 1]);
    assert.throws(() => core.editBucket(vacation.id, { name: "rent", newGroupName: "Never" }), code("name_taken"));
    assert.equal(core.listBucketTable(budget.id).groups.length, 3);
    assert.throws(() => core.editBucket(vacation.id, {}), code("invalid_input"));
    assert.throws(() => core.editBucket(vacation.id, { groupId: fixed.id, newGroupName: "X" }), code("invalid_input"));
    assert.throws(() => core.editBucket("missing", { name: "X" }), code("not_found"));
    assert.throws(() => core.openBucket("missing"), code("not_found"));
  } finally {
    core.close();
  }
});

test("bucket names are unique per budget ignoring case, archived buckets included", () => {
  const { core, budget } = setup();
  try {
    const group = core.createGroup(budget.id, { name: "Everyday" });
    const clothing = core.createBucket(budget.id, { name: "Clothing", groupId: group.id, type: "plain" });
    const fuel = core.createBucket(budget.id, { name: "Fuel", groupId: group.id, type: "plain" });
    assert.throws(() => core.createBucket(budget.id, { name: " CLOTHING ", groupId: group.id, type: "plain" }), code("name_taken", /^A bucket/));
    assert.throws(() => core.editBucket(fuel.id, { name: "clothing" }), code("name_taken"));
    assert.equal(core.editBucket(clothing.id, { name: "CLOTHING" }).name, "CLOTHING");
    core.archiveBucket(clothing.id);
    assert.throws(() => core.createBucket(budget.id, { name: "clothing", groupId: group.id, type: "plain" }), code("name_taken", /archived/));
    assert.throws(() => core.editBucket(fuel.id, { name: "Clothing" }), code("name_taken", /archived/));
    const other = core.createBudget({ name: "Other" });
    assert.doesNotThrow(() => core.createBucket(other.id, { name: "Clothing", newGroupName: "Everyday", type: "plain" }));
  } finally {
    core.close();
  }
});

test("moving buckets and groups appends, clamps, and renumbers", () => {
  const { core, budget } = setup();
  try {
    const fixed = core.createGroup(budget.id, { name: "Fixed" });
    const everyday = core.createGroup(budget.id, { name: "Everyday" });
    const empty = core.createGroup(budget.id, { name: "Empty" });
    const [rent, phone, power] = ["Rent", "Phone", "Power"].map((name) => core.createBucket(budget.id, { name, groupId: fixed.id, type: "plain" }));
    const [food, fuel] = ["Food", "Fuel"].map((name) => core.createBucket(budget.id, { name, groupId: everyday.id, type: "plain" }));
    const layout = () => core.listBucketTable(budget.id).buckets.filter((bucket) => !bucket.archived).map((bucket) => {
      const group = core.listBucketTable(budget.id).groups.find((candidate) => candidate.id === bucket.groupId)!;
      return `${group.name}:${bucket.order}:${bucket.name}`;
    });
    assert.deepEqual(layout(), ["Fixed:1:Rent", "Fixed:2:Phone", "Fixed:3:Power", "Everyday:1:Food", "Everyday:2:Fuel"]);
    assert.deepEqual([rent!.order, phone!.order, power!.order], [1, 2, 3]);

    core.moveBucket(power!.id, { groupId: fixed.id, index: 0 });
    assert.deepEqual(layout(), ["Fixed:1:Power", "Fixed:2:Rent", "Fixed:3:Phone", "Everyday:1:Food", "Everyday:2:Fuel"]);
    core.moveBucket(power!.id, { groupId: fixed.id, index: 99 });
    assert.deepEqual(layout(), ["Fixed:1:Rent", "Fixed:2:Phone", "Fixed:3:Power", "Everyday:1:Food", "Everyday:2:Fuel"]);
    // Across groups: both groups renumber; negative clamps to first.
    const moved = core.moveBucket(rent!.id, { groupId: everyday.id, index: -3 });
    assert.deepEqual([moved.groupId, moved.order], [everyday.id, 1]);
    assert.deepEqual(layout(), ["Fixed:1:Phone", "Fixed:2:Power", "Everyday:1:Rent", "Everyday:2:Food", "Everyday:3:Fuel"]);
    core.moveBucket(fuel!.id, { groupId: everyday.id, index: 1 });
    assert.deepEqual(layout(), ["Fixed:1:Phone", "Fixed:2:Power", "Everyday:1:Rent", "Everyday:2:Fuel", "Everyday:3:Food"]);
    // Into an empty group.
    core.moveBucket(food!.id, { groupId: empty.id, index: 5 });
    assert.deepEqual(layout(), ["Fixed:1:Phone", "Fixed:2:Power", "Everyday:1:Rent", "Everyday:2:Fuel", "Empty:1:Food"]);
    // A group change through edit appends to the end of the new group.
    core.editBucket(phone!.id, { groupId: everyday.id });
    assert.deepEqual(layout(), ["Fixed:1:Power", "Everyday:1:Rent", "Everyday:2:Fuel", "Everyday:3:Phone", "Empty:1:Food"]);
    assert.equal(core.editBucket(phone!.id, { groupId: everyday.id }).order, 3);

    // Groups: 0-based index, clamped, renumbered; buckets follow their group.
    const moveGroup = (id: string, index: number) => core.moveGroup(id, { index });
    assert.equal(moveGroup(empty.id, 0).order, 1);
    assert.deepEqual(core.listBucketTable(budget.id).groups.map((group) => `${group.order}:${group.name}`), ["1:Empty", "2:Fixed", "3:Everyday"]);
    assert.equal(moveGroup(empty.id, 42).order, 3);
    assert.equal(moveGroup(everyday.id, -1).order, 1);
    assert.deepEqual(core.listBucketTable(budget.id).groups.map((group) => `${group.order}:${group.name}`), ["1:Everyday", "2:Fixed", "3:Empty"]);
    assert.deepEqual(layout(), ["Everyday:1:Rent", "Everyday:2:Fuel", "Everyday:3:Phone", "Fixed:1:Power", "Empty:1:Food"]);

    for (const input of [null, {}, { index: 1.5 }, { index: "1" }, { index: 1, extra: true }]) {
      assert.throws(() => core.moveGroup(fixed.id, input), code("invalid_input"), JSON.stringify(input));
    }
    for (const input of [null, { index: 0 }, { groupId: fixed.id }, { groupId: fixed.id, index: Number.NaN }, { groupId: 5, index: 0 }]) {
      assert.throws(() => core.moveBucket(power!.id, input), code("invalid_input"), JSON.stringify(input));
    }
    assert.throws(() => core.moveBucket(power!.id, { groupId: "missing", index: 0 }), code("not_found"));
    const other = core.createBudget({ name: "Other" });
    const foreign = core.createGroup(other.id, { name: "Foreign" });
    assert.throws(() => core.moveBucket(power!.id, { groupId: foreign.id, index: 0 }), code("not_found"));
    assert.throws(() => core.editBucket(power!.id, { groupId: foreign.id }), code("not_found"));
    assert.throws(() => core.moveBucket("missing", { groupId: fixed.id, index: 0 }), code("not_found"));
    assert.throws(() => core.moveGroup("missing", { index: 0 }), code("not_found"));
    core.archiveBucket(power!.id);
    assert.throws(() => core.moveBucket(power!.id, { groupId: fixed.id, index: 0 }), code("invalid_input", /Restore/));
  } finally {
    core.close();
  }
});

test("archive and restore are idempotent, renumber, and survive a deleted group", () => {
  const { core, budget, setNow } = setup();
  try {
    const fixed = core.createGroup(budget.id, { name: "Fixed" });
    const everyday = core.createGroup(budget.id, { name: "Everyday" });
    const [clothing, rent, phone] = ["Clothing", "Rent", "Phone"].map((name) => core.createBucket(budget.id, { name, groupId: fixed.id, type: "plain" }));
    setNow("2026-11-21T08:00:00.000Z");
    const result = core.archiveBucket(clothing!.id);
    assert.equal(result.returned, 0);
    assert.deepEqual(result.bucket, { ...clothing, archived: true, archivedAt: "2026-11-21T08:00:00.000Z", updatedAt: "2026-11-21T08:00:00.000Z" });
    assert.deepEqual([core.openBucket(rent!.id).order, core.openBucket(phone!.id).order], [1, 2]);
    setNow("2026-11-22T08:00:00.000Z");
    assert.deepEqual(core.archiveBucket(clothing!.id), result);
    assert.equal(core.readyToAssign(budget.id), 0);
    // Archived buckets are listed after active ones.
    assert.deepEqual(core.listBucketTable(budget.id).buckets.map((bucket) => bucket.name), ["Rent", "Phone", "Clothing"]);

    const restored = core.restoreBucket(clothing!.id);
    assert.deepEqual([restored.archived, restored.archivedAt, restored.groupId, restored.order], [false, null, fixed.id, 3]);
    assert.deepEqual(core.restoreBucket(clothing!.id), restored);
    assert.deepEqual(core.listBucketTable(budget.id).buckets.map((bucket) => bucket.name), ["Rent", "Phone", "Clothing"]);

    // Group delete: refused with active buckets; archived buckets lose their group and restore to the first group.
    assert.throws(() => core.deleteGroup(fixed.id), code("group_not_empty"));
    for (const bucket of [rent, phone, clothing]) core.archiveBucket(bucket!.id);
    core.deleteGroup(fixed.id);
    assert.deepEqual(core.listBucketTable(budget.id).groups.map((group) => [group.name, group.order]), [["Everyday", 1]]);
    assert.equal(core.openBucket(rent!.id).groupId, null);
    core.createBucket(budget.id, { name: "Food", groupId: everyday.id, type: "plain" });
    const back = core.restoreBucket(rent!.id);
    assert.deepEqual([back.groupId, back.order], [everyday.id, 2]);
    core.archiveBucket(back.id);
    core.archiveBucket(core.listBucketTable(budget.id).buckets.find((bucket) => bucket.name === "Food")!.id);
    core.deleteGroup(everyday.id);
    assert.throws(() => core.restoreBucket(phone!.id), code("invalid_input", /Create a group first/));
    const fresh = core.createGroup(budget.id, { name: "Fresh" });
    assert.equal(fresh.order, 1);
    assert.equal(core.restoreBucket(phone!.id).groupId, fresh.id);
    assert.throws(() => core.deleteGroup("missing"), code("not_found"));
    assert.throws(() => core.archiveBucket("missing"), code("not_found"));
    assert.throws(() => core.restoreBucket("missing"), code("not_found"));
  } finally {
    core.close();
  }
});

test("deleting a group renumbers the rest", () => {
  const { core, budget } = setup();
  try {
    const [a, b, c] = ["A", "B", "C"].map((name) => core.createGroup(budget.id, { name }));
    core.deleteGroup(b!.id);
    assert.deepEqual(core.listBucketTable(budget.id).groups.map((group) => [group.id, group.order]), [[a!.id, 1], [c!.id, 2]]);
    assert.throws(() => core.renameGroup(b!.id, { name: "B" }), code("not_found"));
    assert.equal(core.createGroup(budget.id, { name: "b" }).order, 3);
  } finally {
    core.close();
  }
});

test("buckets persist, and the database refuses invalid bucket rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "bucketeer-buckets-"));
  const filename = join(directory, "buckets.sqlite");
  try {
    let core = openBucketeer(filename);
    const budget = core.createBudget({ name: "Household" });
    const other = core.createBudget({ name: "Other" });
    const group = core.createGroup(budget.id, { name: "Fixed" });
    const foreign = core.createGroup(other.id, { name: "Foreign" });
    core.createBucket(budget.id, { name: "Rent", groupId: group.id, type: "recurring", amount: 165_000 });
    const table = core.listBucketTable(budget.id);
    core.close();
    core = openBucketeer(filename);
    assert.deepEqual(core.listBucketTable(budget.id), table);
    core.close();

    const raw = new DatabaseSync(filename);
    raw.exec("PRAGMA foreign_keys = ON");
    let n = 0;
    const insert = (fields: Record<string, unknown>) => {
      const row = { budget_id: budget.id, group_id: group.id, name: `n${n++}`, colour: "sky", type: "plain", amount: null, goal_month: null, sort_order: 1, archived_at: null, ...fields };
      raw.prepare(`INSERT INTO buckets (id, budget_id, group_id, name, colour, type, amount, goal_month, sort_order, archived_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 't', 't')`).run(`id${n}`, ...Object.values(row) as never[]);
    };
    for (const bad of [
      { colour: "pink" }, { type: "other" }, { type: "plain", amount: 100 }, { type: "recurring" }, { type: "recurring", amount: 0 },
      { type: "recurring", amount: 100_000_000_000 }, { type: "recurring", amount: 100, goal_month: "2027-01" }, { type: "goal", amount: 100 },
      { type: "goal", amount: 100, goal_month: "2027-13" }, { type: "goal", amount: 100, goal_month: "2027-1" }, { type: "goal", amount: 100, goal_month: "2027-00" },
      { group_id: null }, { group_id: "missing" }, { group_id: foreign.id }, { budget_id: "missing" }, { name: "" }, { name: "x".repeat(61) },
      { name: "RENT" }, { sort_order: 0 }, { amount: 1.5, type: "recurring" },
    ]) {
      assert.throws(() => insert(bad), Error, JSON.stringify(bad));
    }
    assert.doesNotThrow(() => insert({ type: "goal", amount: 100, goal_month: "2027-12" }));
    assert.doesNotThrow(() => insert({ group_id: null, archived_at: "t" }));
    assert.throws(() => raw.prepare("INSERT INTO bucket_groups (id, budget_id, name, sort_order, created_at, updated_at) VALUES ('g', ?, 'fixed', 2, 't', 't')").run(budget.id));
    assert.throws(() => raw.prepare("DELETE FROM bucket_groups WHERE id = ?").run(group.id));
    raw.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
