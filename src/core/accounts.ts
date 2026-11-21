import { BudgetError } from "./types.js";
import type { AccountEditInput, AccountType, NewAccountInput } from "./types.js";

export const MAX_ACCOUNT_NAME_LENGTH = 120;
export const MAX_CENTS = 99_999_999_999;
export const ACCOUNT_TYPES: readonly AccountType[] = ["checking", "savings", "credit-card", "cash"];

// The one place an account's balance is computed: the starting balance plus the sum of all its
// transactions, including any dated before the starting date (ADR-0006).
export function accountBalance(account: { startingBalance: number; activity: number }): number {
  return account.startingBalance + account.activity;
}

// Owner rule: an account's starting balance counts as money to assign, and a card's negative
// opening balance reduces it. Closed accounts are included. Income adds to it (ADR-0002), and every entry
// in the assignment ledger, in any month, takes from it (ADR-0001, ADR-0003). It may be negative.
export function sumReadyToAssign(accounts: readonly { startingBalance: number }[], income: number, assigned: number): number {
  return accounts.reduce((total, account) => total + account.startingBalance, income) - assigned;
}

export function accountKey(name: string): string {
  return name.toLowerCase();
}

function invalid(message: string): never {
  throw new BudgetError("invalid_input", message);
}

function readObject(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid("An account object is required.");
  const fields = input as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (allowed.includes(key)) continue;
    invalid(key === "type" ? "An account's type cannot be changed." : `Account field "${key}" is assigned by the server or not supported.`);
  }
  return fields;
}

function readName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || [...name].length > MAX_ACCOUNT_NAME_LENGTH) invalid(`Account name must be between 1 and ${MAX_ACCOUNT_NAME_LENGTH} characters.`);
  if (name.includes("\0")) invalid("Account name cannot contain null characters.");
  return name;
}

function readType(value: unknown): AccountType {
  if (!ACCOUNT_TYPES.includes(value as AccountType)) invalid(`Account type must be one of: ${ACCOUNT_TYPES.join(", ")}.`);
  return value as AccountType;
}

function readCents(value: unknown): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > MAX_CENTS) {
    invalid("Starting balance must be a whole number of cents between -99,999,999,999 and 99,999,999,999.");
  }
  return value as number;
}

function readDate(value: unknown): string {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return value as string;
  }
  return invalid("Starting date must be a real date written YYYY-MM-DD.");
}

export function readNewAccount(input: unknown): NewAccountInput {
  const fields = readObject(input, ["name", "type", "startingBalance", "startingDate"]);
  return {
    name: readName(fields.name),
    type: readType(fields.type),
    startingBalance: readCents(fields.startingBalance),
    ...("startingDate" in fields && { startingDate: readDate(fields.startingDate) }),
  };
}

export function readAccountEdit(input: unknown): AccountEditInput {
  const fields = readObject(input, ["name", "startingBalance", "startingDate"]);
  const edit: AccountEditInput = {};
  if ("name" in fields) edit.name = readName(fields.name);
  if ("startingBalance" in fields) edit.startingBalance = readCents(fields.startingBalance);
  if ("startingDate" in fields) edit.startingDate = readDate(fields.startingDate);
  if (Object.keys(edit).length === 0) invalid("Provide a name, starting balance, or starting date to change.");
  return edit;
}
