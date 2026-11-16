import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ACCOUNT_TYPES, MAX_ACCOUNT_NAME_LENGTH, MAX_CENTS } from "./accounts.js";
import { MAX_BUDGET_NAME_LENGTH } from "./budget.js";

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
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
