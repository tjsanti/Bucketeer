// A split's lines inside a transaction draft: each line is a bucket and an amount in a pill input, entered
// without a sign (the transaction's sign applies to the whole split). "Left to assign" counts down live as the
// lines fill. A note for lines that don't add up sits in its own row, in neutral ink with an alert icon,
// covering no field, and clears as soon as the lines sum to the total.
import type { BucketTable, SplitLine } from "../core/index.js";
import { formatMoney, parseMoney } from "../core/money.js";
import { categoryPicker } from "./category-picker.js";
import type { CategoryPicker } from "./category-picker.js";
import { el, icon, setNote } from "./dom.js";

/** A line as typed: a bucket (or none yet) and unsigned amount text. */
interface Line {
  picker: CategoryPicker;
  amount: HTMLInputElement;
  memo: string;
  node: HTMLElement;
}

/** Thrown by read() when the lines can't be saved; its message goes in the split's note. */
export class SplitError extends Error {
  constructor(message: string, public readonly target: HTMLInputElement | null) {
    super(message);
  }
}

export interface SplitLines {
  root: HTMLElement;
  /** Shows the editor with these lines (unsigned amounts, or blank), or two blank lines. */
  open(lines?: { bucketId: string; amount: number | null; memo?: string }[]): void;
  /** Hides the editor and forgets its lines. */
  close(): void;
  isOpen(): boolean;
  /** Recounts "Left to assign" against the transaction's total, in unsigned cents. */
  update(): void;
  /** The lines to save, signed like the transaction, or a thrown SplitError. */
  read(sign: -1 | 1): SplitLine[];
  showNote(error: SplitError): void;
  clearNote(): void;
  /** The first field to fill: the first line's bucket. */
  first(): HTMLInputElement | null;
}

const cents = (text: string): number | null => {
  if (!text.trim()) return 0;
  try {
    return Math.abs(parseMoney(text));
  } catch {
    return null;
  }
};
const money = (amount: number) => formatMoney(amount, { symbol: true });
const plain = (amount: number) => formatMoney(amount).replaceAll(",", "");

export function splitLines(config: {
  table: () => BucketTable;
  /** The transaction's total, unsigned cents, or null while it isn't a valid amount. */
  total: () => number | null;
  /** The phone sheet lays lines out as cards; the desktop row aligns them with the register's columns. */
  phone: boolean;
}): SplitLines {
  let lines: Line[] = [];
  let noted = false;
  const list = el("div", { class: "slines" });
  const left = el("strong", { class: "num" });
  const leftBox = el("span", { class: "sleft" }, el("span", {}, "Left to assign"), left);
  const addButton = el("button", { class: "btn btn-quiet sm", type: "button" }, icon("plus", "sm"), "Add line");
  const note = el("div", { class: "snote", role: "alert" });
  const root = el("div", { class: config.phone ? "splits phone" : "splits", role: "group", "aria-label": "Split lines", hidden: true },
    list, el("div", { class: "sfoot" }, addButton, leftBox), note);

  const sum = () => lines.reduce((total, line) => total + (cents(line.amount.value) ?? 0), 0);

  function paintLeft(): void {
    const total = config.total() ?? 0;
    const remaining = total - sum();
    left.textContent = formatMoney(remaining);
    leftBox.classList.toggle("zero", remaining === 0 && total > 0);
    if (noted) {
      // The note tracks the lines live and goes away once they add up.
      try {
        check();
        api.clearNote();
      } catch (error) {
        if (error instanceof SplitError) setNote(note, error.message);
      }
    }
  }

  function renumber(): void {
    lines.forEach((line, index) => {
      line.node.setAttribute("aria-label", `Split line ${index + 1}`);
      line.picker.input.setAttribute("aria-label", `Split line ${index + 1} bucket`);
      line.amount.setAttribute("aria-label", `Split line ${index + 1} amount`);
      line.node.querySelector(".lbl")?.replaceChildren(index === 0 ? "Split" : "");
      const remove = line.node.querySelector<HTMLButtonElement>(".rm");
      if (remove) {
        remove.hidden = lines.length <= 2;
        remove.setAttribute("aria-label", `Remove split line ${index + 1}`);
      }
    });
  }

  function addLine(bucketId: string | null, amount: number | null, memo = ""): Line {
    const picker = categoryPicker({
      label: "Split line bucket",
      table: config.table,
      value: bucketId ? { kind: "bucket", bucketId } : null,
      inline: config.phone,
      line: true,
      inputClass: config.phone ? "input has-chev" : "cin has-chev",
      onPick: () => {
        paintLeft();
        line.amount.focus();
      },
    });
    const amountInput = el("input", {
      class: "pill-in num", type: "text", inputmode: "decimal", autocomplete: "off", value: amount === null ? "" : plain(amount),
    });
    amountInput.addEventListener("input", () => {
      // The whole split carries one sign, so a typed one is dropped.
      if (/[-+−]/.test(amountInput.value)) amountInput.value = amountInput.value.replace(/[-+−]/g, "");
      amountInput.removeAttribute("aria-invalid");
      paintLeft();
    });
    const remove = el("button", { class: "rm", type: "button" }, icon("x", "sm"));
    const node = el("div", { class: "sline", role: "group" },
      el("div", { class: "c lbl" }), el("div", { class: "c sbucket" }, picker.root),
      el("div", { class: "c samt" }, el("span", { class: "pill" }, amountInput)), el("div", { class: "c srm" }, remove));
    const line: Line = { picker, amount: amountInput, memo, node };
    remove.addEventListener("click", () => {
      const index = lines.indexOf(line);
      lines.splice(index, 1);
      node.remove();
      renumber();
      paintLeft();
      (lines[Math.max(0, index - 1)]?.amount ?? addButton).focus();
    });
    lines.push(line);
    list.append(node);
    return line;
  }

  addButton.addEventListener("click", () => {
    const remaining = (config.total() ?? 0) - sum();
    const line = addLine(null, remaining > 0 ? remaining : null);
    renumber();
    paintLeft();
    line.picker.input.focus();
  });

  /** The lines with something in them, checked; throws a SplitError naming the field to fix. */
  function check(): SplitLine[] {
    const filled: SplitLine[] = [];
    for (const line of lines) {
      const value = line.picker.value();
      const amount = cents(line.amount.value);
      if (amount === null) throw new SplitError("Enter this line’s amount like 12.50.", line.amount);
      if (!value && amount === 0) continue;
      if (!value || value.kind !== "bucket") throw new SplitError("Choose a bucket for this line.", line.picker.input);
      if (amount === 0) throw new SplitError("Enter this line’s amount.", line.amount);
      filled.push({ bucketId: value.bucketId, amount, memo: line.memo });
    }
    const total = config.total();
    const lineSum = filled.reduce((sumSoFar, line) => sumSoFar + line.amount, 0);
    if (total !== null && lineSum !== total) {
      const blank = lines.find((line) => !cents(line.amount.value)) ?? lines.at(-1);
      throw lineSum < total
        ? new SplitError(`Split lines total ${money(lineSum)}. ${money(total - lineSum)} left to assign to a bucket.`, blank?.amount ?? null)
        : new SplitError(`Split lines total ${money(lineSum)}, ${money(lineSum - total)} more than the transaction.`, null);
    }
    if (filled.length < 2) throw new SplitError("A split needs at least two lines.", lines[filled.length]?.picker.input ?? null);
    return filled;
  }

  const api: SplitLines = {
    root,
    open(given) {
      api.close();
      const start = given?.length ? given : [{ bucketId: "", amount: null }, { bucketId: "", amount: null }];
      for (const line of start) addLine(line.bucketId || null, line.amount, line.memo);
      root.hidden = false;
      renumber();
      paintLeft();
    },
    close() {
      lines = [];
      list.replaceChildren();
      root.hidden = true;
      api.clearNote();
    },
    isOpen: () => !root.hidden,
    update: paintLeft,
    read(sign) {
      return check().map((line) => ({ ...line, amount: line.amount * sign }));
    },
    showNote(error) {
      noted = true;
      setNote(note, error.message);
      error.target?.setAttribute("aria-invalid", "true");
    },
    clearNote() {
      noted = false;
      setNote(note, null);
      for (const field of root.querySelectorAll("[aria-invalid]")) field.removeAttribute("aria-invalid");
    },
    first: () => lines[0]?.picker.input ?? null,
  };
  return api;
}
