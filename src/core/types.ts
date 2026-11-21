import type { BucketColour } from "./colours.js";

export interface Budget {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetNameInput {
  name: string;
}

export interface Health {
  status: "ok";
}

export type AccountType = "checking" | "savings" | "credit-card" | "cash";

export interface Account {
  id: string;
  budgetId: string;
  name: string;
  type: AccountType;
  /** Integer cents, signed; a card's debt is negative. */
  startingBalance: number;
  /** YYYY-MM-DD, a real calendar date. */
  startingDate: string;
  /** Integer cents: the starting balance plus every one of the account's transactions, whatever their date (ADR-0006). */
  balance: number;
  order: number;
  closed: boolean;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewAccountInput {
  name: string;
  type: AccountType;
  startingBalance: number;
  startingDate: string;
}

export interface AccountEditInput {
  name?: string;
  startingBalance?: number;
  startingDate?: string;
}

export type BucketType = "recurring" | "goal" | "plain";

export interface BucketGroup {
  id: string;
  budgetId: string;
  /** 1 to 60 code points, trimmed, unique per budget ignoring case. */
  name: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface Bucket {
  id: string;
  budgetId: string;
  /** null only for an archived bucket whose group was deleted. */
  groupId: string | null;
  /** 1 to 60 code points, trimmed, unique per budget ignoring case, archived buckets included. */
  name: string;
  colour: BucketColour;
  type: BucketType;
  /** Integer cents > 0: per month (recurring) or the goal amount (goal); null for plain. */
  amount: number | null;
  /** "YYYY-MM", goal only. */
  goalMonth: string | null;
  /** Integer cents: the bucket's Available in the current month (every transaction plus ledger entries up to this month). */
  available: number;
  /** Position within its group. */
  order: number;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A bucket's figures in one month (ADR-0003, ADR-0004). All integer cents. */
export interface BucketMonth extends Bucket {
  /** "YYYY-MM". */
  month: string;
  /** Ledger entries this month plus money paid directly into the bucket this month. */
  assigned: number;
  /** ≥ 0: the gross money out this month. Money back in never reduces it. */
  spent: number;
  /** The previous month's Available, negative included. */
  carriedIn: number;
  /** carriedIn + assigned − spent, in this month (this replaces the current-month figure on Bucket). */
  available: number;
  /** What rain would give the bucket this month (ADR-0005); 0 for plain and archived buckets. */
  need: number;
  /** ≥ 0: the most a take in this month can be, the lowest Available from this month on (later months included). */
  takeable: number;
}

export interface GroupTotals {
  assigned: number;
  spent: number;
  available: number;
}

/** A group with the totals of the buckets it shows that month. */
export type GroupMonth = BucketGroup & GroupTotals;

/**
 * The summary strip for one month (ADR-0003). Ready to assign is the pool, the same figure in every month.
 * Money paid directly into buckets counts in both Income and Assigned, so the month's change in Ready to
 * assign is always income − assigned.
 */
export interface MonthSummary {
  month: string;
  readyToAssign: number;
  /** Income transactions dated in the month + money paid directly into buckets that month. */
  income: number;
  /** Ledger entries for the month + money paid directly into buckets that month. */
  assigned: number;
  /** Gross money out of buckets that month. */
  spent: number;
}

/** The Buckets page for one month. */
export interface BucketMonthView {
  summary: MonthSummary;
  /** Every group, in order, with its month totals. */
  groups: GroupMonth[];
  /** Active buckets, then archived ones with a ledger entry or a transaction that month, in bucket order. */
  buckets: BucketMonth[];
}

export interface AssignInput {
  /** "YYYY-MM", inside the month range. */
  month: string;
  /** Signed integer cents, never 0: positive assigns, negative takes. */
  amount: number;
}

export interface BucketTable {
  groups: BucketGroup[];
  buckets: Bucket[];
}

export interface GroupNameInput {
  name: string;
}

export interface NewBucketInput {
  name: string;
  groupId?: string;
  newGroupName?: string;
  colour?: BucketColour;
  type: BucketType;
  amount?: number | null;
  goalMonth?: string | null;
}

export type BucketEditInput = Partial<NewBucketInput>;

export interface MoveInput {
  index: number;
}

export interface BucketMoveInput {
  groupId: string;
  index: number;
}

export interface ArchiveResult {
  bucket: Bucket;
  /** Cents sent back to Ready to assign. */
  returned: number;
}

/**
 * What a transaction is filed under. Income is always positive; a bucket takes either sign, where money in counts
 * as assigned to it, never as negative spending (ADR-0003). A split spreads one transaction over two or more
 * buckets. A transfer names the other account of the pair, and both sides share its transferId; it touches no
 * bucket and never Ready to assign.
 */
export type Category =
  | { kind: "income" }
  | { kind: "bucket"; bucketId: string }
  | { kind: "split"; lines: SplitLine[] }
  | { kind: "transfer"; accountId: string; transferId: string };

/** A category as a client sends it: the server assigns a new transfer's transferId, so it may be left out. */
export type CategoryInput = Exclude<Category, { kind: "transfer" }> | { kind: "transfer"; accountId: string; transferId?: string };

/** One bucket's share of a split: the same sign as the transaction, never 0; a split's lines sum to its amount. */
export interface SplitLine {
  bucketId: string;
  amount: number;
  /** 0 to 500 code points, trimmed. */
  memo: string;
}

export interface Transaction {
  id: string;
  budgetId: string;
  accountId: string;
  /** YYYY-MM-DD: today or earlier (server time zone), and no earlier than the first day of the budget's creation month − 12. */
  date: string;
  /** 0 to 120 code points, trimmed. */
  payee: string;
  /** 0 to 500 code points, trimmed. */
  memo: string;
  /** Signed integer cents, never 0. Income is always positive. */
  amount: number;
  category: Category;
  createdAt: string;
  updatedAt: string;
}

/** A transaction in its account's register, with the account's balance just after it. */
export interface RegisterTransaction extends Transaction {
  runningBalance: number;
}

export interface NewTransactionInput {
  /** Defaults to today in the server's time zone. */
  date?: string;
  payee?: string;
  memo?: string;
  amount: number;
  category: CategoryInput;
}

export type TransactionEditInput = Partial<NewTransactionInput>;

/** A payee and the category of its latest transaction, for filling in the category as the payee is typed. */
export interface PayeeHistory {
  payee: string;
  category: Category;
}

export type BudgetErrorCode = "invalid_input" | "not_found" | "name_taken" | "balance_not_zero" | "group_not_empty" | "bucket_overspent" | "bucket_changed" | "account_closed" | "bucket_archived" | "bucket_has_future" | "not_enough_ready" | "not_enough_available" | "money_moved" | "rain_changed";

/** The input a validation error belongs to, so clients can mark the right field without reading the message. */
export type BudgetErrorField = "name" | "group" | "colour" | "type" | "amount" | "month" | "date" | "payee" | "memo" | "category";

/** An edit that undoes an earlier edit: bucket fields plus the `updatedAt` the earlier edit left behind. */
export type BucketRevertInput = BucketEditInput & { revertOf: string };

export class BudgetError extends Error {
  constructor(
    public readonly code: BudgetErrorCode,
    message: string,
    public readonly field?: BudgetErrorField,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}
