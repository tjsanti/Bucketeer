// Modal dialogs and form controls. A <dialog> opened with showModal() gives the focus trap and
// Escape for free; on a phone the stylesheet turns it into a bottom sheet.
import { el, icon, messageOf, setNote, withVars } from "./dom.js";
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
  /** Selects a value without calling onChange. */
  set(value: T): void;
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
  return { root, value: () => current, set: (value) => { current = value; paint(); } };
}

/** An error that belongs to one field: the dialog note shows it, and that field is marked and focused. */
export class FieldError extends Error {
  constructor(message: string, public readonly field: HTMLElement) {
    super(message);
  }
}

export interface SheetOptions {
  title: string;
  /** Shown before the title (the bucket dialog's colour dot). */
  titleStart?: Child;
  /** "top" anchors the desktop dialog near the top, so a change in height only moves the footer. */
  anchor?: "top";
  submitLabel: string;
  /** The form fields (and anything else for the body). */
  body: (sheet: Sheet) => Child[];
  /** Runs on submit. Throw to show the message in the dialog and keep the user's input. */
  submit: (sheet: Sheet) => Promise<void>;
  /** Where focus goes after the dialog closes; evaluated then, because the opener may have been re-rendered. */
  returnFocus: () => HTMLElement | null;
  /** Element to focus on open (default: the first input). */
  initialFocus?: () => HTMLElement | null;
  /** The field a thrown (server) error belongs to, if any. */
  fieldFor?: (error: unknown) => HTMLElement | null;
}

export interface Sheet {
  dialog: HTMLDialogElement;
  /** Runs an action with the controls disabled; a thrown error becomes the dialog note, success closes the dialog. */
  run(action: () => Promise<void>): Promise<void>;
  close(): void;
}

export function openSheet(options: SheetOptions): Sheet {
  const titleId = uid("sheet-title");
  const noteId = uid("snote");
  const note = el("div", { class: "snote", role: "alert", id: noteId });
  const closeButton = el("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, icon("x", "sm"));
  const submitButton = el("button", { class: "btn btn-primary wide", type: "submit" }, options.submitLabel);
  const fields = el("fieldset", { class: "sheet-fields" });
  const form = el("form", { class: "sheet-form", novalidate: true },
    el("span", { class: "grab", "aria-hidden": "true" }),
    el("div", { class: "sheet-head" }, options.titleStart ?? null, el("h2", { id: titleId }, options.title), closeButton),
    el("div", { class: "sheet-body" }, fields),
    el("div", { class: "sheet-footer" }, note, submitButton));
  const dialog = el("dialog", { class: options.anchor === "top" ? "sheet top" : "sheet", "aria-labelledby": titleId }, form);
  let busy = false;

  const sheet: Sheet = {
    dialog,
    close: () => dialog.close(),
    async run(action) {
      if (busy) return;
      busy = true;
      let focused = document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement) ? document.activeElement : null;
      clearInvalid();
      form.setAttribute("aria-busy", "true");
      fields.disabled = closeButton.disabled = submitButton.disabled = true;
      try {
        await action();
        dialog.close();
      } catch (error) {
        setNote(note, messageOf(error));
        const bad = error instanceof FieldError ? error.field : options.fieldFor?.(error) ?? null;
        if (bad?.isConnected) {
          bad.setAttribute("aria-invalid", "true");
          bad.setAttribute("aria-describedby", noteId);
          focused = bad;
        }
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
  function clearInvalid(): void {
    setNote(note, null);
    for (const bad of form.querySelectorAll("[aria-invalid]")) {
      bad.removeAttribute("aria-invalid");
      if (bad.getAttribute("aria-describedby") === noteId) bad.removeAttribute("aria-describedby");
    }
  }
  form.addEventListener("input", clearInvalid);
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

export interface DropdownOption {
  value: string;
  label: string;
}

export type DropdownValue = { kind: "existing"; value: string } | { kind: "new"; name: string };

export interface Dropdown {
  root: HTMLDivElement;
  value(): DropdownValue;
  /** The control to mark and focus for an error: the button, or the new-name field. */
  control(): HTMLElement;
}

/**
 * A select-only combobox styled like the budget picker. Focus stays on the button and the list's
 * current option is aria-activedescendant. Opening and arrowing never change the value; only picking
 * does. Typing jumps to a matching option. The last option turns the control into a text field for a
 * new name, with a way back to the existing options (when there are any).
 */
export function dropdown(config: { label: string; options: readonly DropdownOption[]; value: string | null; newItem: string; newLabel: string; backLabel: string }): Dropdown {
  const { options } = config;
  let selected = options.find((option) => option.value === config.value)?.value ?? options[0]?.value ?? null;
  let mode: "existing" | "new" = selected === null ? "new" : "existing";
  let active = -1;
  let typed = "";
  let typedTimer: number | undefined;
  let swallowCancel = false;

  const labelId = uid("dd-label");
  const listId = uid("dd-list");
  const label = el("span", { class: "flabel", id: labelId }, config.label);
  const valueText = el("span", { class: "sv" });
  const button = el("button", {
    class: "input select-btn", type: "button", role: "combobox", "aria-haspopup": "listbox", "aria-controls": listId,
    "aria-labelledby": labelId, "aria-expanded": "false",
  }, valueText, icon("down", "sm"));
  const items = [...options.map((option) => option.label), config.newItem].map((text, index) => {
    const item = el("div", { class: "lb-opt", role: "option", id: `${listId}-${index}`, "aria-selected": "false" }, el("span", { class: "on" }, text));
    item.addEventListener("click", () => pick(index));
    return item;
  });
  const newOption = items.at(-1)!;
  newOption.append(icon("plus"));
  const list = el("div", { class: "lb", role: "listbox", id: listId, "aria-labelledby": labelId, tabindex: "-1", hidden: true },
    ...items.slice(0, -1), el("div", { class: "lb-sep", "aria-hidden": "true" }), newOption);
  // Pressing the list must not move focus off the button.
  list.addEventListener("mousedown", (event) => event.preventDefault());
  const existing = el("div", { class: "dd-wrap" }, button, list);

  const newId = uid("dd-new");
  const newLabelEl = el("label", { for: newId }, config.newLabel);
  const newInput = textInput(newId, "");
  const back = el("button", { class: "btn btn-quiet", type: "button" }, icon("list", "sm"), config.backLabel);
  const newRow = el("div", { class: "ng-row" }, newInput, options.length ? back : null);
  const root = el("div", { class: "field dd" }, label, newLabelEl, existing, newRow);

  const selectedIndex = () => Math.max(0, options.findIndex((option) => option.value === selected));
  function paint(): void {
    const isNew = mode === "new";
    label.hidden = existing.hidden = isNew;
    newLabelEl.hidden = newRow.hidden = !isNew;
    valueText.textContent = options.find((option) => option.value === selected)?.label ?? "";
    items.forEach((item, index) => {
      const on = index < options.length && options[index]!.value === selected;
      item.setAttribute("aria-selected", String(on));
      if (index < options.length) item.replaceChildren(item.firstElementChild!, ...(on ? [icon("check")] : []));
    });
  }
  function setOpen(open: boolean, next = -1): void {
    if (!open) {
      typed = "";
      window.clearTimeout(typedTimer);
    }
    active = open ? next : -1;
    list.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    items.forEach((item, index) => item.classList.toggle("active", index === active));
    if (open && active >= 0) {
      button.setAttribute("aria-activedescendant", items[active]!.id);
      const item = items[active]!;
      if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop - 6;
      else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight + 6;
    } else {
      button.removeAttribute("aria-activedescendant");
    }
  }
  const isOpen = () => !list.hidden;
  function pick(index: number): void {
    setOpen(false);
    if (index === options.length) {
      mode = "new";
      paint();
      newInput.focus();
      return;
    }
    const option = options[index];
    if (option) selected = option.value;
    paint();
    button.focus();
    root.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function match(key: string): number {
    typed += key.toLowerCase();
    window.clearTimeout(typedTimer);
    typedTimer = window.setTimeout(() => { typed = ""; }, 700);
    // Pressing one letter repeatedly cycles through the options that start with it.
    if (typed.length > 1 && [...typed].every((char) => char === typed[0])) typed = typed[0]!;
    const from = isOpen() ? active : selectedIndex();
    const start = typed.length === 1 ? from + 1 : from;
    for (let step = 0; step < items.length; step++) {
      const index = (start + step + items.length) % items.length;
      if (items[index]!.textContent!.toLowerCase().startsWith(typed)) return index;
    }
    return -1;
  }

  button.addEventListener("click", (event) => {
    if (!isOpen()) setOpen(true, selectedIndex());
    else if (event.detail === 0) pick(active); // Enter or Space on the open list picks
    else setOpen(false);
  });
  button.addEventListener("keydown", (event) => {
    const last = items.length - 1;
    const printable = event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (!isOpen()) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") setOpen(true, selectedIndex());
      else if (event.key === "Home") setOpen(true, 0);
      else if (event.key === "End") setOpen(true, last);
      else if (printable) { const found = match(event.key); setOpen(true, found >= 0 ? found : selectedIndex()); }
      else return;
    } else if (event.altKey && event.key === "ArrowUp") pick(active);
    else if (event.key === "ArrowDown") setOpen(true, Math.min(last, active + 1));
    else if (event.key === "ArrowUp") setOpen(true, Math.max(0, active - 1));
    else if (event.key === "Home") setOpen(true, 0);
    else if (event.key === "End") setOpen(true, last);
    else if (event.key === "Escape") {
      // Closes only the list, not the dialog around it.
      event.stopPropagation();
      swallowCancel = true;
      window.setTimeout(() => { swallowCancel = false; }, 0);
      setOpen(false);
    } else if (event.key === "Tab") { setOpen(false); return; }
    else if (printable) { const found = match(event.key); if (found >= 0) setOpen(true, found); }
    else return;
    event.preventDefault();
  });
  const closeOutside = (event: PointerEvent) => {
    if (isOpen() && event.target instanceof Node && !existing.contains(event.target)) setOpen(false);
  };
  root.addEventListener("focusout", (event) => {
    if (isOpen() && !(event.relatedTarget instanceof Node && existing.contains(event.relatedTarget))) setOpen(false);
  });
  // Wired once the control is in its dialog; the document listener goes when the dialog closes.
  queueMicrotask(() => {
    const dialog = root.closest("dialog");
    if (!dialog) return;
    document.addEventListener("pointerdown", closeOutside);
    dialog.addEventListener("close", () => document.removeEventListener("pointerdown", closeOutside), { once: true });
    dialog.addEventListener("cancel", (event) => {
      if (swallowCancel || isOpen()) {
        event.preventDefault();
        setOpen(false);
      }
    });
  });
  back.addEventListener("click", () => {
    mode = "existing";
    paint();
    button.focus();
  });
  paint();

  return {
    root,
    value: () => mode === "new" || selected === null ? { kind: "new", name: newInput.value } : { kind: "existing", value: selected },
    control: () => (mode === "new" ? newInput : button),
  };
}

export interface SwatchOption {
  value: string;
  name: string;
}

/**
 * A colour radiogroup with a roving tabindex, laid out in rows of `columns`. Left and Right move
 * through the colours, Up and Down move by a row, Home and End jump; moving selects. Each swatch's
 * accessible name is its colour name, which also shows as text beside the label.
 */
export function swatches(config: { label: string; options: readonly SwatchOption[]; value: string; columns: number; onChange?: (value: string) => void }): { root: HTMLDivElement; value(): string } {
  let current = config.value;
  const labelId = uid("sw-label");
  const hueName = el("span", { class: "hue-name", "aria-hidden": "true" });
  const group = el("div", { class: "swatches", role: "radiogroup", "aria-labelledby": labelId });
  const buttons = config.options.map((option) => {
    const button = withVars(el("button", { class: "sw", type: "button", role: "radio", "aria-label": option.name }, el("span", { class: "sw-dot" })), { "--c": `var(--b-${option.value})` });
    button.dataset.value = option.value;
    return button;
  });
  const paint = () => {
    for (const button of buttons) {
      const on = button.dataset.value === current;
      button.setAttribute("aria-checked", String(on));
      button.tabIndex = on ? 0 : -1;
      const dot = button.firstElementChild!;
      dot.replaceChildren(...(on ? [el("span", { class: "sw-check" }, icon("check"))] : []));
    }
    hueName.textContent = config.options.find((option) => option.value === current)?.name ?? "";
  };
  const select = (index: number, focus: boolean) => {
    const button = buttons[(index + buttons.length) % buttons.length]!;
    current = button.dataset.value!;
    paint();
    if (focus) button.focus();
    config.onChange?.(current);
  };
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => select(index, false));
    button.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: config.columns, ArrowUp: -config.columns }[event.key];
      if (step !== undefined) select(index + step, true);
      else if (event.key === "Home") select(0, true);
      else if (event.key === "End") select(buttons.length - 1, true);
      else return;
      event.preventDefault();
    });
  });
  group.append(...buttons);
  paint();
  const root = el("div", { class: "field" }, el("div", { class: "flabel-row" }, el("span", { class: "flabel", id: labelId }, config.label), hueName), group);
  return { root, value: () => current };
}
