import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { openDatabase } from "./database.js";
import { accountBalance, accountKey, readAccountEdit, readNewAccount, sumReadyToAssign } from "./accounts.js";
import { readBudgetName } from "./budget.js";
import { assertAssignable, lowestAvailableFrom, monthFigures, readAssignment, shownIn, totalsOf } from "./assignments.js";
import type { MonthActivity } from "./assignments.js";
import { bucketAvailable, nameKey, readBucketEdit, readBucketMove, readBucketRevert, readGroupName, readMove, readNewBucket, resolveShape } from "./buckets.js";
import type { BucketFields, GroupChoice } from "./buckets.js";
import { leastUsedColour } from "./colours.js";
import { calendarIn, defaultTimeZone } from "./time.js";
import { monthName, monthRangeOf, readMonth } from "./months.js";
import { needOf, planRain, readRainRequest, samePlan } from "./rain.js";
import type { Rain, RainPlan } from "./rain.js";
import type { AccountMonth, MonthRange } from "./months.js";
import { assertConsistent, bucketIdsOf, readNewTransaction, readTransactionEdit } from "./transactions.js";
import type { BucketColour } from "./colours.js";
import { BudgetError } from "./types.js";
import type {
  Account, AccountType, ArchiveResult, Bucket, BucketGroup, BucketMonth, BucketMonthView, BucketTable, BucketType, Budget, Category, CategoryInput, Health, MonthSummary, PayeeHistory,
  RegisterTransaction, Transaction,
} from "./types.js";

export { BudgetError } from "./types.js";
export type { BucketColour } from "./colours.js";
export type { AccountMonth, MonthRange } from "./months.js";
export type { Rain, RainFill, RainPlan } from "./rain.js";
export type {
  Account, AccountEditInput, AccountType, ArchiveResult, AssignInput, Bucket, BucketEditInput, BucketMonth, BucketMonthView, GroupMonth, GroupTotals, MonthSummary, BucketGroup, BucketMoveInput, BucketRevertInput, BucketTable, BucketType,
  Budget, BudgetErrorCode, BudgetErrorField, BudgetNameInput, Category, CategoryInput, GroupNameInput, Health, MoveInput, NewAccountInput, NewBucketInput,
  NewTransactionInput, PayeeHistory, RegisterTransaction, SplitLine, Transaction, TransactionEditInput,
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

type Row = Record<string, SQLOutputValue>;

/** A row's category; a split's lines come from transaction_lines, in order. */
function categoryFromRow(row: Row, lines: () => Row[]): Category {
  if (row.kind === "bucket") return { kind: "bucket", bucketId: String(row.bucket_id) };
  if (row.kind === "split") {
    return { kind: "split", lines: lines().map((line) => ({ bucketId: String(line.bucket_id), amount: Number(line.amount), memo: String(line.memo) })) };
  }
  if (row.kind === "transfer") return { kind: "transfer", accountId: String(row.transfer_account_id), transferId: String(row.transfer_id) };
  return { kind: "income" };
}

function bucketIdOf(category: CategoryInput): string | null {
  return category.kind === "bucket" ? category.bucketId : null;
}

function transferAccountOf(category: CategoryInput): string | null {
  return category.kind === "transfer" ? category.accountId : null;
}

function transactionFromRow(row: Row, lines: () => Row[]): Transaction {
  return {
    id: String(row.id),
    budgetId: String(row.budget_id),
    accountId: String(row.account_id),
    date: String(row.date),
    payee: String(row.payee),
    memo: String(row.memo),
    amount: Number(row.amount),
    category: categoryFromRow(row, lines),
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
    available: bucketAvailable({ ledger: Number(row.ledger), moneyIn: Number(row.money_in), moneyOut: Number(row.money_out) }),
    order: Number(row.sort_order),
    archived: row.archived_at !== null,
    archivedAt: row.archived_at === null ? null : String(row.archived_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** A month bound past every real month, for activity in every month. */
const ALL_MONTHS = "9999-12";
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
  // A bucket's money in the current month (the first parameter): its whole transactions plus its split lines,
  // in and out kept apart, and its ledger entries up to that month. Transactions are never dated later.
  const bucketLines = "SELECT amount FROM transactions WHERE bucket_id = buckets.id UNION ALL SELECT amount FROM transaction_lines WHERE bucket_id = buckets.id";
  const withMoney = `buckets.*,
    (SELECT COALESCE(SUM(amount), 0) FROM assignments WHERE bucket_id = buckets.id AND month <= ?) AS ledger,
    (SELECT COALESCE(SUM(amount), 0) FROM (${bucketLines}) WHERE amount > 0) AS money_in,
    (SELECT COALESCE(-SUM(amount), 0) FROM (${bucketLines}) WHERE amount < 0) AS money_out`;
  const findBucketRow = database.prepare(`SELECT ${withMoney} FROM buckets WHERE id = ?`);
  // Active buckets in group and position order, then archived buckets, also by group and position
  // (those whose group was deleted first), with the archive date breaking ties.
  const bucketRows = database.prepare(`
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
    INSERT INTO transactions (id, budget_id, account_id, date, payee, memo, amount, kind, bucket_id, transfer_account_id, transfer_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateTransaction = database.prepare(`
    UPDATE transactions SET date = ?, payee = ?, memo = ?, amount = ?, kind = ?, bucket_id = ?, transfer_account_id = ?, transfer_id = ?, updated_at = ? WHERE id = ?`);
  // The other side of a transfer follows this side's account, date and amount; its payee and memo are its own.
  const updatePartner = database.prepare("UPDATE transactions SET account_id = ?, date = ?, amount = ?, updated_at = ? WHERE id = ?");
  const findPartner = database.prepare("SELECT * FROM transactions WHERE transfer_id = ? AND id <> ?");
  // Every payee's transactions, latest first, so the first row per payee (ignoring case) is its latest.
  const payeeRows = database.prepare("SELECT id, payee, kind, bucket_id, transfer_account_id, transfer_id FROM transactions WHERE budget_id = ? AND payee <> '' ORDER BY date DESC, created_at DESC, rowid DESC");
  const deleteTransactionRow = database.prepare("DELETE FROM transactions WHERE id = ?");
  // Recent activity shows a transfer once, by its money-out side, so it reads "from → to".
  const recentOf = database.prepare(`
    SELECT * FROM transactions WHERE budget_id = ? AND NOT (kind = 'transfer' AND amount > 0)
    ORDER BY date DESC, created_at DESC, rowid DESC LIMIT ?`);
  const linesOf = database.prepare("SELECT * FROM transaction_lines WHERE transaction_id = ? ORDER BY idx");
  const insertLine = database.prepare("INSERT INTO transaction_lines (transaction_id, idx, bucket_id, amount, memo) VALUES (?, ?, ?, ?, ?)");
  const deleteLines = database.prepare("DELETE FROM transaction_lines WHERE transaction_id = ?");
  const fromRow = (row: Row) => transactionFromRow(row, () => linesOf.all(String(row.id)));

  // A split's lines are rewritten whole whenever its category is saved.
  function writeLines(id: string, category: CategoryInput): void {
    deleteLines.run(id);
    if (category.kind === "split") category.lines.forEach((line, idx) => insertLine.run(id, idx, line.bucketId, line.amount, line.memo));
  }
  const incomeOf = database.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE budget_id = ? AND kind = 'income'");
  const ledgerOf = database.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM assignments WHERE budget_id = ?");
  const incomeIn = database.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE budget_id = ? AND kind = 'income' AND substr(date, 1, 7) = ?");
  const firstFutureEntry = database.prepare("SELECT month FROM assignments WHERE bucket_id = ? AND month > ? ORDER BY month LIMIT 1");
  const insertAssignment = database.prepare("INSERT INTO assignments (id, budget_id, bucket_id, month, amount, rain_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const rainEntries = database.prepare("SELECT * FROM assignments WHERE rain_id = ? ORDER BY rowid");
  const deleteRain = database.prepare("DELETE FROM assignments WHERE rain_id = ?");
  // Each bucket's activity per month up to a month: ledger entries, then money in and out of whole transactions
  // and of split lines, by the month they are dated. Parameters: budget, month, three times.
  const activityOf = database.prepare(`
    SELECT bucket_id, month, SUM(ledger) AS ledger, SUM(money_in) AS money_in, SUM(money_out) AS money_out, COUNT(*) AS entries FROM (
      SELECT bucket_id, month, amount AS ledger, 0 AS money_in, 0 AS money_out FROM assignments WHERE budget_id = ?
      UNION ALL
      SELECT bucket_id, substr(date, 1, 7), 0, MAX(amount, 0), MAX(-amount, 0) FROM transactions
      WHERE budget_id = ? AND bucket_id IS NOT NULL
      UNION ALL
      SELECT lines.bucket_id, substr(parent.date, 1, 7), 0, MAX(lines.amount, 0), MAX(-lines.amount, 0)
      FROM transaction_lines AS lines JOIN transactions AS parent ON parent.id = lines.transaction_id
      WHERE parent.budget_id = ?
    ) GROUP BY bucket_id, month ORDER BY bucket_id, month`);
  const findBucket = { get: (id: string) => findBucketRow.get(thisMonth(), id) };
  const bucketsOf = { all: (budgetId: string) => bucketRows.all(thisMonth(), budgetId) };

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
    return fromRow(row);
  }

  // A date must be today or earlier, and no earlier than the first day of the budget's creation month − 12.
  function assertDateAllowed(budget: Budget, date: string): void {
    if (date > calendar.dateOf(clock())) throw new BudgetError("invalid_input", "Transactions can't be dated in the future.", "date");
    const earliest = earliestDate(calendar.monthOf(new Date(budget.createdAt)));
    if (date < earliest) throw new BudgetError("invalid_input", `Transactions can't be dated before ${earliest}.`, "date");
  }

  // Each bucket a category newly files to must be in the transaction's budget and not archived. Buckets the
  // transaction already held are skipped, so it keeps a bucket that's since been archived.
  function assertCategoryAllowed(budgetId: string, category: CategoryInput, held: CategoryInput | null = null): void {
    const kept = new Set(held === null ? [] : bucketIdsOf(held));
    for (const bucketId of bucketIdsOf(category).filter((id) => !kept.has(id))) {
      const row = findBucket.get(bucketId);
      if (!row || String(row.budget_id) !== budgetId) throw new BudgetError("not_found", "Bucket not found.", "category");
      const bucket = bucketFromRow(row);
      if (bucket.archived) throw new BudgetError("bucket_archived", `${bucket.name} is archived. Restore it to file money to it.`, "category");
    }
  }

  /** The money a transaction files to each bucket, keyed by bucket and month. */
  function bucketMoney(transaction: { date: string; amount: number; category: CategoryInput }): Map<string, number> {
    const month = transaction.date.slice(0, 7);
    const lines = transaction.category.kind === "split" ? transaction.category.lines
      : transaction.category.kind === "bucket" ? [{ bucketId: transaction.category.bucketId, amount: transaction.amount }] : [];
    const money = new Map<string, number>();
    for (const line of lines) money.set(`${line.bucketId} ${month}`, (money.get(`${line.bucketId} ${month}`) ?? 0) + line.amount);
    return money;
  }

  // Archiving zeroed the bucket's Available, so money it holds through a transaction can't move until it's
  // restored: no change of amount, month or category that alters what it files there, and no delete.
  // Payee, memo and a date in the same month are still free.
  function assertArchivedKept(existing: Transaction, next: { date: string; amount: number; category: CategoryInput } | null): void {
    const before = bucketMoney(existing);
    const after = next === null ? new Map<string, number>() : bucketMoney(next);
    for (const bucketId of bucketIdsOf(existing.category)) {
      const bucket = openBucket(bucketId);
      if (!bucket.archived) continue;
      const keys = new Set([...before.keys(), ...after.keys()].filter((key) => key.startsWith(`${bucketId} `)));
      if ([...keys].some((key) => before.get(key) !== after.get(key))) {
        const field = next === null ? undefined : next.amount !== existing.amount ? "amount" : next.date.slice(0, 7) !== existing.date.slice(0, 7) ? "date" : "category";
        throw new BudgetError("bucket_archived", `${bucket.name} is archived. Restore it to change its money.`, field);
      }
    }
  }

  function assertOpen(account: Account): void {
    if (account.closed) throw new BudgetError("account_closed", `${account.name} is closed. Reopen it first.`);
  }

  // A transfer's other account is open, in the same budget, and not the account itself.
  function assertTransferTarget(account: Account, otherId: string): void {
    const row = findAccount.get(otherId);
    if (!row) throw new BudgetError("not_found", "Account not found.", "category");
    const other = accountFromRow(row);
    if (other.budgetId !== account.budgetId) throw new BudgetError("invalid_input", "A transfer must be between accounts in the same budget.", "category");
    if (other.id === account.id) throw new BudgetError("invalid_input", "Choose another account to transfer to.", "category");
    assertOpen(other);
  }

  function partnerOf(transaction: Transaction): Transaction | null {
    if (transaction.category.kind !== "transfer") return null;
    const row = findPartner.get(transaction.category.transferId, transaction.id);
    return row ? fromRow(row) : null;
  }

  function insertRow(id: string, account: Account, row: { date: string; payee: string; memo: string; amount: number; category: CategoryInput }, transferId: string | null, now: string): void {
    insertTransaction.run(id, account.budgetId, account.id, row.date, row.payee, row.memo, row.amount, row.category.kind, bucketIdOf(row.category), transferAccountOf(row.category), transferId, now, now);
  }

  // The other side of a new transfer: the opposite amount on the same date, pointing back, with the memo copied.
  function insertPartner(account: Account, side: { date: string; memo: string; amount: number; category: CategoryInput }, transferId: string, now: string): void {
    const other = openAccount(transferAccountOf(side.category)!);
    insertRow(randomUUID(), other, { date: side.date, payee: "", memo: side.memo, amount: -side.amount, category: { kind: "transfer", accountId: account.id } }, transferId, now);
  }

  /** The months the budget can be viewed in: creation month − 12 … current month + 12. */
  function monthRange(budgetId: string): MonthRange {
    return monthRangeOf(calendar.monthOf(new Date(openBudget(budgetId).createdAt)), thisMonth());
  }

  /** Every transaction of the account, oldest first, each with the balance just after it. */
  function registerOf(account: Account): RegisterTransaction[] {
    let balance = account.startingBalance;
    return transactionsOf.all(account.id).map((row) => {
      const found = fromRow(row);
      balance += found.amount;
      return { ...found, runningBalance: balance };
    });
  }

  function accountMonthOf(account: Account, month: string): AccountMonth {
    const upTo = registerOf(account).filter((row) => row.date.slice(0, 7) <= month);
    return {
      balance: upTo.at(-1)?.runningBalance ?? account.startingBalance,
      transactions: upTo.filter((row) => row.date.startsWith(month)).reverse(),
    };
  }

  function readyToAssign(budgetId: string): number {
    return sumReadyToAssign(listAccounts(budgetId), Number(incomeOf.get(budgetId)?.total), Number(ledgerOf.get(budgetId)?.total));
  }

  /** Each bucket's activity per month, every month, oldest first. */
  function activityByBucket(budgetId: string): Map<string, MonthActivity[]> {
    const byBucket = new Map<string, MonthActivity[]>();
    for (const row of activityOf.all(budgetId, budgetId, budgetId)) {
      const id = String(row.bucket_id);
      const list = byBucket.get(id) ?? [];
      list.push({ month: String(row.month), ledger: Number(row.ledger), moneyIn: Number(row.money_in), moneyOut: Number(row.money_out), entries: Number(row.entries) });
      byBucket.set(id, list);
    }
    return byBucket;
  }

  /** `activity` runs past `month` so `takeable` can see later months; the month's figures ignore them. */
  function withFigures(bucket: Bucket, activity: readonly MonthActivity[], month: string): BucketMonth {
    const figures = monthFigures(activity, month);
    return { ...bucket, month, ...figures, need: needOf(bucket, figures, month), takeable: Math.max(0, lowestAvailableFrom(activity, month)) };
  }

  /** The lowest Available the bucket has from `month` on, later months' ledger entries included. */
  function lowestAvailable(bucket: Bucket, month: string): number {
    return lowestAvailableFrom(activityByBucket(bucket.budgetId).get(bucket.id) ?? [], month);
  }

  function bucketInMonth(bucket: Bucket, month: string): BucketMonth {
    return withFigures(bucket, activityByBucket(bucket.budgetId).get(bucket.id) ?? [], month);
  }

  // Every bucket's activity counts, shown or not: an archived bucket with activity that month is shown anyway.
  function summaryOf(budgetId: string, month: string, activity: Map<string, MonthActivity[]>): MonthSummary {
    const inMonth = [...activity.values()].flat().filter((entry) => entry.month === month);
    const sum = (pick: (entry: MonthActivity) => number) => inMonth.reduce((total, entry) => total + pick(entry), 0);
    const moneyIn = sum((entry) => entry.moneyIn);
    return {
      month,
      readyToAssign: readyToAssign(budgetId),
      income: Number(incomeIn.get(budgetId, month)?.total) + moneyIn,
      assigned: sum((entry) => entry.ledger) + moneyIn,
      spent: sum((entry) => entry.moneyOut),
    };
  }

  function bucketMonthOf(budgetId: string, month: string): BucketMonthView {
    const activity = activityByBucket(budgetId);
    const buckets = bucketsOf.all(budgetId).map(bucketFromRow)
      .filter((bucket) => shownIn(bucket, activity.get(bucket.id) ?? [], month))
      .map((bucket) => withFigures(bucket, activity.get(bucket.id) ?? [], month));
    const groups = groupsOf.all(budgetId).map(groupFromRow)
      .map((group) => ({ ...group, ...totalsOf(buckets.filter((bucket) => bucket.groupId === group.id)) }));
    return { summary: summaryOf(budgetId, month, activity), groups, buckets };
  }

  /** The rain for a month, planned from the month view: active buckets in bucket order (ADR-0005). */
  function rainPlanOf(budgetId: string, month: unknown): { month: string; plan: RainPlan } {
    const chosen = readMonth(month, monthRange(budgetId));
    if (chosen < thisMonth()) throw new BudgetError("invalid_input", "Rain only into this month or a later one.", "month");
    const active = bucketMonthOf(budgetId, chosen).buckets.filter((bucket) => !bucket.archived);
    return { month: chosen, plan: planRain(active, readyToAssign(budgetId)) };
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
    monthRange,
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
      return readyToAssign(budgetId);
    },
    bucketMonth(budgetId: string, month: string): BucketMonthView {
      const chosen = readMonth(month, monthRange(budgetId));
      return bucketMonthOf(budgetId, chosen);
    },
    /** Adds a signed ledger entry: positive assigns from Ready to assign, negative takes back to it. */
    assign(bucketId: string, input: unknown): BucketMonth {
      return transaction(() => {
        const bucket = openBucket(bucketId);
        const entry = readAssignment(input, monthRange(bucket.budgetId));
        assertAssignable(bucket, entry, readyToAssign(bucket.budgetId), lowestAvailable(bucket, entry.month));
        insertAssignment.run(randomUUID(), bucket.budgetId, bucket.id, entry.month, entry.amount, null, timestamp());
        return bucketInMonth(openBucket(bucketId), entry.month);
      });
    },
    /** What rain would give each bucket in the month, without writing anything. */
    planRain(budgetId: string, month: string): RainPlan {
      return rainPlanOf(budgetId, month).plan;
    },
    /**
     * Fills the month's needs from Ready to assign, every fill in one transaction under one rain id. Sent with
     * `{ expect: plan }`, the preview it was confirmed from, it is refused with rain_changed if the plan differs now.
     */
    rain(budgetId: string, month: string, input?: unknown): Rain {
      const expected = readRainRequest(input);
      return transaction(() => {
        const { month: chosen, plan } = rainPlanOf(budgetId, month);
        if (expected && !samePlan(expected, plan)) {
          throw new BudgetError("rain_changed", "The buckets have changed since this preview. Check the new amounts and rain again.");
        }
        if (plan.fills.length === 0) return plan;
        const rainId = randomUUID();
        const now = timestamp();
        for (const fill of plan.fills) insertAssignment.run(randomUUID(), budgetId, fill.bucketId, chosen, fill.amount, rainId, now);
        return { rainId, ...plan };
      });
    },
    /** Reverses a whole rain, or refuses with money_moved if any bucket now holds less than the rain gave it, in its month or later. */
    undoRain(rainId: string): void {
      transaction(() => {
        const entries = rainEntries.all(rainId);
        if (entries.length === 0) throw new BudgetError("not_found", "Rain not found.");
        for (const entry of entries) {
          // Removing the fill lowers its month and every later one, so each must still hold it.
          const bucket = openBucket(String(entry.bucket_id));
          if (lowestAvailable(bucket, String(entry.month)) < Number(entry.amount)) {
            throw new BudgetError("money_moved", `Money has moved out of ${bucket.name} since it rained, so this rain can't be undone.`);
          }
        }
        deleteRain.run(rainId);
      });
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
        if (next.category.kind === "transfer") assertTransferTarget(account, next.category.accountId);
        const now = timestamp();
        const id = randomUUID();
        const transferId = next.category.kind === "transfer" ? randomUUID() : null;
        insertRow(id, account, next, transferId, now);
        writeLines(id, next.category);
        if (transferId) insertPartner(account, next, transferId, now);
        return openTransaction(id);
      });
    },
    openTransaction,
    // A closed account's balance stays 0, so its transactions' amounts can't change and none can be deleted.
    // A transfer edit carries the date and amount to the other side (whose account must then be open too);
    // the payee and memo stay this side's own. Refiling to or from a transfer creates or deletes the other side.
    editTransaction(id: string, input: unknown): Transaction {
      const edit = readTransactionEdit(input);
      return transaction(() => {
        const existing = openTransaction(id);
        const account = openAccount(existing.accountId);
        const next = { ...existing, ...edit };
        if (next.amount !== existing.amount) assertOpen(account);
        assertConsistent(next);
        if (edit.date !== undefined) assertDateAllowed(openBudget(existing.budgetId), next.date);
        assertCategoryAllowed(existing.budgetId, next.category, existing.category);
        assertArchivedKept(existing, next);
        const otherId = transferAccountOf(next.category);
        const sameTransfer = otherId !== null && transferAccountOf(existing.category) === otherId;
        if (otherId && !sameTransfer) assertTransferTarget(account, otherId);
        const partner = partnerOf(existing);
        // Money leaves the old other account when the pair's amount changes, it moves away, or it's removed.
        if (partner && (next.amount !== existing.amount || !sameTransfer)) assertOpen(openAccount(partner.accountId));
        const now = timestamp();
        const transferId = !otherId ? null : partner && existing.category.kind === "transfer" ? existing.category.transferId : randomUUID();
        if (partner && !otherId) deleteTransactionRow.run(partner.id);
        updateTransaction.run(next.date, next.payee, next.memo, next.amount, next.category.kind, bucketIdOf(next.category), otherId, transferId, now, id);
        writeLines(id, next.category);
        if (partner && otherId) updatePartner.run(otherId, next.date, -next.amount, now, partner.id);
        if (!partner && transferId) insertPartner(account, next, transferId, now);
        return openTransaction(id);
      });
    },
    // Deleting either side of a transfer deletes both. A transaction holding money in an archived bucket stays.
    deleteTransaction(id: string): void {
      transaction(() => {
        const existing = openTransaction(id);
        assertOpen(openAccount(existing.accountId));
        assertArchivedKept(existing, null);
        const partner = partnerOf(existing);
        if (partner) {
          assertOpen(openAccount(partner.accountId));
          deleteTransactionRow.run(partner.id);
        }
        deleteTransactionRow.run(id);
      });
    },
    /** The budget's latest transactions, newest first, at most `limit` (1 to 100); a transfer appears once. */
    listBudgetTransactions(budgetId: string, input: unknown): Transaction[] {
      const limit = (input as { limit?: unknown } | null)?.limit;
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
        throw new BudgetError("invalid_input", "Limit must be a whole number from 1 to 100.");
      }
      openBudget(budgetId);
      return recentOf.all(budgetId, limit as number).map(fromRow);
    },
    /** The account's register, newest first, each with the balance just after it. */
    listTransactions(accountId: string): { transactions: RegisterTransaction[] } {
      return { transactions: registerOf(openAccount(accountId)).reverse() };
    },
    /** Each account's balance at the end of the month, by account ID; closed accounts included. */
    accountBalances(budgetId: string, month: string): Record<string, number> {
      const chosen = readMonth(month, monthRange(budgetId));
      return Object.fromEntries(listAccounts(budgetId).map((account) => [account.id, accountMonthOf(account, chosen).balance]));
    },
    /**
     * The account in one month: its balance at the end of the month (today's, for the current month, since
     * nothing is dated later) and that month's rows, newest first, with running balances over all earlier ones.
     */
    accountMonth(accountId: string, month: string): AccountMonth {
      const account = openAccount(accountId);
      return accountMonthOf(account, readMonth(month, monthRange(account.budgetId)));
    },
    /** Every payee in the budget with its latest transaction's category, sorted by name; the latest spelling wins. */
    payees(budgetId: string): PayeeHistory[] {
      openBudget(budgetId);
      const latest = new Map<string, PayeeHistory>();
      for (const row of payeeRows.all(budgetId)) {
        const key = String(row.payee).toLowerCase();
        if (!latest.has(key)) latest.set(key, { payee: String(row.payee), category: categoryFromRow(row, () => linesOf.all(String(row.id))) });
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
    // Owner rule (2026-11-17, ADR-0003): refused while overspent or while a later month has ledger entries.
    // A positive Available in the current month goes back to Ready to assign as a take in that month.
    // Idempotent: archiving an archived bucket returns it unchanged with nothing returned. Restore doesn't
    // re-assign what was returned.
    archiveBucket(id: string): ArchiveResult {
      return transaction(() => {
        const bucket = openBucket(id);
        if (bucket.archived) return { bucket, returned: 0 };
        if (bucket.available < 0) throw new BudgetError("bucket_overspent", "A bucket can't be archived while its Available is negative.");
        const current = thisMonth();
        const future = firstFutureEntry.get(bucket.id, current);
        if (future) throw new BudgetError("bucket_has_future", `${bucket.name} has money assigned in ${monthName(String(future.month), current)}.`);
        const returned = bucket.available;
        if (returned > 0) insertAssignment.run(randomUUID(), bucket.budgetId, bucket.id, current, -returned, null, timestamp());
        const archived = writeBucket({ ...openBucket(id), archivedAt: timestamp() });
        if (bucket.groupId) renumberBuckets(activeIds(bucket.groupId));
        return { bucket: archived, returned };
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
