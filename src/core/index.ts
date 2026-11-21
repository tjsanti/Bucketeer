import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { openDatabase } from "./database.js";
import { accountBalance, accountKey, readAccountEdit, readNewAccount, sumReadyToAssign } from "./accounts.js";
import { readBudgetName } from "./budget.js";
import { bucketAvailable, nameKey, readBucketEdit, readBucketMove, readBucketRevert, readGroupName, readMove, readNewBucket, resolveShape } from "./buckets.js";
import type { BucketFields, GroupChoice } from "./buckets.js";
import { leastUsedColour } from "./colours.js";
import { calendarIn, defaultTimeZone } from "./time.js";
import { assertConsistent, readNewTransaction, readTransactionEdit, sameCategory } from "./transactions.js";
import type { BucketColour } from "./colours.js";
import { BudgetError } from "./types.js";
import type {
  Account, AccountType, ArchiveResult, Bucket, BucketGroup, BucketTable, BucketType, Budget, Category, Health, PayeeHistory, RegisterTransaction, Transaction,
} from "./types.js";

export { BudgetError } from "./types.js";
export type { BucketColour } from "./colours.js";
export type {
  Account, AccountEditInput, AccountType, ArchiveResult, Bucket, BucketEditInput, BucketGroup, BucketMoveInput, BucketRevertInput, BucketTable, BucketType,
  Budget, BudgetErrorCode, BudgetErrorField, BudgetNameInput, Category, GroupNameInput, Health, MoveInput, NewAccountInput, NewBucketInput,
  NewTransactionInput, PayeeHistory, RegisterTransaction, Transaction, TransactionEditInput,
} from "./types.js";

export interface BucketeerOptions {
  /** The clock for timestamps and every date rule. Defaults to the system clock. */
  now?: () => Date;
  /** The IANA zone that decides "today" and "this month" (ADR-0007). Defaults to the process's zone, which honours TZ. */
  timeZone?: string;
}

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
    balance: accountBalance({ startingBalance, activity: Number(row.activity) }),
    order: Number(row.sort_order),
    closed: row.closed_at !== null,
    closedAt: row.closed_at === null ? null : String(row.closed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function categoryFromRow(row: Record<string, SQLOutputValue>): Category {
  return row.kind === "bucket" ? { kind: "bucket", bucketId: String(row.bucket_id) } : { kind: "income" };
}

function bucketIdOf(category: Category): string | null {
  return category.kind === "bucket" ? category.bucketId : null;
}

function transactionFromRow(row: Record<string, SQLOutputValue>): Transaction {
  return {
    id: String(row.id),
    budgetId: String(row.budget_id),
    accountId: String(row.account_id),
    date: String(row.date),
    payee: String(row.payee),
    memo: String(row.memo),
    amount: Number(row.amount),
    category: categoryFromRow(row),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** The first day of the month twelve months before the given "YYYY-MM" (ADR-0006). */
function earliestDate(creationMonth: string): string {
  return `${String(Number(creationMonth.slice(0, 4)) - 1).padStart(4, "0")}-${creationMonth.slice(5, 7)}-01`;
}

function groupFromRow(row: Record<string, SQLOutputValue>): BucketGroup {
  return {
    id: String(row.id),
    budgetId: String(row.budget_id),
    name: String(row.name),
    order: Number(row.sort_order),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function bucketFromRow(row: Record<string, SQLOutputValue>): Bucket {
  const id = String(row.id);
  return {
    id,
    budgetId: String(row.budget_id),
    groupId: row.group_id === null ? null : String(row.group_id),
    name: String(row.name),
    colour: String(row.colour) as BucketColour,
    type: String(row.type) as BucketType,
    amount: row.amount === null ? null : Number(row.amount),
    goalMonth: row.goal_month === null ? null : String(row.goal_month),
    available: bucketAvailable({ moneyIn: Number(row.money_in), moneyOut: Number(row.money_out) }),
    spent: Number(row.money_out),
    order: Number(row.sort_order),
    archived: row.archived_at !== null,
    archivedAt: row.archived_at === null ? null : String(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const clamp = (index: number, length: number) => Math.min(Math.max(index, 0), length);

// The core owns validation, identity, timestamps, and persistence. Clients only send intent.
export function openBucketeer(filename: string, options: BucketeerOptions = {}) {
  const clock = options.now ?? (() => new Date());
  const timestamp = () => clock().toISOString();
  const calendar = calendarIn(options.timeZone ?? defaultTimeZone());
  const thisMonth = () => calendar.monthOf(clock());
  const database = openDatabase(filename);
  const find = database.prepare("SELECT * FROM budgets WHERE id = ?");
  const list = database.prepare("SELECT * FROM budgets ORDER BY created_at, id");
  const insert = database.prepare("INSERT INTO budgets (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)");
  const update = database.prepare("UPDATE budgets SET name = ?, updated_at = ? WHERE id = ?");
  const health = database.prepare("SELECT id FROM budgets LIMIT 1");
  const withActivity = "SELECT accounts.*, (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account_id = accounts.id) AS activity FROM accounts";
  const findAccount = database.prepare(`${withActivity} WHERE id = ?`);
  const accountsOf = database.prepare(`${withActivity} WHERE budget_id = ? ORDER BY sort_order, created_at, id`);
  const insertAccount = database.prepare(`
    INSERT INTO accounts (id, budget_id, name, type, starting_balance, starting_date, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM accounts WHERE budget_id = ?), ?, ?)`);
  const updateAccount = database.prepare("UPDATE accounts SET name = ?, starting_balance = ?, starting_date = ?, closed_at = ?, updated_at = ? WHERE id = ?");
  const findGroup = database.prepare("SELECT * FROM bucket_groups WHERE id = ?");
  const groupsOf = database.prepare("SELECT * FROM bucket_groups WHERE budget_id = ? ORDER BY sort_order, created_at, id");
  const insertGroup = database.prepare(`
    INSERT INTO bucket_groups (id, budget_id, name, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM bucket_groups WHERE budget_id = ?), ?, ?)`);
  const renameGroupRow = database.prepare("UPDATE bucket_groups SET name = ?, updated_at = ? WHERE id = ?");
  const orderGroup = database.prepare("UPDATE bucket_groups SET sort_order = ? WHERE id = ?");
  const touchGroup = database.prepare("UPDATE bucket_groups SET updated_at = ? WHERE id = ?");
  const deleteGroupRow = database.prepare("DELETE FROM bucket_groups WHERE id = ?");
  // A bucket's money: its whole transactions plus its split lines, in and out kept apart so Spent stays gross.
  const bucketLines = "SELECT amount FROM transactions WHERE bucket_id = buckets.id UNION ALL SELECT amount FROM transaction_lines WHERE bucket_id = buckets.id";
  const withMoney = `buckets.*,
    (SELECT COALESCE(SUM(amount), 0) FROM (${bucketLines}) WHERE amount > 0) AS money_in,
    (SELECT COALESCE(-SUM(amount), 0) FROM (${bucketLines}) WHERE amount < 0) AS money_out`;
  const findBucket = database.prepare(`SELECT ${withMoney} FROM buckets WHERE id = ?`);
  // Active buckets in group and position order, then archived buckets, also by group and position
  // (those whose group was deleted first), with the archive date breaking ties.
  const bucketsOf = database.prepare(`
    SELECT ${withMoney} FROM buckets LEFT JOIN bucket_groups ON bucket_groups.id = buckets.group_id
    WHERE buckets.budget_id = ?
    ORDER BY buckets.archived_at IS NOT NULL, bucket_groups.sort_order, buckets.sort_order, buckets.archived_at, buckets.created_at, buckets.id`);
  const activeIn = database.prepare("SELECT id FROM buckets WHERE group_id = ? AND archived_at IS NULL ORDER BY sort_order, created_at, id");
  const insertBucket = database.prepare(`
    INSERT INTO buckets (id, budget_id, group_id, name, colour, type, amount, goal_month, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM buckets WHERE group_id = ? AND archived_at IS NULL), ?, ?)`);
  const updateBucket = database.prepare(`
    UPDATE buckets SET group_id = ?, name = ?, colour = ?, type = ?, amount = ?, goal_month = ?, archived_at = ?, updated_at = ? WHERE id = ?`);
  const setPreviousMonth = database.prepare("UPDATE buckets SET previous_goal_month = ? WHERE id = ?");
  const previousMonthOf = database.prepare("SELECT previous_goal_month FROM buckets WHERE id = ?");
  const orderBucket = database.prepare("UPDATE buckets SET sort_order = ? WHERE id = ?");
  const orphanArchived = database.prepare("UPDATE buckets SET group_id = NULL WHERE group_id = ? AND archived_at IS NOT NULL");
  const findTransaction = database.prepare("SELECT * FROM transactions WHERE id = ?");
  // Oldest first, so running balances can be summed forward; ties keep entry order.
  const transactionsOf = database.prepare("SELECT * FROM transactions WHERE account_id = ? ORDER BY date, created_at, rowid");
  const insertTransaction = database.prepare(`
    INSERT INTO transactions (id, budget_id, account_id, date, payee, memo, amount, kind, bucket_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateTransaction = database.prepare("UPDATE transactions SET date = ?, payee = ?, memo = ?, amount = ?, kind = ?, bucket_id = ?, updated_at = ? WHERE id = ?");
  // Every payee's transactions, latest first, so the first row per payee (ignoring case) is its latest.
  const payeeRows = database.prepare("SELECT payee, kind, bucket_id FROM transactions WHERE budget_id = ? AND payee <> '' ORDER BY date DESC, created_at DESC, rowid DESC");
  const deleteTransactionRow = database.prepare("DELETE FROM transactions WHERE id = ?");
  const incomeOf = database.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE budget_id = ? AND kind = 'income'");

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
    if (closed && accountBalance({ startingBalance: next.startingBalance, activity: account.balance - account.startingBalance }) !== 0) throw new BudgetError("balance_not_zero", "Balance must be 0.00.");
    const now = timestamp();
    const closedAt = !closed ? null : account.closedAt ?? now;
    updateAccount.run(next.name, next.startingBalance, next.startingDate, closedAt, now, account.id);
    return openAccount(account.id);
  }

  function openGroup(id: string): BucketGroup {
    const row = findGroup.get(id);
    if (!row) throw new BudgetError("not_found", "Group not found.");
    return groupFromRow(row);
  }

  function openBucket(id: string): Bucket {
    const row = findBucket.get(id);
    if (!row) throw new BudgetError("not_found", "Bucket not found.");
    return bucketFromRow(row);
  }

  function listBucketTable(budgetId: string): BucketTable {
    openBudget(budgetId);
    return { groups: groupsOf.all(budgetId).map(groupFromRow), buckets: bucketsOf.all(budgetId).map(bucketFromRow) };
  }

  function assertGroupNameFree(budgetId: string, name: string, exceptId?: string): void {
    const key = nameKey(name);
    if (groupsOf.all(budgetId).map(groupFromRow).some((group) => group.id !== exceptId && nameKey(group.name) === key)) {
      throw new BudgetError("name_taken", "A group with that name already exists in this budget.", "group");
    }
  }

  // Bucket names are unique per budget ignoring case, archived buckets included.
  function assertBucketNameFree(budgetId: string, name: string, exceptId?: string): void {
    const key = nameKey(name);
    const clash = bucketsOf.all(budgetId).map(bucketFromRow).find((bucket) => bucket.id !== exceptId && nameKey(bucket.name) === key);
    if (!clash) return;
    throw new BudgetError("name_taken", clash.archived
      ? `An archived bucket is already named ${clash.name}. Restore it or choose another name.`
      : "A bucket with that name already exists in this budget.", "name");
  }

  function insertNewGroup(budgetId: string, name: string): BucketGroup {
    assertGroupNameFree(budgetId, name);
    const now = timestamp();
    const id = randomUUID();
    insertGroup.run(id, budgetId, name, budgetId, now, now);
    return openGroup(id);
  }

  // Resolves where a bucket goes. A new group is created inside the caller's transaction.
  function chooseGroup(budgetId: string, choice: NonNullable<GroupChoice>): BucketGroup {
    if ("newGroupName" in choice) return insertNewGroup(budgetId, choice.newGroupName);
    const group = findGroup.get(choice.groupId);
    if (!group || String(group.budget_id) !== budgetId) throw new BudgetError("not_found", "Group not found.", "group");
    return groupFromRow(group);
  }

  function activeIds(groupId: string): string[] {
    return activeIn.all(groupId).map((row) => String(row.id));
  }

  function renumberBuckets(ids: readonly string[]): void {
    ids.forEach((id, index) => orderBucket.run(index + 1, id));
  }

  function writeBucket(bucket: Bucket): Bucket {
    updateBucket.run(bucket.groupId, bucket.name, bucket.colour, bucket.type, bucket.amount, bucket.goalMonth, bucket.archivedAt, timestamp(), bucket.id);
    return openBucket(bucket.id);
  }

  // Puts an active bucket at a 0-based index in a group (clamped), renumbering the old and new group.
  function placeBucket(bucket: Bucket, groupId: string, index: number): void {
    if (bucket.groupId && bucket.groupId !== groupId) renumberBuckets(activeIds(bucket.groupId).filter((id) => id !== bucket.id));
    const ids = activeIds(groupId).filter((id) => id !== bucket.id);
    ids.splice(clamp(index, ids.length), 0, bucket.id);
    renumberBuckets(ids);
  }

  function assertActive(bucket: Bucket, action: string): void {
    if (bucket.archived) throw new BudgetError("invalid_input", `Restore the bucket before ${action} it.`);
  }

  function activeBucketsOf(budgetId: string): Bucket[] {
    return bucketsOf.all(budgetId).map(bucketFromRow).filter((bucket) => !bucket.archived);
  }

  // Shared by edit and revert. With `revertOf`, the bucket must still carry that updatedAt, and the month
  // being restored may be past only if it is exactly the goal month the bucket had before the edit being
  // undone (previous_goal_month). Every edit records the month it replaced; a revert clears it.
  function editBucketRow(id: string, edit: BucketFields, revertOf?: string): Bucket {
    return transaction(() => {
      const bucket = openBucket(id);
      assertActive(bucket, "editing");
      if (revertOf !== undefined && bucket.updatedAt !== revertOf) {
        throw new BudgetError("bucket_changed", `${bucket.name} has changed since, so the edit was not undone.`);
      }
      const restorable = revertOf === undefined ? null : (previousMonthOf.get(id)?.previous_goal_month as string | null | undefined) ?? null;
      const shape = resolveShape(bucket, edit, thisMonth(), restorable);
      if (edit.name !== undefined) assertBucketNameFree(bucket.budgetId, edit.name, id);
      const group = edit.group ? chooseGroup(bucket.budgetId, edit.group) : undefined;
      // A group change appends the bucket to the end of the new group.
      if (group && group.id !== bucket.groupId) placeBucket(bucket, group.id, Number.MAX_SAFE_INTEGER);
      const written = writeBucket({
        ...bucket, ...shape,
        name: edit.name ?? bucket.name,
        colour: edit.colour ?? bucket.colour,
        groupId: group?.id ?? bucket.groupId,
      });
      setPreviousMonth.run(revertOf === undefined ? bucket.goalMonth : null, id);
      return written;
    });
  }

  function openTransaction(id: string): Transaction {
    const row = findTransaction.get(id);
    if (!row) throw new BudgetError("not_found", "Transaction not found.");
    return transactionFromRow(row);
  }

  // A date must be today or earlier, and no earlier than the first day of the budget's creation month − 12.
  function assertDateAllowed(budget: Budget, date: string): void {
    if (date > calendar.dateOf(clock())) throw new BudgetError("invalid_input", "Transactions can't be dated in the future.", "date");
    const earliest = earliestDate(calendar.monthOf(new Date(budget.createdAt)));
    if (date < earliest) throw new BudgetError("invalid_input", `Transactions can't be dated before ${earliest}.`, "date");
  }

  // A bucket category must name a bucket in the transaction's budget; a new filing to an archived one is refused.
  function assertCategoryAllowed(budgetId: string, category: Category): void {
    if (category.kind !== "bucket") return;
    const row = findBucket.get(category.bucketId);
    if (!row || String(row.budget_id) !== budgetId) throw new BudgetError("not_found", "Bucket not found.", "category");
    const bucket = bucketFromRow(row);
    if (bucket.archived) throw new BudgetError("bucket_archived", `${bucket.name} is archived. Restore it to file money to it.`, "category");
  }

  function assertOpen(account: Account): void {
    if (account.closed) throw new BudgetError("account_closed", `${account.name} is closed. Reopen it first.`);
  }

  function openBudget(id: string): Budget {
    const row = find.get(id);
    if (!row) throw new BudgetError("not_found", "Budget not found.");
    return budgetFromRow(row);
  }

  return {
    /** Today's date, "YYYY-MM-DD", in the server's time zone. */
    today(): string {
      return calendar.dateOf(clock());
    },
    health(): Health {
      health.get();
      return { status: "ok" };
    },
    createBudget(input: unknown): Budget {
      const name = readBudgetName(input);
      const now = timestamp();
      const id = randomUUID();
      insert.run(id, name, now, now);
      return openBudget(id);
    },
    renameBudget(id: string, input: unknown): Budget {
      const name = readBudgetName(input);
      const result = update.run(name, timestamp(), id);
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
        const now = timestamp();
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
      return sumReadyToAssign(listAccounts(budgetId), Number(incomeOf.get(budgetId)?.total));
    },
    addTransaction(accountId: string, input: unknown): Transaction {
      const fields = readNewTransaction(input);
      return transaction(() => {
        const account = openAccount(accountId);
        assertOpen(account);
        const next = { date: fields.date ?? calendar.dateOf(clock()), payee: fields.payee ?? "", memo: fields.memo ?? "", amount: fields.amount, category: fields.category };
        assertConsistent(next);
        assertDateAllowed(openBudget(account.budgetId), next.date);
        assertCategoryAllowed(account.budgetId, next.category);
        const now = timestamp();
        const id = randomUUID();
        insertTransaction.run(id, account.budgetId, account.id, next.date, next.payee, next.memo, next.amount, next.category.kind, bucketIdOf(next.category), now, now);
        return openTransaction(id);
      });
    },
    openTransaction,
    // A closed account's balance stays 0, so its transactions' amounts can't change and none can be deleted.
    editTransaction(id: string, input: unknown): Transaction {
      const edit = readTransactionEdit(input);
      return transaction(() => {
        const existing = openTransaction(id);
        const account = openAccount(existing.accountId);
        const next = { ...existing, ...edit };
        if (next.amount !== existing.amount) assertOpen(account);
        assertConsistent(next);
        if (edit.date !== undefined) assertDateAllowed(openBudget(existing.budgetId), next.date);
        // Only a change of category is checked, so a transaction keeps a bucket that's since been archived.
        if (!sameCategory(next.category, existing.category)) assertCategoryAllowed(existing.budgetId, next.category);
        updateTransaction.run(next.date, next.payee, next.memo, next.amount, next.category.kind, bucketIdOf(next.category), timestamp(), id);
        return openTransaction(id);
      });
    },
    deleteTransaction(id: string): void {
      transaction(() => {
        const existing = openTransaction(id);
        assertOpen(openAccount(existing.accountId));
        deleteTransactionRow.run(id);
      });
    },
    /** The account's register, newest first, each with the balance just after it. */
    listTransactions(accountId: string): { transactions: RegisterTransaction[] } {
      const account = openAccount(accountId);
      let balance = account.startingBalance;
      const register = transactionsOf.all(accountId).map((row) => {
        const found = transactionFromRow(row);
        balance += found.amount;
        return { ...found, runningBalance: balance };
      });
      return { transactions: register.reverse() };
    },
    /** Every payee in the budget with its latest transaction's category, sorted by name; the latest spelling wins. */
    payees(budgetId: string): PayeeHistory[] {
      openBudget(budgetId);
      const latest = new Map<string, PayeeHistory>();
      for (const row of payeeRows.all(budgetId)) {
        const key = String(row.payee).toLowerCase();
        if (!latest.has(key)) latest.set(key, { payee: String(row.payee), category: categoryFromRow(row) });
      }
      return [...latest.values()].sort((a, b) => a.payee.localeCompare(b.payee));
    },
    listBucketTable,
    createGroup(budgetId: string, input: unknown): BucketGroup {
      const name = readGroupName(input);
      return transaction(() => {
        openBudget(budgetId);
        return insertNewGroup(budgetId, name);
      });
    },
    renameGroup(id: string, input: unknown): BucketGroup {
      const name = readGroupName(input);
      return transaction(() => {
        const group = openGroup(id);
        assertGroupNameFree(group.budgetId, name, id);
        renameGroupRow.run(name, timestamp(), id);
        return openGroup(id);
      });
    },
    moveGroup(id: string, input: unknown): BucketGroup {
      const { index } = readMove(input);
      return transaction(() => {
        const group = openGroup(id);
        const ids = groupsOf.all(group.budgetId).map((row) => String(row.id)).filter((other) => other !== id);
        ids.splice(clamp(index, ids.length), 0, id);
        ids.forEach((other, position) => orderGroup.run(position + 1, other));
        touchGroup.run(timestamp(), id);
        return openGroup(id);
      });
    },
    // Refused while the group has active buckets. Its archived buckets keep existing without a group.
    deleteGroup(id: string): void {
      transaction(() => {
        const group = openGroup(id);
        if (activeIds(id).length) throw new BudgetError("group_not_empty", "Move or archive this group's buckets before deleting it.");
        orphanArchived.run(id);
        deleteGroupRow.run(id);
        groupsOf.all(group.budgetId).forEach((row, position) => orderGroup.run(position + 1, String(row.id)));
      });
    },
    createBucket(budgetId: string, input: unknown): Bucket {
      const fields = readNewBucket(input);
      return transaction(() => {
        openBudget(budgetId);
        const shape = resolveShape(null, fields, thisMonth());
        assertBucketNameFree(budgetId, fields.name);
        const colour = fields.colour ?? leastUsedColour(activeBucketsOf(budgetId));
        const group = chooseGroup(budgetId, fields.group);
        const now = timestamp();
        const id = randomUUID();
        insertBucket.run(id, budgetId, group.id, fields.name, colour, shape.type, shape.amount, shape.goalMonth, group.id, now, now);
        return openBucket(id);
      });
    },
    openBucket,
    editBucket(id: string, input: unknown): Bucket {
      return editBucketRow(id, readBucketEdit(input));
    },
    // Undo of an edit: applies the inverse only if nothing has touched the bucket since (`revertOf` is the
    // updatedAt that edit left), in one transaction. The month being restored may be past.
    revertBucket(id: string, input: unknown): Bucket {
      const { fields, revertOf } = readBucketRevert(input);
      return editBucketRow(id, fields, revertOf);
    },
    moveBucket(id: string, input: unknown): Bucket {
      const move = readBucketMove(input);
      return transaction(() => {
        const bucket = openBucket(id);
        assertActive(bucket, "moving");
        const group = chooseGroup(bucket.budgetId, { groupId: move.groupId });
        placeBucket(bucket, group.id, move.index);
        return writeBucket({ ...openBucket(id), groupId: group.id });
      });
    },
    // Owner rule (2026-11-17): refused while overspent. A positive Available (only a reimbursement can make one
    // until the ledger exists) is refused too; the month slice returns it to Ready to assign instead.
    // Idempotent: archiving an archived bucket returns it unchanged with nothing returned.
    archiveBucket(id: string): ArchiveResult {
      return transaction(() => {
        const bucket = openBucket(id);
        if (bucket.archived) return { bucket, returned: 0 };
        if (bucket.available < 0) throw new BudgetError("bucket_overspent", "A bucket can't be archived while its Available is negative.");
        if (bucket.available > 0) throw new BudgetError("bucket_has_money", `${bucket.name} still holds money. Spend it or move it before archiving.`);
        const archived = writeBucket({ ...bucket, archivedAt: timestamp() });
        if (bucket.groupId) renumberBuckets(activeIds(bucket.groupId));
        return { bucket: archived, returned: 0 };
      });
    },
    // Restore appends to the end of the bucket's group, or of the first group if its group was deleted.
    restoreBucket(id: string): Bucket {
      return transaction(() => {
        const bucket = openBucket(id);
        if (!bucket.archived) return bucket;
        const groupId = bucket.groupId ?? groupsOf.get(bucket.budgetId)?.id;
        if (groupId === undefined || groupId === null) throw new BudgetError("invalid_input", "Create a group first.");
        const restored = { ...bucket, groupId: String(groupId), archivedAt: null };
        orderBucket.run(activeIds(restored.groupId).length + 1, id);
        return writeBucket({ ...restored });
      });
    },
    close(): void {
      database.close();
    },
  };
}

export type Bucketeer = ReturnType<typeof openBucketeer>;
