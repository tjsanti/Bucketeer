import { MAX_CENTS } from "./accounts.js";
import { isBucketColour } from "./colours.js";
import { BudgetError } from "./types.js";
import type { BudgetErrorField } from "./types.js";
import type { BucketColour } from "./colours.js";
import type { BucketType } from "./types.js";

export const MAX_BUCKET_NAME_LENGTH = 60;
export const BUCKET_TYPES: readonly BucketType[] = ["recurring", "goal", "plain"];

// The one place a bucket's Available is computed: the sum of its transaction lines across all dates, money
// in and money out (PR 1). Assigning and the month view add the ledger.
export function bucketAvailable(activity: { moneyIn: number; moneyOut: number }): number {
  return activity.moneyIn - activity.moneyOut;
}

export function nameKey(name: string): string {
  return name.toLowerCase();
}

function invalid(message: string, field?: BudgetErrorField): never {
  throw new BudgetError("invalid_input", message, field);
}

function readObject(input: unknown, what: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid(`A ${what} object is required.`);
  const fields = input as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) invalid(`${what[0]!.toUpperCase()}${what.slice(1)} field "${key}" is assigned by the server or not supported.`);
  }
  return fields;
}

function readName(value: unknown, what: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  const field = what === "Group" ? "group" : "name";
  if (!name || [...name].length > MAX_BUCKET_NAME_LENGTH) invalid(`${what} name must be between 1 and ${MAX_BUCKET_NAME_LENGTH} characters.`, field);
  if (name.includes("\0")) invalid(`${what} name cannot contain null characters.`, field);
  return name;
}

function readId(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) invalid(`${what} ID must be a non-empty string.`, what === "Group" ? "group" : undefined);
  return value;
}

function readColour(value: unknown): BucketColour {
  if (!isBucketColour(value)) invalid("Colour must be one of the 16 bucket colours, such as sky or plum.", "colour");
  return value;
}

function readType(value: unknown): BucketType {
  if (!BUCKET_TYPES.includes(value as BucketType)) invalid(`Bucket type must be one of: ${BUCKET_TYPES.join(", ")}.`, "type");
  return value as BucketType;
}

function readAmount(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_CENTS) {
    invalid("Amount must be a whole number of cents between 1 and 99,999,999,999.", "amount");
  }
  return value as number;
}

function readMonth(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(value)) invalid("Goal month must be a real month written YYYY-MM.", "month");
  return value;
}

export function readGroupName(input: unknown): string {
  const fields = readObject(input, "group", ["name"]);
  return readName(fields.name, "Group");
}

/** A 0-based position. Out-of-range values are clamped by the caller. */
export function readIndex(value: unknown): number {
  if (!Number.isSafeInteger(value)) invalid("Index must be a whole number.");
  return value as number;
}

export function readMove(input: unknown): { index: number } {
  const fields = readObject(input, "move", ["index"]);
  return { index: readIndex(fields.index) };
}

export function readBucketMove(input: unknown): { groupId: string; index: number } {
  const fields = readObject(input, "move", ["groupId", "index"]);
  return { groupId: readId(fields.groupId, "Group"), index: readIndex(fields.index) };
}

/** Where a bucket goes: an existing group, a group created in the same transaction, or (on edit) unchanged. */
export type GroupChoice = { groupId: string } | { newGroupName: string } | undefined;

export interface BucketFields {
  name?: string;
  group: GroupChoice;
  colour?: BucketColour;
  type?: BucketType;
  /** undefined = not given; null = explicitly none. */
  amount?: number | null;
  goalMonth?: string | null;
}

const bucketKeys = ["name", "groupId", "newGroupName", "colour", "type", "amount", "goalMonth"] as const;

function readBucketFields(input: unknown): BucketFields {
  const fields = readObject(input, "bucket", bucketKeys);
  if ("groupId" in fields && "newGroupName" in fields) invalid("Choose a group or name a new one, not both.", "group");
  const result: BucketFields = {
    group: "groupId" in fields ? { groupId: readId(fields.groupId, "Group") }
      : "newGroupName" in fields ? { newGroupName: readName(fields.newGroupName, "Group") }
      : undefined,
  };
  if ("name" in fields) result.name = readName(fields.name, "Bucket");
  if ("colour" in fields) result.colour = readColour(fields.colour);
  if ("type" in fields) result.type = readType(fields.type);
  if ("amount" in fields) result.amount = readAmount(fields.amount);
  if ("goalMonth" in fields) result.goalMonth = readMonth(fields.goalMonth);
  return result;
}

export function readNewBucket(input: unknown): BucketFields & { name: string; group: NonNullable<GroupChoice>; type: BucketType } {
  const fields = readBucketFields(input);
  if (fields.name === undefined) invalid("A bucket name is required.", "name");
  if (!fields.group) invalid("Choose a group or name a new one.", "group");
  if (!fields.type) invalid(`Bucket type must be one of: ${BUCKET_TYPES.join(", ")}.`, "type");
  return fields as BucketFields & { name: string; group: NonNullable<GroupChoice>; type: BucketType };
}

export function readBucketEdit(input: unknown): BucketFields {
  const fields = readBucketFields(input);
  if (Object.keys(input as object).length === 0) invalid("Provide a field to change.");
  return fields;
}

/** An undo: the fields to put back plus `revertOf`, the `updatedAt` the edit being undone left on the bucket. */
export function readBucketRevert(input: unknown): { fields: BucketFields; revertOf: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid("A bucket object is required.");
  const { revertOf, ...rest } = input as Record<string, unknown>;
  if (typeof revertOf !== "string" || !revertOf) invalid("revertOf must be the updatedAt the edit being undone left on the bucket.");
  return { fields: readBucketEdit(rest), revertOf };
}

export interface BucketShape {
  type: BucketType;
  amount: number | null;
  goalMonth: string | null;
}

/**
 * The type shape after a create (current = null) or an edit. Recurring needs an amount and no month;
 * goal needs an amount and a month; plain has neither. Switching type keeps the amount where it still
 * applies. A goal month must be the current month or later, but only when it is set or changed, so an
 * overdue goal stays editable. An undo passes `restorableMonth`, the goal month before the edit being undone: only that exact month may be past.
 */
export function resolveShape(current: BucketShape | null, change: BucketFields, currentMonth: string, restorableMonth: string | null = null): BucketShape {
  const type = change.type ?? current?.type ?? "plain";
  if (type === "plain") {
    if (change.amount != null) invalid("A plain bucket has no amount.", "amount");
    if (change.goalMonth != null) invalid("A plain bucket has no goal month.", "month");
    return { type, amount: null, goalMonth: null };
  }
  const amount = change.amount !== undefined ? change.amount : current?.amount ?? null;
  if (amount === null) invalid(type === "goal" ? "A goal needs a goal amount." : "A recurring bucket needs an amount per month.", "amount");
  if (type === "recurring") {
    if (change.goalMonth != null) invalid("Only a goal has a goal month.", "month");
    return { type, amount, goalMonth: null };
  }
  const goalMonth = change.goalMonth !== undefined ? change.goalMonth : current?.goalMonth ?? null;
  if (goalMonth === null) invalid("A goal needs a month to reach it by.", "month");
  if (goalMonth !== current?.goalMonth && goalMonth !== restorableMonth && goalMonth < currentMonth) invalid("Goal month cannot be in the past.", "month");
  return { type, amount, goalMonth };
}
