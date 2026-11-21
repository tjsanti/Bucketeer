// The month header shared by the month-by-month pages: ‹ November 2026 › with a month and year picker,
// bounded by the budget's month range. It only reports the chosen month; the app routes to it.
import type { MonthRange } from "../core/index.js";
import { addMonths } from "../core/months.js";
import { el, icon } from "./dom.js";

export interface MonthHeaderOptions {
  range: MonthRange;
  /** The month shown, "YYYY-MM", inside the range. */
  month: string;
  /** Called with a different month inside the range, and the control that chose it. */
  choose(month: string, from: "previous" | "next" | "picker"): void;
}

const monthNames = Array.from({ length: 12 }, (_, index) => new Date(2000, index, 1));
const longName = (index: number) => monthNames[index]!.toLocaleDateString("en-US", { month: "long" });
const shortName = (index: number) => monthNames[index]!.toLocaleDateString("en-US", { month: "short" });

/** "2026-11" -> "November 2026". */
export function monthLabel(month: string): string {
  return `${longName(Number(month.slice(5, 7)) - 1)} ${Number(month.slice(0, 4))}`;
}

export function createMonthHeader(options: MonthHeaderOptions) {
  const { range, month } = options;
  const previous = el("button", { class: "icon-btn", type: "button", "aria-label": "Previous month", "data-month": "previous", disabled: month <= range.first }, icon("left"));
  const next = el("button", { class: "icon-btn", type: "button", "aria-label": "Next month", "data-month": "next", disabled: month >= range.last }, icon("right"));
  const label = el("button", { class: "month-label", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", "data-month": "picker" }, monthLabel(month));
  const root = el("div", { class: "month-head" }, previous, label, next);

  previous.addEventListener("click", () => options.choose(addMonths(month, -1), "previous"));
  next.addEventListener("click", () => options.choose(addMonths(month, 1), "next"));

  let picker: HTMLElement | null = null;
  const firstYear = Number(range.first.slice(0, 4));
  const lastYear = Number(range.last.slice(0, 4));

  function close(returnFocus: boolean): void {
    if (!picker) return;
    picker.remove();
    picker = null;
    label.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside);
    if (returnFocus) label.focus();
  }

  function outside(event: Event): void {
    if (event.target instanceof Node && !root.contains(event.target)) close(false);
  }

  function open(): void {
    let year = Number(month.slice(0, 4));
    const yearText = el("span", { class: "pick-year num", "aria-live": "polite" });
    const previousYear = el("button", { class: "icon-btn", type: "button", "aria-label": "Previous year" }, icon("left"));
    const nextYear = el("button", { class: "icon-btn", type: "button", "aria-label": "Next year" }, icon("right"));
    const grid = el("div", { class: "pick-grid" });
    const dialog = el("div", { class: "month-pick", role: "dialog", "aria-label": "Choose month" },
      el("div", { class: "pick-head" }, previousYear, yearText, nextYear), grid);

    function draw(): void {
      yearText.textContent = String(year);
      previousYear.disabled = year <= firstYear;
      nextYear.disabled = year >= lastYear;
      grid.replaceChildren(...monthNames.map((_, index) => {
        const key = `${String(year).padStart(4, "0")}-${String(index + 1).padStart(2, "0")}`;
        const button = el("button", {
          class: "pick-month", type: "button", "aria-label": `${longName(index)} ${year}`,
          "aria-current": key === month ? "true" : undefined, disabled: key < range.first || key > range.last,
        }, shortName(index));
        button.addEventListener("click", () => {
          close(false);
          if (key === month) label.focus();
          else options.choose(key, "picker");
        });
        return button;
      }));
    }
    previousYear.addEventListener("click", () => { year -= 1; draw(); });
    nextYear.addEventListener("click", () => { year += 1; draw(); });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    });
    dialog.addEventListener("focusout", (event) => {
      if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) close(false);
    });
    draw();
    picker = dialog;
    root.append(dialog);
    label.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside);
    (grid.querySelector<HTMLButtonElement>("[aria-current]") ?? grid.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
  }

  label.addEventListener("click", () => (picker ? close(true) : open()));
  label.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && picker) {
      event.preventDefault();
      close(true);
    }
  });

  return {
    root,
    /** Moves focus to the control that chose the month, or to the label when that arrow is now disabled. */
    focus(from: "previous" | "next" | "picker"): void {
      const target = from === "previous" ? previous : from === "next" ? next : label;
      (target.disabled ? label : target).focus();
    },
  };
}
