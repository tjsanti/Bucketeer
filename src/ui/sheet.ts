// Modal dialogs and form controls. A <dialog> opened with showModal() gives the focus trap and
// Escape for free; on a phone the stylesheet turns it into a bottom sheet.
import { el, icon, messageOf, setNote } from "./dom.js";
import type { Child } from "./dom.js";

let nextId = 0;
export const uid = (prefix: string) => `${prefix}-${++nextId}`;

/** A labelled field. The control is created by the caller and gets the id. */
export function field(label: string, control: (id: string) => Child, extra: Child = null): { root: HTMLDivElement; label: HTMLLabelElement } {
  const id = uid("f");
  const labelEl = el("label", { for: id }, label);
  return { root: el("div", { class: "field" }, labelEl, control(id), extra), label: labelEl };
}

export function textInput(id: string, value: string, attrs: Record<string, string> = {}): HTMLInputElement {
  const input = el("input", { class: "input", id, type: "text", autocomplete: "off", ...attrs });
  input.value = value;
  return input;
}

/** Money input with a "$" prefix. */
export function moneyInput(id: string, value: string): { wrap: HTMLDivElement; input: HTMLInputElement } {
  const input = el("input", { class: "input num", id, type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "0.00" });
  input.value = value;
  return { wrap: el("div", { class: "input-wrap" }, el("span", { class: "prefix", "aria-hidden": "true" }, "$"), input), input };
}

export interface Segmented<T extends string> {
  root: HTMLDivElement;
  value(): T;
}

/** A radiogroup of buttons with a roving tabindex: arrows move and select, Home and End jump. */
export function segmented<T extends string>(label: string, options: readonly (readonly [T, string])[], initial: T, config: { disabled?: boolean; onChange?: (value: T) => void } = {}): Segmented<T> {
  let current = initial;
  const root = el("div", { class: `seg n${options.length}`, role: "radiogroup", "aria-label": label });
  const buttons = options.map(([value, text]) => {
    const button = el("button", { type: "button", role: "radio", disabled: config.disabled }, text);
    button.dataset.value = value;
    return button;
  });
  const paint = () => {
    for (const button of buttons) {
      const on = button.dataset.value === current;
      button.setAttribute("aria-checked", String(on));
      button.tabIndex = on ? 0 : -1;
    }
  };
  const select = (index: number, focus: boolean) => {
    const button = buttons[(index + buttons.length) % buttons.length];
    if (!button) return;
    current = button.dataset.value as T;
    paint();
    if (focus) button.focus();
    config.onChange?.(current);
  };
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => select(index, false));
    button.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (step) select(index + step, true);
      else if (event.key === "Home") select(0, true);
      else if (event.key === "End") select(buttons.length - 1, true);
      else return;
      event.preventDefault();
    });
  });
  root.append(...buttons);
  paint();
  return { root, value: () => current };
}

export interface SheetOptions {
  title: string;
  submitLabel: string;
  /** The form fields (and anything else for the body). */
  body: (sheet: Sheet) => Child[];
  /** Runs on submit. Throw to show the message in the dialog and keep the user's input. */
  submit: (sheet: Sheet) => Promise<void>;
  /** Where focus goes after the dialog closes; evaluated then, because the opener may have been re-rendered. */
  returnFocus: () => HTMLElement | null;
  /** Element to focus on open (default: the first input). */
  initialFocus?: () => HTMLElement | null;
}

export interface Sheet {
  dialog: HTMLDialogElement;
  /** Runs an action with the controls disabled; a thrown error becomes the dialog note, success closes the dialog. */
  run(action: () => Promise<void>): Promise<void>;
  close(): void;
}

export function openSheet(options: SheetOptions): Sheet {
  const titleId = uid("sheet-title");
  const note = el("div", { class: "snote", role: "alert" });
  const closeButton = el("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, icon("x", "sm"));
  const submitButton = el("button", { class: "btn btn-primary wide", type: "submit" }, options.submitLabel);
  const fields = el("fieldset", { class: "sheet-fields" });
  const form = el("form", { class: "sheet-form", novalidate: true },
    el("span", { class: "grab", "aria-hidden": "true" }),
    el("div", { class: "sheet-head" }, el("h2", { id: titleId }, options.title), closeButton),
    el("div", { class: "sheet-body" }, fields),
    el("div", { class: "sheet-footer" }, note, submitButton));
  const dialog = el("dialog", { class: "sheet", "aria-labelledby": titleId }, form);
  let busy = false;

  const sheet: Sheet = {
    dialog,
    close: () => dialog.close(),
    async run(action) {
      if (busy) return;
      busy = true;
      const focused = document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement) ? document.activeElement : null;
      setNote(note, null);
      form.setAttribute("aria-busy", "true");
      fields.disabled = closeButton.disabled = submitButton.disabled = true;
      try {
        await action();
        dialog.close();
      } catch (error) {
        setNote(note, messageOf(error));
      } finally {
        busy = false;
        form.removeAttribute("aria-busy");
        fields.disabled = closeButton.disabled = submitButton.disabled = false;
        if (dialog.open) focused?.focus();
      }
    },
  };

  fields.append(...options.body(sheet).filter((child): child is Node | string => !!child));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void sheet.run(() => options.submit(sheet));
  });
  form.addEventListener("input", () => setNote(note, null));
  closeButton.addEventListener("click", () => dialog.close());
  // Escape must not abandon a request in flight.
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    dialog.remove();
    const target = options.returnFocus();
    if (target?.isConnected) target.focus();
  });

  document.body.append(dialog);
  dialog.showModal();
  const initial = options.initialFocus?.() ?? dialog.querySelector<HTMLElement>("input:not([disabled])");
  initial?.focus();
  if (initial instanceof HTMLInputElement) initial.select();
  return sheet;
}
