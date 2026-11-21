// Make it rain (ADR-0005): fill each bucket's need for a month from Ready to assign, strictly in bucket order,
// with no special case for overspent buckets. Need and planning are pure, so the preview is exactly what's applied.
import type { MonthFigures } from "./assignments.js";
import { BudgetError } from "./types.js";
import type { Bucket } from "./types.js";

export interface RainFill {
  bucketId: string;
  amount: number;
}

export interface RainPlan {
  fills: RainFill[];
  total: number;
}

/** An applied rain. With nothing to fill nothing is written, and there's no rain id. */
export interface Rain extends RainPlan {
  rainId?: string;
}

/** Months from `from` to `to` inclusive ("YYYY-MM"), at least 1, so an overdue goal counts as one month left. */
function monthsLeft(from: string, to: string): number {
  const index = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
  return Math.max(1, index(to) - index(from) + 1);
}

/**
 * What rain would give the bucket in `month`, from that month's figures (ADR-0005).
 * Recurring: the monthly amount less what's assigned this month. Goal: the monthly share of what's still to
 * save at the start of the month, rounded up to the cent, less what's assigned this month. Plain: none.
 */
export function needOf(bucket: Bucket, figures: Pick<MonthFigures, "assigned" | "carriedIn">, month: string): number {
  if (bucket.archived || bucket.amount === null) return 0;
  if (bucket.type === "recurring") return Math.max(0, bucket.amount - figures.assigned);
  if (bucket.type === "goal" && bucket.goalMonth !== null) {
    const share = Math.max(0, Math.ceil((bucket.amount - figures.carriedIn) / monthsLeft(month, bucket.goalMonth)));
    return Math.max(0, share - figures.assigned);
  }
  return 0;
}

/** Gives each bucket, in the order given, min(need, what's left); buckets that get nothing are left out. */
export function planRain(buckets: readonly { id: string; need: number }[], readyToAssign: number): RainPlan {
  let remaining = Math.max(0, readyToAssign);
  const fills: RainFill[] = [];
  for (const bucket of buckets) {
    const amount = Math.min(bucket.need, remaining);
    if (amount <= 0) continue;
    fills.push({ bucketId: bucket.id, amount });
    remaining -= amount;
  }
  return { fills, total: fills.reduce((sum, fill) => sum + fill.amount, 0) };
}

/**
 * A rain request's optional `{ expect: plan }`: the preview it was confirmed from. Undefined when there's none,
 * as from the CLI, which rains whatever the plan is now.
 */
export function readRainRequest(input: unknown): RainPlan | undefined {
  if (input === undefined) return undefined;
  const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const expect = fields && Object.keys(fields).join() === "expect" ? fields.expect as Record<string, unknown> | null : null;
  const fills = expect && typeof expect === "object" && Array.isArray(expect.fills) ? expect.fills as unknown[] : null;
  const valid = fills !== null && Number.isSafeInteger(expect!.total) && fills.every((fill) => {
    const each = fill as Record<string, unknown> | null;
    return typeof each === "object" && each !== null && typeof each.bucketId === "string" && Number.isSafeInteger(each.amount);
  });
  if (!valid) throw new BudgetError("invalid_input", "A rain takes only the plan it was previewed from, as { expect: { fills, total } }.");
  return { fills: (fills as RainFill[]).map(({ bucketId, amount }) => ({ bucketId, amount })), total: expect!.total as number };
}

/** Whether two plans fill the same buckets with the same amounts, in the same order. */
export function samePlan(a: RainPlan, b: RainPlan): boolean {
  return a.total === b.total && a.fills.length === b.fills.length
    && a.fills.every((fill, index) => fill.bucketId === b.fills[index]!.bucketId && fill.amount === b.fills[index]!.amount);
}
