// A month and year picker opened by a button: a year stepper over a grid of the twelve months, bounded by a first
// and last month. The month header and the bucket dialog's goal month share it. It only reports the month picked.
import { el, icon } from "./dom.js";

export interface MonthPickerOptions {
  /** Opens and closes the picker, and gets focus back after a pick or Escape. */
  trigger: HTMLButtonElement;
  /** Holds the trigger, and the picker while it is open. A press outside it, or focus leaving it, closes the picker. */
  root: HTMLElement;
  /** The chosen month, "YYYY-MM": it is marked, the picker opens on its year, and it can always be picked. */
  value(): string;
  /** The earliest and latest months that can be picked, "YYYY-MM". */
  first: string;
  last: string;
  /** Called with a month other than the chosen one, once the picker has closed. */
  choose(month: string): void;
  /**
   * Floats the picker in a fixed layer beside the trigger, so a dialog that clips or scrolls its body can't cut it
   * off. Otherwise the stylesheet places it inside `root`.
   */
  float?: boolean;
}

const monthDates = Array.from({ length: 12 }, (_, index) => new Date(2000, index, 1));
// A malformed month ("2027-13", "2027-8") gets no name rather than throwing while a page renders.
const nameOf = (index: number, month: "long" | "short") => monthDates[index]?.toLocaleDateString("en-US", { month }) ?? "";
const longName = (index: number) => nameOf(index, "long");
const shortName = (index: number) => nameOf(index, "short");
const yearOf = (month: string) => Number(month.slice(0, 4));
// Where dialogs become bottom sheets, a floating picker spans the screen, as the month header's does.
const narrow = window.matchMedia("(max-width: 760px)");

/** "2026-11" -> "November 2026". */
export function longMonthLabel(month: string): string {
  return `${longName(Number(month.slice(5, 7)) - 1)} ${yearOf(month)}`;
}

/** "2027-08" -> "Aug 2027". */
export function shortMonthLabel(month: string): string {
  return `${shortName(Number(month.slice(5, 7)) - 1)} ${yearOf(month)}`;
}

export function attachMonthPicker(options: MonthPickerOptions): void {
  const { trigger, root } = options;
  let picker: HTMLElement | null = null;
  let place: (() => void) | null = null;
  // Set for one tick after Escape closes the picker, so a <dialog> around it doesn't also close.
  let swallowCancel = false;
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");

  /** Closes only the picker on Escape, never a dialog around it, even where a cancelled keydown still cancels it. */
  function escape(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    swallowCancel = true;
    window.setTimeout(() => { swallowCancel = false; }, 0);
    close(true);
  }
  // Wired once the trigger is in its dialog, as the Group dropdown's guard is.
  queueMicrotask(() => {
    root.closest("dialog")?.addEventListener("cancel", (event) => {
      if (swallowCancel || picker) {
        event.preventDefault();
        close(true);
      }
    });
  });

  function close(returnFocus: boolean): void {
    if (!picker) return;
    picker.remove();
    picker = null;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside);
    if (place) {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", scrolled, true);
      place = null;
    }
    if (returnFocus) trigger.focus();
  }

  function outside(event: Event): void {
    if (event.target instanceof Node && !root.contains(event.target)) close(false);
  }

  /** A floating picker closes when its trigger scrolls away under it. */
  function scrolled(event: Event): void {
    if (event.target instanceof Node && event.target.contains(trigger)) close(false);
  }

  function open(): void {
    const value = options.value();
    const firstYear = Math.min(yearOf(options.first), yearOf(value));
    const lastYear = Math.max(yearOf(options.last), yearOf(value));
    let year = yearOf(value);
    const yearText = el("span", { class: "pick-year num", "aria-live": "polite" });
    const previousYear = el("button", { class: "icon-btn", type: "button", "aria-label": "Previous year" }, icon("left"));
    const nextYear = el("button", { class: "icon-btn", type: "button", "aria-label": "Next year" }, icon("right"));
    const grid = el("div", { class: "pick-grid" });
    // Safari doesn't focus a pressed button: focus falls back to its nearest focusable ancestor. Being focusable, the
    // picker takes it for a press inside it, so Escape and Tab still reach the picker.
    const dialog = el("div", { class: options.float ? "month-pick floating" : "month-pick", role: "dialog", "aria-label": "Choose month", tabindex: "-1" },
      el("div", { class: "pick-head" }, previousYear, yearText, nextYear), grid);

    function draw(): void {
      yearText.textContent = String(year);
      previousYear.disabled = year <= firstYear;
      nextYear.disabled = year >= lastYear;
      grid.replaceChildren(...monthDates.map((_, index) => {
        const key = `${String(year).padStart(4, "0")}-${String(index + 1).padStart(2, "0")}`;
        const button = el("button", {
          class: "pick-month", type: "button", "aria-label": `${longName(index)} ${year}`,
          "aria-current": key === value ? "true" : undefined, disabled: key !== value && (key < options.first || key > options.last),
        }, shortName(index));
        button.addEventListener("click", () => {
          close(false);
          if (key === value) trigger.focus();
          else options.choose(key);
        });
        return button;
      }));
    }
    /** Focuses the chosen month if this year shows it, else the first month that can be picked. */
    const focusMonths = () => (grid.querySelector<HTMLButtonElement>("[aria-current]") ?? grid.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    // A year button that stops at the end of the range would drop focus out of the picker; the months take it.
    const step = (by: number, from: HTMLButtonElement) => {
      year += by;
      draw();
      if (from.disabled) focusMonths();
    };
    previousYear.addEventListener("click", () => step(-1, previousYear));
    nextYear.addEventListener("click", () => step(1, nextYear));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") escape(event);
    });
    // Focus falling back to an element around `root`, such as the <dialog> holding it, is Safari pressing something
    // in `root` it won't focus (the trigger), not focus leaving. A press outside `root` closes the picker in `outside`.
    dialog.addEventListener("focusout", (event) => {
      const to = event.relatedTarget;
      if (to instanceof Node && !root.contains(to) && !to.contains(root)) close(false);
    });
    draw();
    picker = dialog;
    root.append(dialog);
    if (options.float) {
      // Under the trigger, its right edge on the trigger's, or above it when there is no room below.
      place = () => {
        const box = trigger.getBoundingClientRect();
        const gutter = 16;
        const width = narrow.matches ? window.innerWidth - 2 * gutter : Math.min(288, window.innerWidth - 2 * gutter);
        dialog.style.width = `${width}px`;
        dialog.style.left = `${Math.max(gutter, Math.min(box.right - width, window.innerWidth - gutter - width))}px`;
        const height = dialog.offsetHeight;
        const below = box.bottom + 6;
        dialog.style.top = `${below + height <= window.innerHeight - 8 ? below : Math.max(8, box.top - 6 - height)}px`;
      };
      place();
      window.addEventListener("resize", place);
      document.addEventListener("scroll", scrolled, true);
    }
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outside);
    focusMonths();
  }

  trigger.addEventListener("click", () => (picker ? close(true) : open()));
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && picker) escape(event);
  });
}
