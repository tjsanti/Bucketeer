import type { DatabaseSync } from "node:sqlite";
import { ACCOUNT_TYPES, MAX_ACCOUNT_NAME_LENGTH, MAX_CENTS } from "./accounts.js";
import { MAX_BUDGET_NAME_LENGTH } from "./budget.js";
import { BUCKET_TYPES, MAX_BUCKET_NAME_LENGTH } from "./buckets.js";
import { BUCKET_COLOURS } from "./colours.js";

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const monthCheck = (column: string) => `CHECK(${column} GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(${column}, 6, 2) BETWEEN '01' AND '12')`;

/**
 * The schema history, oldest first. Migration n moves a database from user_version n − 1 to n.
 * Never edit a migration that has shipped; add a new one.
 */
const migrations: readonly string[] = [
  // 1: budgets, accounts, bucket groups and buckets, as the bucket slice left them.
  `
    CREATE TABLE budgets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_BUDGET_NAME_LENGTH}),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      budget_id TEXT NOT NULL REFERENCES budgets(id),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_ACCOUNT_NAME_LENGTH}),
      type TEXT NOT NULL CHECK(type IN (${list(ACCOUNT_TYPES)})),
      starting_balance INTEGER NOT NULL CHECK(starting_balance BETWEEN -${MAX_CENTS} AND ${MAX_CENTS}),
      starting_date TEXT NOT NULL CHECK(starting_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(starting_date) = starting_date),
      sort_order INTEGER NOT NULL,
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX accounts_by_budget ON accounts(budget_id, sort_order);
    CREATE TABLE bucket_groups (
      id TEXT PRIMARY KEY,
      budget_id TEXT NOT NULL REFERENCES budgets(id),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_BUCKET_NAME_LENGTH}),
      sort_order INTEGER NOT NULL CHECK(sort_order >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(id, budget_id)
    ) STRICT;
    -- NOCASE folds ASCII only; the core also compares full Unicode case. This is the backstop.
    CREATE UNIQUE INDEX bucket_groups_name ON bucket_groups(budget_id, name COLLATE NOCASE);
    CREATE TABLE buckets (
      id TEXT PRIMARY KEY,
      budget_id TEXT NOT NULL REFERENCES budgets(id),
      group_id TEXT,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_BUCKET_NAME_LENGTH}),
      colour TEXT NOT NULL CHECK(colour IN (${list(BUCKET_COLOURS)})),
      type TEXT NOT NULL CHECK(type IN (${list(BUCKET_TYPES)})),
      amount INTEGER CHECK(amount BETWEEN 1 AND ${MAX_CENTS}),
      goal_month TEXT ${monthCheck("goal_month")},
      sort_order INTEGER NOT NULL CHECK(sort_order >= 1),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- The goal month before the latest edit; the only past month an undo may put back. Never exposed.
      previous_goal_month TEXT ${monthCheck("previous_goal_month")},
      -- A bucket's group is in the same budget. Only an archived bucket may lose its group.
      FOREIGN KEY (group_id, budget_id) REFERENCES bucket_groups(id, budget_id),
      CHECK(group_id IS NOT NULL OR archived_at IS NOT NULL),
      CHECK(
        (type = 'recurring' AND amount IS NOT NULL AND goal_month IS NULL) OR
        (type = 'goal' AND amount IS NOT NULL AND goal_month IS NOT NULL) OR
        (type = 'plain' AND amount IS NULL AND goal_month IS NULL)
      )
    ) STRICT;
    CREATE UNIQUE INDEX buckets_name ON buckets(budget_id, name COLLATE NOCASE);
    CREATE INDEX buckets_by_group ON buckets(budget_id, group_id, sort_order);
  `,
];

export const LATEST_VERSION = migrations.length;

function versionOf(database: DatabaseSync): number {
  return Number(database.prepare("PRAGMA user_version").get()?.user_version);
}

function inTransaction(database: DatabaseSync, run: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Databases from before versioning have tables but user_version 0. They already hold migration 1's schema,
 * except the oldest lack previous_goal_month, so they are patched and stamped as version 1, never rebuilt.
 */
function stampUnversioned(database: DatabaseSync): void {
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'budgets'").get() === undefined) return;
  inTransaction(database, () => {
    if (versionOf(database) !== 0) return;
    const columns = database.prepare("PRAGMA table_info(buckets)").all();
    if (!columns.some((column) => column.name === "previous_goal_month")) {
      database.exec(`ALTER TABLE buckets ADD COLUMN previous_goal_month TEXT ${monthCheck("previous_goal_month")}`);
    }
    database.exec("PRAGMA user_version = 1");
  });
}

/** Brings a database up to LATEST_VERSION, one migration per transaction. Returns the versions it ran. */
export function migrate(database: DatabaseSync): number[] {
  if (versionOf(database) === 0) stampUnversioned(database);
  const current = versionOf(database);
  if (current > LATEST_VERSION) {
    throw new Error(`This database is at schema version ${current}, newer than this Bucketeer understands (${LATEST_VERSION}). Upgrade Bucketeer to open it.`);
  }
  const ran: number[] = [];
  for (let version = current + 1; version <= LATEST_VERSION; version++) {
    inTransaction(database, () => {
      // Another process may have migrated while we waited for the write lock.
      if (versionOf(database) >= version) return;
      database.exec(migrations[version - 1]!);
      database.exec(`PRAGMA user_version = ${version}`);
      ran.push(version);
    });
  }
  return ran;
}
