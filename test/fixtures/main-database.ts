import { DatabaseSync } from "node:sqlite";

// A frozen copy of the schema `main` created before versioned migrations, with user_version left at 0.
// Do not edit it to match later schemas: it stands for databases already out in the world.
const mainSchema = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE budgets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    budget_id TEXT NOT NULL REFERENCES budgets(id),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
    type TEXT NOT NULL CHECK(type IN ('checking', 'savings', 'credit-card', 'cash')),
    starting_balance INTEGER NOT NULL CHECK(starting_balance BETWEEN -99999999999 AND 99999999999),
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
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
    sort_order INTEGER NOT NULL CHECK(sort_order >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(id, budget_id)
  ) STRICT;
  CREATE UNIQUE INDEX bucket_groups_name ON bucket_groups(budget_id, name COLLATE NOCASE);
  CREATE TABLE buckets (
    id TEXT PRIMARY KEY,
    budget_id TEXT NOT NULL REFERENCES budgets(id),
    group_id TEXT,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
    colour TEXT NOT NULL CHECK(colour IN ('sky', 'denim', 'blue', 'slate', 'teal', 'mint', 'green', 'forest', 'lime', 'olive', 'sun', 'cocoa', 'peach', 'tangerine', 'rose', 'plum')),
    type TEXT NOT NULL CHECK(type IN ('recurring', 'goal', 'plain')),
    amount INTEGER CHECK(amount BETWEEN 1 AND 99999999999),
    goal_month TEXT CHECK(goal_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(goal_month, 6, 2) BETWEEN '01' AND '12'),
    sort_order INTEGER NOT NULL CHECK(sort_order >= 1),
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    previous_goal_month TEXT CHECK(previous_goal_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(previous_goal_month, 6, 2) BETWEEN '01' AND '12'),
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
`;

const t = "2026-11-12T12:00:00.000Z";
const mainRows = `
  INSERT INTO budgets VALUES ('b1', 'Household', '${t}', '${t}');
  INSERT INTO accounts VALUES ('a1', 'b1', 'Checking', 'checking', 100000, '2026-11-01', 1, NULL, '${t}', '${t}');
  INSERT INTO accounts VALUES ('a2', 'b1', 'Wallet', 'cash', 0, '2026-11-01', 2, '${t}', '${t}', '${t}');
  INSERT INTO bucket_groups VALUES ('g1', 'b1', 'Fixed', 1, '${t}', '${t}');
  INSERT INTO bucket_groups VALUES ('g2', 'b1', 'Goals', 2, '${t}', '${t}');
  INSERT INTO buckets VALUES ('k1', 'b1', 'g1', 'Rent', 'sky', 'recurring', 165000, NULL, 1, NULL, '${t}', '${t}', NULL);
  INSERT INTO buckets VALUES ('k2', 'b1', 'g2', 'Trip', 'teal', 'goal', 300000, '2027-08', 1, NULL, '${t}', '${t}', '2027-06');
  INSERT INTO buckets VALUES ('k3', 'b1', NULL, 'Old', 'rose', 'plain', NULL, NULL, 1, '${t}', '${t}', '${t}', NULL);
`;

/**
 * Writes a database the way `main` left it: tables, a budget with two accounts, two groups and three buckets
 * (one archived), and no schema version. `beforePreviousGoalMonth` drops the column added late in the bucket slice.
 */
export function createMainDatabase(filename: string, options: { beforePreviousGoalMonth?: boolean } = {}): void {
  const database = new DatabaseSync(filename);
  try {
    database.exec(mainSchema);
    database.exec(mainRows);
    if (options.beforePreviousGoalMonth) database.exec("ALTER TABLE buckets DROP COLUMN previous_goal_month");
  } finally {
    database.close();
  }
}

export function schemaVersion(filename: string): number {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return Number(database.prepare("PRAGMA user_version").get()?.user_version);
  } finally {
    database.close();
  }
}
