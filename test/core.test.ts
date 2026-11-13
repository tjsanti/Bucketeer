import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetError, openBucketeer } from "../src/core/index.js";

test("budgets survive reopening, preserve identity, and record exact UTC save times", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T12:00:00.000Z") });
  const directory = mkdtempSync(join(tmpdir(), "bucketeer-core-"));
  const filename = join(directory, "nested", "budget.sqlite");
  let core = openBucketeer(filename);
  try {
    assert.deepEqual(core.health(), { status: "ok" });
    assert.deepEqual(core.listBudgets(), []);
    const saved = core.createBudget({ name: "  Household  " });
    assert.equal(saved.name, "Household");
    assert.equal(typeof saved.id, "string");
    assert.notEqual(saved.id, "");
    assert.equal(saved.createdAt, "2026-11-12T12:00:00.000Z");
    assert.equal(saved.updatedAt, "2026-11-12T12:00:00.000Z");
    core.close();
    core = openBucketeer(filename);
    assert.deepEqual(core.openBudget(saved.id), saved);
    assert.deepEqual(core.listBudgets(), [saved]);
    t.mock.timers.tick(60_000);
    const updated = core.renameBudget(saved.id, { name: "Family budget" });
    assert.equal(updated.id, saved.id);
    assert.equal(updated.createdAt, saved.createdAt);
    assert.equal(updated.name, "Family budget");
    assert.equal(updated.updatedAt, "2026-11-12T12:01:00.000Z");
    const second = core.createBudget({ name: "Family budget" });
    assert.notEqual(second.id, saved.id);
    core.close();
    core = openBucketeer(filename);
    assert.deepEqual(core.openBudget(saved.id), updated);
    assert.equal(core.listBudgets().length, 2);
  } finally {
    core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("create and rename reject invalid bodies and caller-assigned IDs without changing saved data", () => {
  const core = openBucketeer(":memory:");
  try {
    const original = core.createBudget({ name: "Original" });
    for (const input of [null, [], "x", {}, { name: 42 }, { name: " \n " }, { name: "\0" }, { name: "x".repeat(121) }, { name: "Valid", id: original.id }, { name: "Valid", id: null }]) {
      for (const operation of [() => core.createBudget(input), () => core.renameBudget(original.id, input)]) {
        assert.throws(operation, (error: unknown) => error instanceof BudgetError && error.code === "invalid_input");
      }
    }
    assert.throws(() => core.renameBudget("missing", { name: "New" }), (error: unknown) => error instanceof BudgetError && error.code === "not_found");
    assert.throws(() => core.openBudget("missing"), (error: unknown) => error instanceof BudgetError && error.code === "not_found");
    assert.deepEqual(core.listBudgets(), [original]);
    const quoted = core.createBudget({ name: "Sam's <household> budget" });
    assert.equal(core.openBudget(quoted.id).name, "Sam's <household> budget");
  } finally {
    core.close();
  }
});

test("name limits count Unicode code points and trim Unicode whitespace", () => {
  const core = openBucketeer(":memory:");
  try {
    for (const name of ["x".repeat(120), "🪣".repeat(120)]) {
      const budget = core.createBudget({ name: `\u2003${name}\u00a0` });
      assert.equal(budget.name, name);
      assert.equal(core.openBudget(budget.id).name, name);
      assert.throws(() => core.renameBudget(budget.id, { name: `${name}x` }), { code: "invalid_input" });
      assert.equal(core.openBudget(budget.id).name, name);
    }
    assert.throws(() => core.createBudget({ name: "🪣".repeat(121) }), { code: "invalid_input" });
  } finally {
    core.close();
  }
});
