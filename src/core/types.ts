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
  /** Integer cents. 0 until assigning exists. */
  available: number;
  /** Position within its group. */
  order: number;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

/** What a transaction is filed under. Only Income exists so far; buckets, splits and transfers come next. */
export type Category = { kind: "income" };

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
  category: Category;
}

export type TransactionEditInput = Partial<NewTransactionInput>;

export type BudgetErrorCode = "invalid_input" | "not_found" | "name_taken" | "balance_not_zero" | "group_not_empty" | "bucket_overspent" | "bucket_changed" | "account_closed";

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
