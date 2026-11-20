import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACCOUNT_TYPES, MAX_ACCOUNT_NAME_LENGTH, MAX_CENTS } from "./accounts.js";
import { MAX_BUDGET_NAME_LENGTH } from "./budget.js";
import { BUCKET_TYPES, MAX_BUCKET_NAME_LENGTH } from "./buckets.js";
import { BUCKET_COLOURS } from "./colours.js";

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename, { timeout: 5_000 });
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS budgets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_BUDGET_NAME_LENGTH}),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL REFERENCES budgets(id),
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_ACCOUNT_NAME_LENGTH}),
        type TEXT NOT NULL CHECK(type IN (${ACCOUNT_TYPES.map((type) => `'${type}'`).join(", ")})),
        starting_balance INTEGER NOT NULL CHECK(starting_balance BETWEEN -${MAX_CENTS} AND ${MAX_CENTS}),
        starting_date TEXT NOT NULL CHECK(starting_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(starting_date) = starting_date),
        sort_order INTEGER NOT NULL,
        closed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS accounts_by_budget ON accounts(budget_id, sort_order);
      CREATE TABLE IF NOT EXISTS bucket_groups (
        id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL REFERENCES budgets(id),
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_BUCKET_NAME_LENGTH}),
        sort_order INTEGER NOT NULL CHECK(sort_order >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(id, budget_id)
      ) STRICT;
      -- NOCASE folds ASCII only; the core also compares full Unicode case. This is the backstop.
      CREATE UNIQUE INDEX IF NOT EXISTS bucket_groups_name ON bucket_groups(budget_id, name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS buckets (
        id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL REFERENCES budgets(id),
        group_id TEXT,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND ${MAX_BUCKET_NAME_LENGTH}),
        colour TEXT NOT NULL CHECK(colour IN (${list(BUCKET_COLOURS)})),
        type TEXT NOT NULL CHECK(type IN (${list(BUCKET_TYPES)})),
        amount INTEGER CHECK(amount BETWEEN 1 AND ${MAX_CENTS}),
        goal_month TEXT CHECK(goal_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(goal_month, 6, 2) BETWEEN '01' AND '12'),
        sort_order INTEGER NOT NULL CHECK(sort_order >= 1),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- The goal month before the latest edit; the only past month an undo may put back. Never exposed.
        previous_goal_month TEXT CHECK(previous_goal_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(previous_goal_month, 6, 2) BETWEEN '01' AND '12'),
        -- A bucket's group is in the same budget. Only an archived bucket may lose its group.
        FOREIGN KEY (group_id, budget_id) REFERENCES bucket_groups(id, budget_id),
        CHECK(group_id IS NOT NULL OR archived_at IS NOT NULL),
        CHECK(
          (type = 'recurring' AND amount IS NOT NULL AND goal_month IS NULL) OR
          (type = 'goal' AND amount IS NOT NULL AND goal_month IS NOT NULL) OR
          (type = 'plain' AND amount IS NULL AND goal_month IS NULL)
        )
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS buckets_name ON buckets(budget_id, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS buckets_by_group ON buckets(budget_id, group_id, sort_order);
    `);
    // Databases created before previous_goal_month existed gain the column (CREATE TABLE IF NOT EXISTS won't).
    const columns = database.prepare("PRAGMA table_info(buckets)").all();
    if (!columns.some((column) => column.name === "previous_goal_month")) {
      database.exec(`ALTER TABLE buckets ADD COLUMN previous_goal_month TEXT CHECK(previous_goal_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(previous_goal_month, 6, 2) BETWEEN '01' AND '12')`);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
