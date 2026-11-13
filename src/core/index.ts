import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { openDatabase } from "./database.js";
import { readBudgetName } from "./budget.js";
import { BudgetError } from "./types.js";
import type { Budget, Health } from "./types.js";

export { BudgetError } from "./types.js";
export type { Budget, BudgetNameInput, Health } from "./types.js";

function budgetFromRow(row: Record<string, SQLOutputValue>): Budget {
  return {
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// The core owns validation, identity, timestamps, and persistence. Clients only send intent.
export function openBucketeer(filename: string) {
  const database = openDatabase(filename);
  const find = database.prepare("SELECT * FROM budgets WHERE id = ?");
  const list = database.prepare("SELECT * FROM budgets ORDER BY created_at, id");
  const insert = database.prepare("INSERT INTO budgets (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)");
  const update = database.prepare("UPDATE budgets SET name = ?, updated_at = ? WHERE id = ?");
  const health = database.prepare("SELECT id FROM budgets LIMIT 1");

  function openBudget(id: string): Budget {
    const row = find.get(id);
    if (!row) throw new BudgetError("not_found", "Budget not found.");
    return budgetFromRow(row);
  }

  return {
    health(): Health {
      health.get();
      return { status: "ok" };
    },
    createBudget(input: unknown): Budget {
      const name = readBudgetName(input);
      const now = new Date().toISOString();
      const id = randomUUID();
      insert.run(id, name, now, now);
      return openBudget(id);
    },
    renameBudget(id: string, input: unknown): Budget {
      const name = readBudgetName(input);
      const result = update.run(name, new Date().toISOString(), id);
      if (result.changes === 0) throw new BudgetError("not_found", "Budget not found.");
      return openBudget(id);
    },
    openBudget,
    listBudgets(): Budget[] {
      return list.all().map(budgetFromRow);
    },
    close(): void {
      database.close();
    },
  };
}

export type Bucketeer = ReturnType<typeof openBucketeer>;
