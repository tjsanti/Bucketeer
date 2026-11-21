// The assignment ledger and a bucket's figures month by month (ADR-0003, ADR-0004). Every assign and take is
// one signed entry for a bucket and month; money paid directly into a bucket counts as assigned to it in
// the month it is dated, and money out is Spent, gross.
import { MAX_CENTS } from "./accounts.js";
import { formatMoney } from "./money.js";
import { readMonth } from "./months.js";
import type { MonthRange } from "./months.js";
import { BudgetError } from "./types.js";
import type { AssignInput, Bucket, BucketMonth, GroupTotals } from "./types.js";

/** One bucket's activity in one month, all integer cents. */
export interface MonthActivity {
  month: string;
  /** Σ ledger entries. */
  ledger: number;
  /** Σ positive transaction lines. */
  moneyIn: number;
  /** Σ |negative transaction lines|. */
  moneyOut: number;
  /** How many ledger entries and transaction lines there are, so a month whose money nets to 0 still counts as activity. */
  entries: number;
}

export interface MonthFigures {
  assigned: number;
  spent: number;
  carriedIn: number;
  available: number;
}

function invalid(message: string, field?: "amount" | "month"): never {
  throw new BudgetError("invalid_input", message, field);
}

export function readAssignment(input: unknown, range: MonthRange): AssignInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid("An assignment object is required.");
  const fields = input as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (key !== "month" && key !== "amount") invalid(`Assignment field "${key}" is not supported.`);
  }
  const amount = fields.amount;
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount as number) > MAX_CENTS) {
    invalid("Amount must be a whole number of cents other than 0, between -99,999,999,999 and 99,999,999,999.", "amount");
  }
  return { month: readMonth(fields.month, range), amount: amount as number };
}

/**
 * A bucket's figures in `month` from its activity in every month up to it (later months are ignored).
 * Available carries forward, negative included (ADR-0004).
 */
export function monthFigures(activity: readonly MonthActivity[], month: string): MonthFigures {
  let carriedIn = 0;
  let assigned = 0;
  let spent = 0;
  for (const entry of activity) {
    if (entry.month < month) carriedIn += entry.ledger + entry.moneyIn - entry.moneyOut;
    else if (entry.month === month) {
      assigned += entry.ledger + entry.moneyIn;
      spent += entry.moneyOut;
    }
  }
  return { assigned, spent, carriedIn, available: carriedIn + assigned - spent };
}

/**
 * The lowest Available from `month` on: that month's and every later month's with activity. A take in
 * `month` lowers each of them, since Available carries forward (ADR-0004), so this is the most it can take.
 */
export function lowestAvailableFrom(activity: readonly MonthActivity[], month: string): number {
  const later = activity.filter((entry) => entry.month > month).map((entry) => entry.month);
  return Math.min(...[month, ...later].map((each) => monthFigures(activity, each).available));
}

/** Whether a bucket appears in a month: every active bucket, and an archived one only with activity that month. */
export function shownIn(bucket: Bucket, activity: readonly MonthActivity[], month: string): boolean {
  return !bucket.archived || activity.some((entry) => entry.month === month && entry.entries > 0);
}

/**
 * Checks a signed entry against the pool and the bucket (ADR-0001, ADR-0003). `available` is the lowest
 * Available from the entry's month on (lowestAvailableFrom), so a take never leaves a later month overspent.
 */
export function assertAssignable(bucket: Bucket, entry: AssignInput, readyToAssign: number, available: number): void {
  if (bucket.archived) throw new BudgetError("bucket_archived", `${bucket.name} is archived. Restore it to assign money to it.`);
  if (entry.amount > 0 && entry.amount > readyToAssign) {
    throw new BudgetError("not_enough_ready", readyToAssign > 0 ? `Only ${formatMoney(readyToAssign, { symbol: true })} is ready to assign.` : "Nothing is ready to assign.", "amount");
  }
  if (entry.amount < 0 && -entry.amount > Math.max(0, available)) {
    throw new BudgetError("not_enough_available", available > 0
      ? `Only ${formatMoney(available, { symbol: true })} is available in ${bucket.name}.`
      : `${bucket.name} has nothing available to take.`, "amount");
  }
}

export function totalsOf(buckets: readonly BucketMonth[]): GroupTotals {
  return buckets.reduce((sum, bucket) => ({
    assigned: sum.assigned + bucket.assigned,
    spent: sum.spent + bucket.spent,
    available: sum.available + bucket.available,
  }), { assigned: 0, spent: 0, available: 0 });
}
