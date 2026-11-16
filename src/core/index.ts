import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { openDatabase } from "./database.js";
import { accountBalance, accountKey, readAccountEdit, readNewAccount, sumReadyToAssign } from "./accounts.js";
import { readBudgetName } from "./budget.js";
import { BudgetError } from "./types.js";
import type { Account, AccountType, Budget, Health } from "./types.js";

export { BudgetError } from "./types.js";
export type { Account, AccountEditInput, AccountType, Budget, BudgetErrorCode, BudgetNameInput, Health, NewAccountInput } from "./types.js";

function budgetFromRow(row: Record<string, SQLOutputValue>): Budget {
  return {
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function accountFromRow(row: Record<string, SQLOutputValue>): Account {
  const startingBalance = Number(row.starting_balance);
  return {
    id: String(row.id),
    budgetId: String(row.budget_id),
    name: String(row.name),
    type: String(row.type) as AccountType,
    startingBalance,
    startingDate: String(row.starting_date),
    balance: accountBalance({ startingBalance }),
    order: Number(row.sort_order),
    closed: row.closed_at !== null,
    closedAt: row.closed_at === null ? null : String(row.closed_at),
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
  const findAccount = database.prepare("SELECT * FROM accounts WHERE id = ?");
  const accountsOf = database.prepare("SELECT * FROM accounts WHERE budget_id = ? ORDER BY sort_order, created_at, id");
  const insertAccount = database.prepare(`
    INSERT INTO accounts (id, budget_id, name, type, starting_balance, starting_date, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM accounts WHERE budget_id = ?), ?, ?)`);
  const updateAccount = database.prepare("UPDATE accounts SET name = ?, starting_balance = ?, starting_date = ?, closed_at = ?, updated_at = ? WHERE id = ?");

  // Reads and writes that depend on each other (name uniqueness, closing) run in one immediate transaction.
  function transaction<T>(work: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function listAccounts(budgetId: string): Account[] {
    openBudget(budgetId);
    return accountsOf.all(budgetId).map(accountFromRow);
  }

  function openAccount(id: string): Account {
    const row = findAccount.get(id);
    if (!row) throw new BudgetError("not_found", "Account not found.");
    return accountFromRow(row);
  }

  function assertNameFree(budgetId: string, name: string, exceptId?: string): void {
    const key = accountKey(name);
    if (listAccounts(budgetId).some((account) => account.id !== exceptId && accountKey(account.name) === key)) {
      throw new BudgetError("name_taken", "An account with that name already exists in this budget.");
    }
  }

  // Saves the account's mutable fields. A closed account must keep a zero balance.
  function saveAccount(account: Account, changes: { name?: string; startingBalance?: number; startingDate?: string; closed?: boolean }): Account {
    const next = { ...account, ...changes };
    const closed = changes.closed ?? account.closed;
    if (closed && accountBalance(next) !== 0) throw new BudgetError("balance_not_zero", "Balance must be 0.00.");
    const now = new Date().toISOString();
    const closedAt = !closed ? null : account.closedAt ?? now;
    updateAccount.run(next.name, next.startingBalance, next.startingDate, closedAt, now, account.id);
    return openAccount(account.id);
  }

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
    createAccount(budgetId: string, input: unknown): Account {
      const account = readNewAccount(input);
      return transaction(() => {
        openBudget(budgetId);
        assertNameFree(budgetId, account.name);
        const now = new Date().toISOString();
        const id = randomUUID();
        insertAccount.run(id, budgetId, account.name, account.type, account.startingBalance, account.startingDate, budgetId, now, now);
        return openAccount(id);
      });
    },
    listAccounts,
    openAccount,
    editAccount(id: string, input: unknown): Account {
      const edit = readAccountEdit(input);
      return transaction(() => {
        const account = openAccount(id);
        if (edit.name !== undefined) assertNameFree(account.budgetId, edit.name, id);
        return saveAccount(account, edit);
      });
    },
    // Closing and reopening are idempotent: repeating one returns the account unchanged.
    closeAccount(id: string): Account {
      return transaction(() => {
        const account = openAccount(id);
        return account.closed ? account : saveAccount(account, { closed: true });
      });
    },
    reopenAccount(id: string): Account {
      return transaction(() => {
        const account = openAccount(id);
        return account.closed ? saveAccount(account, { closed: false }) : account;
      });
    },
    // Owner rule: an account's starting balance counts as money to assign, and a card's negative
    // opening balance reduces it. Closed accounts are included.
    readyToAssign(budgetId: string): number {
      return sumReadyToAssign(listAccounts(budgetId));
    },
    close(): void {
      database.close();
    },
  };
}

export type Bucketeer = ReturnType<typeof openBucketeer>;
