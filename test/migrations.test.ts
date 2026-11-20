import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openBucketeer } from "../src/core/index.js";
import { LATEST_VERSION, migrate } from "../src/core/migrations.js";
import { createMainDatabase, schemaVersion } from "./fixtures/main-database.js";

function inDirectory(run: (filename: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "bucketeer-migrations-"));
  try {
    run(join(directory, "budget.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const beforePreviousGoalMonth of [false, true]) {
  test(`a database from main${beforePreviousGoalMonth ? " (before previous_goal_month)" : ""} opens with all its data at schema version 1`, () => {
    inDirectory((filename) => {
      createMainDatabase(filename, { beforePreviousGoalMonth });
      const core = openBucketeer(filename, { now: () => new Date("2026-11-20T12:00:00.000Z") });
      try {
        assert.deepEqual(core.listBudgets().map((budget) => [budget.id, budget.name]), [["b1", "Household"]]);
        assert.deepEqual(core.listAccounts("b1").map((account) => [account.id, account.name, account.balance, account.closed]), [
          ["a1", "Checking", 100000, false],
          ["a2", "Wallet", 0, true],
        ]);
        const table = core.listBucketTable("b1");
        assert.deepEqual(table.groups.map((group) => [group.id, group.name]), [["g1", "Fixed"], ["g2", "Goals"]]);
        assert.deepEqual(table.buckets.map((bucket) => [bucket.id, bucket.name, bucket.type, bucket.goalMonth, bucket.archived]), [
          ["k1", "Rent", "recurring", null, false],
          ["k2", "Trip", "goal", "2027-08", false],
          ["k3", "Old", "plain", null, true],
        ]);
        // The schema still works after stamping: a goal edit records and undoes through previous_goal_month.
        const moved = core.editBucket("k2", { goalMonth: "2027-09" });
        assert.equal(core.revertBucket("k2", { goalMonth: "2027-08", revertOf: moved.updatedAt }).goalMonth, "2027-08");
      } finally {
        core.close();
      }
      assert.equal(schemaVersion(filename), 1);
    });
  });
}

test("an unversioned database from main is stamped, not rebuilt", () => {
  inDirectory((filename) => {
    createMainDatabase(filename);
    const database = new DatabaseSync(filename);
    try {
      assert.deepEqual(migrate(database), []);
      assert.equal(Number(database.prepare("PRAGMA user_version").get()?.user_version), 1);
      assert.equal(Number(database.prepare("SELECT count(*) AS n FROM buckets").get()?.n), 3);
    } finally {
      database.close();
    }
  });
});

test("a fresh database is created at the latest version, and re-opening it runs nothing", () => {
  inDirectory((filename) => {
    openBucketeer(filename).close();
    assert.equal(schemaVersion(filename), LATEST_VERSION);
    const database = new DatabaseSync(filename);
    try {
      assert.deepEqual(migrate(database), []);
    } finally {
      database.close();
    }
    assert.equal(schemaVersion(filename), LATEST_VERSION);
  });
  const memory = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(migrate(memory), [1]);
    assert.deepEqual(migrate(memory), []);
  } finally {
    memory.close();
  }
});

test("a database newer than this Bucketeer is refused rather than opened", () => {
  inDirectory((filename) => {
    const database = new DatabaseSync(filename);
    database.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    database.close();
    assert.throws(() => openBucketeer(filename), /newer/);
  });
});
