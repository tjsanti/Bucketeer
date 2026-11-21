// Transaction input rules. Rules that need the database or the clock (dates, closed accounts) live in index.ts.
import { MAX_CENTS } from "./accounts.js";
import { BudgetError } from "./types.js";
import type { BudgetErrorField, CategoryInput, TransactionEditInput } from "./types.js";

export const MAX_PAYEE_LENGTH = 120;
export const MAX_MEMO_LENGTH = 500;

/** A transaction's fields after validation; date stays optional so the core can default it to today. */
export interface TransactionFields {
  date?: string;
  payee?: string;
  memo?: string;
  amount?: number;
  category?: CategoryInput;
}

function invalid(message: string, field?: BudgetErrorField): never {
  throw new BudgetError("invalid_input", message, field);
}

const allowed = ["date", "payee", "memo", "amount", "category"];

function readObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid("A transaction object is required.");
  const fields = input as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) invalid(`Transaction field "${key}" is assigned by the server or not supported.`);
  }
  return fields;
}

function readText(value: unknown, max: number, what: "Payee" | "Memo"): string {
  const field = what === "Payee" ? "payee" : "memo";
  if (typeof value !== "string") invalid(`${what} must be text.`, field);
  const text = value.trim();
  if ([...text].length > max) invalid(`${what} must be at most ${max} characters.`, field);
  if (text.includes("\0")) invalid(`${what} cannot contain null characters.`, field);
  return text;
}

function readAmount(value: unknown): number {
  if (!Number.isSafeInteger(value) || value === 0 || Math.abs(value as number) > MAX_CENTS) {
    invalid("Amount must be a whole number of cents, not 0, between -99,999,999,999 and 99,999,999,999.", "amount");
  }
  return value as number;
}

/** A real calendar date written YYYY-MM-DD. */
export function readDate(value: unknown): string {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return value as string;
  }
  return invalid("Date must be a real date written YYYY-MM-DD.", "date");
}

function readCategory(value: unknown): CategoryInput {
  const fields = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const keys = Object.keys(fields).sort().join();
  if (fields.kind === "income" && keys === "kind") return { kind: "income" };
  if (fields.kind === "bucket" && keys === "bucketId,kind" && typeof fields.bucketId === "string" && fields.bucketId !== "") {
    return { kind: "bucket", bucketId: fields.bucketId };
  }
  // A transfer's transferId belongs to the pair, so one sent back (an Undo resending the whole category) is ignored.
  if (fields.kind === "transfer" && ["accountId,kind", "accountId,kind,transferId"].includes(keys) && typeof fields.accountId === "string" && fields.accountId !== "") {
    return { kind: "transfer", accountId: fields.accountId };
  }
  return invalid("Category must be Income, a bucket or a transfer account.", "category");
}

export function sameCategory(a: CategoryInput, b: CategoryInput): boolean {
  if (a.kind === "bucket") return b.kind === "bucket" && a.bucketId === b.bucketId;
  if (a.kind === "transfer") return b.kind === "transfer" && a.accountId === b.accountId;
  return a.kind === b.kind;
}

function readFields(fields: Record<string, unknown>): TransactionFields {
  const read: TransactionFields = {};
  if ("date" in fields) read.date = readDate(fields.date);
  if ("payee" in fields) read.payee = readText(fields.payee, MAX_PAYEE_LENGTH, "Payee");
  if ("memo" in fields) read.memo = readText(fields.memo, MAX_MEMO_LENGTH, "Memo");
  if ("amount" in fields) read.amount = readAmount(fields.amount);
  if ("category" in fields) read.category = readCategory(fields.category);
  return read;
}

export function readNewTransaction(input: unknown): TransactionFields & { amount: number; category: CategoryInput } {
  const fields = readObject(input);
  if (!("amount" in fields)) invalid("An amount is required.", "amount");
  if (!("category" in fields)) invalid("A category is required.", "category");
  return readFields(fields) as TransactionFields & { amount: number; category: CategoryInput };
}

export function readTransactionEdit(input: unknown): TransactionEditInput {
  const edit = readFields(readObject(input));
  if (Object.keys(edit).length === 0) invalid("Provide a date, payee, memo, amount or category to change.");
  return edit;
}

/** The rules between amount and category, checked on the transaction as it will be saved. */
export function assertConsistent(transaction: { amount: number; category: CategoryInput }): void {
  if (transaction.category.kind === "income" && transaction.amount <= 0) invalid("Income must be more than 0.00.", "amount");
}
