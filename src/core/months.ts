// Months are "YYYY-MM" strings in the server's time zone (ADR-0007). The months you can view run from
// 12 months before the budget began to 12 months after the current month (GLOSSARY: Month).

import { BudgetError } from "./types.js";
import type { RegisterTransaction } from "./types.js";

export interface MonthRange {
  first: string;
  /** This month, in the server's time zone (ADR-0007). */
  current: string;
  last: string;
}

/** An account in one month: its balance at the end of the month, and the register rows dated in it. */
export interface AccountMonth {
  balance: number;
  transactions: RegisterTransaction[];
}

/** Reads a "YYYY-MM" that lies inside the range, or throws invalid_input. */
export function readMonth(value: unknown, range: MonthRange): string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new BudgetError("invalid_input", "Month must be YYYY-MM.", "month");
  }
  if (value < range.first || value > range.last) {
    throw new BudgetError("invalid_input", `Month must be from ${range.first} to ${range.last}.`, "month");
  }
  return value;
}

/** The month `count` months after (or before, if negative) "YYYY-MM". */
export function addMonths(month: string, count: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" of the month's last day. */
export function lastDayOf(month: string): string {
  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return `${month}-${String(days).padStart(2, "0")}`;
}

export function monthRangeOf(creationMonth: string, currentMonth: string): MonthRange {
  return { first: addMonths(creationMonth, -12), current: currentMonth, last: addMonths(currentMonth, 12) };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "December" for a month in the current month's year, "January 2027" otherwise. */
export function monthName(month: string, currentMonth: string): string {
  const name = MONTH_NAMES[Number(month.slice(5, 7)) - 1]!;
  return month.slice(0, 4) === currentMonth.slice(0, 4) ? name : `${name} ${month.slice(0, 4)}`;
}
