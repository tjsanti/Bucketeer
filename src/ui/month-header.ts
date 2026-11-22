// The month header shared by the month-by-month pages: ‹ November 2026 › with a month and year picker,
// bounded by the budget's month range. It only reports the chosen month; the app routes to it.
import type { MonthRange } from "../core/index.js";
import { addMonths } from "../core/months.js";
import { el, icon } from "./dom.js";
import { attachMonthPicker, longMonthLabel } from "./month-picker.js";

export interface MonthHeaderOptions {
  range: MonthRange;
  /** The month shown, "YYYY-MM", inside the range. */
  month: string;
  /** Called with a different month inside the range, and the control that chose it. */
  choose(month: string, from: "previous" | "next" | "picker"): void;
}

export function createMonthHeader(options: MonthHeaderOptions) {
  const { range, month } = options;
  const previous = el("button", { class: "icon-btn", type: "button", "aria-label": "Previous month", "data-month": "previous", disabled: month <= range.first }, icon("left"));
  const next = el("button", { class: "icon-btn", type: "button", "aria-label": "Next month", "data-month": "next", disabled: month >= range.last }, icon("right"));
  const label = el("button", { class: "month-label", type: "button", "data-month": "picker" }, longMonthLabel(month));
  const root = el("div", { class: "month-head" }, previous, label, next);

  previous.addEventListener("click", () => options.choose(addMonths(month, -1), "previous"));
  next.addEventListener("click", () => options.choose(addMonths(month, 1), "next"));
  attachMonthPicker({ trigger: label, root, value: () => month, first: range.first, last: range.last, choose: (key) => options.choose(key, "picker") });

  return {
    root,
    /** Moves focus to the control that chose the month, or to the label when that arrow is now disabled. */
    focus(from: "previous" | "next" | "picker"): void {
      const target = from === "previous" ? previous : from === "next" ? next : label;
      (target.disabled ? label : target).focus();
    },
  };
}
