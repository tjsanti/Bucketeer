// An account's page: its balance, then the register (newest first, with running balances). On desktop the
// always-ready entry row sits at the top and clicking a row edits it in place; on a phone a bottom sheet
// does both. Every add, edit and delete offers Undo.
import type { createClient } from "../client.js";
import { ApiError } from "../client.js";
import type { Account, AccountMonth, BucketTable, CategoryInput, NewTransactionInput, PayeeHistory, RegisterTransaction, TransactionEditInput } from "../core/index.js";
import { formatMoney, parseMoney } from "../core/money.js";
import { lastDayOf } from "../core/months.js";
import { BudgetError } from "../core/types.js";
import { categoryDot, categoryLabel, categoryPicker, sameCategory, transferLabel } from "./category-picker.js";
import type { CategoryPicker } from "./category-picker.js";
import { el, icon, messageOf, setNote } from "./dom.js";
import { segmented, uid } from "./sheet.js";

export interface RegisterContext {
  client: ReturnType<typeof createClient>;
  account: Account;
  snack(message: string, undo: () => Promise<void>): void;
  /** Re-reads the account, its register, the buckets, payees and the sidebar, and redraws them. Never throws. */
  refresh(): Promise<void>;
  /** The month header; the summary and the register show its month. */
  monthHeader: HTMLElement;
  /** The month shown, "YYYY-MM". */
  month: string;
  /** Whether the month is before the current one. */
  past: boolean;
}

export interface RegisterData {
  account: Account;
  /** The month's transactions and the account's balance at its end. */
  register: AccountMonth;
  table: BucketTable;
  payees: PayeeHistory[];
  /** Every account in the budget, closed ones included, with today's balances. */
  accounts: Account[];
}

const columns = ["Date", "Payee", "Category", "Memo", "Amount", "Balance"] as const;
const columnClass = ["date", "payee", "cat", "memo", "amt", "bal"] as const;
const MINUS = "−";
const phone = window.matchMedia("(max-width: 760px)");

/** Today as YYYY-MM-DD in the viewer's own time zone. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** "2026-11-14" -> "Nov 14", read as a calendar date so no time zone can shift it. */
function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const fieldOf = (error: unknown) => error instanceof ApiError || error instanceof BudgetError ? error.field : undefined;

/** What a snackbar calls a transaction: its payee, or its amount when it has none. */
const describe = (transaction: { payee: string; amount: number }) => transaction.payee || formatMoney(transaction.amount, { symbol: true });

/** The fields that re-create a deleted transaction. */
const fieldsOf = (transaction: RegisterTransaction): NewTransactionInput => ({
  date: transaction.date, payee: transaction.payee, memo: transaction.memo, amount: transaction.amount, category: transaction.category,
});

type Sign = -1 | 1;

/**
 * The fields shared by the desktop entry row, the in-place editor and the phone sheet: payee (whose history
 * fills in the category), category, memo, date and an amount with its sign. Typing - or + in the amount
 * flips the sign; Income turns it to +.
 */
interface Draft {
  date: HTMLInputElement;
  payee: HTMLInputElement;
  picker: CategoryPicker;
  memo: HTMLInputElement;
  amount: HTMLInputElement;
  sign(): Sign;
  setSign(sign: Sign): void;
  load(transaction: RegisterTransaction | null, keepDate?: boolean): void;
  /** The values to save, or a thrown error naming the field at fault. */
  read(): { date: string; payee: string; memo: string; amount: number; category: CategoryInput };
  /** For a transfer, the other account's balance before → after this transaction; hidden otherwise. */
  preview: HTMLElement;
  mark(field: string | undefined): void;
  clearMarks(): void;
}

class DraftError extends Error {
  constructor(message: string, public readonly field: string) {
    super(message);
  }
}

/**
 * Where a transfer can go from this account: every other open account, the likeliest first (from checking, the
 * card; from anything else, checking), otherwise in account order.
 */
function transferTargets(accounts: readonly Account[], self: Account): Account[] {
  const rank = (other: Account) => self.type === "checking" ? (other.type === "credit-card" ? 0 : 1) : (other.type === "checking" ? 0 : 1);
  return accounts.filter((other) => !other.closed && other.id !== self.id)
    .map((other, index) => ({ other, index }))
    .sort((a, b) => rank(a.other) - rank(b.other) || a.index - b.index)
    .map(({ other }) => other);
}

function createDraft(config: {
  table: () => BucketTable;
  accounts: () => readonly Account[];
  transferAccounts: () => readonly Account[];
  payees: () => PayeeHistory[];
  payeeList: string;
  /** The date a new draft starts on. */
  defaultDate: () => string;
  inputClass: string;
  inline: boolean;
  onSign: (sign: Sign) => void;
}): Draft {
  let sign: Sign = -1;
  let categoryChosen = false;
  let loaded: RegisterTransaction | null = null;
  const preview = el("div", { class: "xfer-prev", hidden: true });
  const input = (name: string, attrs: Record<string, string> = {}) =>
    el("input", { class: config.inputClass, name, "aria-label": name[0]!.toUpperCase() + name.slice(1), autocomplete: "off", ...attrs });
  const date = input("date", { type: "date", class: `${config.inputClass} num` });
  const payee = input("payee", { type: "text", maxlength: "120", list: config.payeeList });
  const memo = input("memo", { type: "text", maxlength: "500" });
  const amount = input("amount", { type: "text", inputmode: "decimal", class: `${config.inputClass} num amt-in`, "aria-label": "Amount, outflow" });
  const setSign = (next: Sign) => {
    sign = next;
    amount.setAttribute("aria-label", `Amount, ${sign > 0 ? "inflow" : "outflow"}`);
    config.onSign(sign);
    paintPreview();
  };
  const picker = categoryPicker({
    label: "Category",
    table: config.table,
    accounts: config.accounts,
    transferAccounts: config.transferAccounts,
    value: null,
    inline: config.inline,
    inputClass: `${config.inputClass} has-chev`,
    onPick: (category) => {
      categoryChosen = true;
      if (category.kind === "income") setSign(1);
      paintPreview();
    },
  });

  // "Visa −412.09 → 0.00": the other account's balance now (without this transfer, when editing it) and after.
  function paintPreview(): void {
    const category = picker.value();
    const other = category?.kind === "transfer" ? config.accounts().find((account) => account.id === category.accountId) : undefined;
    preview.hidden = !other;
    if (!other) return preview.replaceChildren();
    let cents = 0;
    try {
      cents = amount.value.trim() ? Math.abs(parseMoney(amount.value)) * sign : 0;
    } catch {
      // An amount that doesn't parse yet previews as nothing moving.
    }
    const before = other.balance + (loaded?.category.kind === "transfer" && loaded.category.accountId === other.id ? loaded.amount : 0);
    preview.replaceChildren(icon("xfer", "sm"),
      el("span", {}, `${other.name} `, el("span", { class: "num" }, formatMoney(before)), " → ", el("strong", { class: "num" }, formatMoney(before - cents))));
  }
  amount.addEventListener("input", paintPreview);

  amount.addEventListener("keydown", (event) => {
    if (event.key !== "-" && event.key !== "+") return;
    event.preventDefault();
    setSign(event.key === "+" ? 1 : -1);
  });
  // A pasted or autofilled leading sign sets the sign too.
  amount.addEventListener("input", () => {
    const match = /^\s*([-+−])/.exec(amount.value);
    if (!match) return;
    setSign(match[1] === "+" ? 1 : -1);
    amount.value = amount.value.replace(/^\s*[-+−]\s*/, "");
  });
  payee.addEventListener("input", () => {
    if (categoryChosen) return;
    const key = payee.value.trim().toLowerCase();
    const known = key ? config.payees().find((entry) => entry.payee.toLowerCase() === key) : undefined;
    if (!known) return;
    const category = known.category;
    // History never offers an archived bucket, or a transfer to an account that isn't offered.
    if (category.kind === "bucket" && !config.table().buckets.some((bucket) => bucket.id === category.bucketId && !bucket.archived)) return;
    if (category.kind === "transfer" && !config.transferAccounts().some((account) => account.id === category.accountId)) return;
    picker.set(category);
    if (category.kind === "income") setSign(1);
    paintPreview();
  });

  const fields: Record<string, HTMLInputElement> = { date, payee, memo, amount, category: picker.input };
  const draft: Draft = {
    date, payee, picker, memo, amount, preview,
    sign: () => sign,
    setSign,
    load(transaction, keepDate = false) {
      categoryChosen = !!transaction;
      loaded = transaction;
      payee.value = transaction?.payee ?? "";
      memo.value = transaction?.memo ?? "";
      amount.value = transaction ? formatMoney(Math.abs(transaction.amount)).replaceAll(",", "") : "";
      if (transaction) date.value = transaction.date;
      else if (!keepDate || !date.value) date.value = config.defaultDate();
      picker.set(transaction?.category ?? null);
      setSign(transaction && transaction.amount > 0 ? 1 : -1);
      paintPreview();
      draft.clearMarks();
    },
    read() {
      let cents: number;
      try {
        cents = Math.abs(parseMoney(amount.value));
      } catch (error) {
        throw new DraftError(messageOf(error), "amount");
      }
      const category = picker.value();
      if (!category) throw new DraftError("Choose a category.", "category");
      return { date: date.value, payee: payee.value, memo: memo.value, amount: cents * sign, category };
    },
    mark(field) {
      const target = field ? fields[field] : undefined;
      target?.setAttribute("aria-invalid", "true");
    },
    clearMarks() {
      for (const field of Object.values(fields)) field.removeAttribute("aria-invalid");
    },
  };
  return draft;
}

/** The changed fields of an edit, and the old values that undo it. */
function diff(before: RegisterTransaction, after: ReturnType<Draft["read"]>): { changes: TransactionEditInput; previous: TransactionEditInput } {
  const changes: TransactionEditInput = {};
  const previous: TransactionEditInput = {};
  for (const key of ["date", "payee", "memo", "amount"] as const) {
    if (after[key] !== before[key]) {
      (changes as Record<string, unknown>)[key] = after[key];
      (previous as Record<string, unknown>)[key] = before[key];
    }
  }
  if (!sameCategory(after.category, before.category)) {
    changes.category = after.category;
    previous.category = before.category;
  }
  return { changes, previous };
}

export function createRegisterPage(ctx: RegisterContext) {
  const { client } = ctx;
  let account = ctx.account;
  let table: BucketTable = { groups: [], buckets: [] };
  let accounts: Account[] = [];
  const draftData = { table: () => table, accounts: () => accounts, transferAccounts: () => transferTargets(accounts, account) };
  let payees: PayeeHistory[] = [];
  let transactions: RegisterTransaction[] = [];
  let editing: { id: string; node: HTMLElement; draft: Draft } | null = null;
  let highlightId: string | null = null;
  let highlightTimer: number | undefined;

  const heading = el("h1", {}, account.name);
  const balance = el("p", { class: "figure num" });
  // New entries start today, or on a past month's last day; that day's balance is the summary's.
  const defaultDate = () => ctx.past ? lastDayOf(ctx.month) : today();
  const summaryLabel = ctx.past ? `Balance on ${shortDate(lastDayOf(ctx.month))}` : "Balance";
  const summary = el("div", { class: "acct-summary card" }, el("p", { class: "label" }, summaryLabel), balance);
  const note = el("div", { class: "note", role: "alert" });
  const payeeListId = uid("payees");
  const payeeList = el("datalist", { id: payeeListId });

  const signButton = (draft: () => Draft) => {
    const button = el("button", { class: "sign", type: "button", tabindex: "-1", "aria-label": "Outflow, switch" }, MINUS);
    button.addEventListener("click", () => draft().setSign(draft().sign() > 0 ? -1 : 1));
    return button;
  };
  const paintSign = (button: HTMLButtonElement, sign: Sign) => {
    button.textContent = sign > 0 ? "+" : MINUS;
    button.classList.toggle("in", sign > 0);
    button.setAttribute("aria-label", `${sign > 0 ? "Inflow" : "Outflow"}, switch`);
  };

  /** A desktop row of fields aligned with the register's columns. */
  function rowEditor(kind: "new" | "edit"): { node: HTMLFormElement; draft: Draft; footer: HTMLElement } {
    let sign!: HTMLButtonElement;
    const draft = createDraft({
      ...draftData, payees: () => payees, payeeList: payeeListId, defaultDate, inputClass: "cin", inline: false,
      onSign: (next) => { if (sign) paintSign(sign, next); },
    });
    sign = signButton(() => draft);
    const cell = (index: number, child: HTMLElement) => el("div", { class: `c ${columnClass[index]}` }, child);
    const footer = el("div", { class: "efoot" }, draft.preview);
    const node = el("form", { class: `editor ${kind === "new" ? "entry" : "edit"}`, novalidate: true, "aria-label": kind === "new" ? "New transaction" : "Edit transaction" },
      el("div", { class: "erow" }, cell(0, draft.date), cell(1, draft.payee), cell(2, draft.picker.root), cell(3, draft.memo),
        cell(4, el("div", { class: "amt-wrap" }, sign, draft.amount)), el("div", { class: "c bal" })),
      footer);
    node.addEventListener("submit", (event) => event.preventDefault());
    return { node, draft, footer };
  }

  // The always-ready entry row.
  const entryRow = rowEditor("new");
  const entry = entryRow.node;
  const entryDraft = entryRow.draft;
  entryDraft.load(null);

  const body = el("div", { role: "rowgroup", class: "rbody" });
  const end = el("div", { class: "reg-end num" });
  const tableNode = el("div", { class: "reg card", role: "table", "aria-label": `${account.name} register` },
    el("div", { role: "rowgroup" }, el("div", { role: "row", class: "rhead" },
      ...columns.map((name, index) => el("div", { role: "columnheader", class: `c ${columnClass[index]}` }, name)))),
    entry,
    body,
    end);
  const addButton = el("button", { class: "btn btn-primary", type: "button" }, icon("plus", "sm"), "New transaction");
  addButton.addEventListener("click", () => openPhoneSheet(null));
  const addbar = el("div", { class: "addbar" }, addButton);
  const root = el("div", { class: "page register" }, el("div", { class: "page-row" }, heading, ctx.monthHeader), summary, note, tableNode, addbar, payeeList);

  function highlight(id: string): void {
    highlightId = id;
    window.clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(() => {
      highlightId = null;
      for (const row of body.querySelectorAll(".just-saved")) row.classList.remove("just-saved");
    }, 2600);
  }

  function showError(draft: Draft, error: unknown): void {
    const field = error instanceof DraftError ? error.field : fieldOf(error);
    draft.mark(field);
    setNote(note, messageOf(error));
  }

  let saving = false;
  async function busy<T>(form: HTMLElement, work: () => Promise<T>): Promise<T | undefined> {
    if (saving) return undefined;
    saving = true;
    form.setAttribute("aria-busy", "true");
    try {
      return await work();
    } finally {
      saving = false;
      form.removeAttribute("aria-busy");
    }
  }

  async function add(values: NewTransactionInput): Promise<RegisterTransaction> {
    const added = await client.addTransaction(account.id, values);
    highlight(added.id);
    await ctx.refresh();
    return { ...added, runningBalance: 0 };
  }

  const undoAdd = (id: string) => async () => {
    await client.deleteTransaction(id);
    await ctx.refresh();
  };
  const undoDelete = (transaction: RegisterTransaction) => async () => {
    const back = await client.addTransaction(transaction.accountId, fieldsOf(transaction));
    highlight(back.id);
    await ctx.refresh();
  };
  const undoEdit = (id: string, previous: TransactionEditInput) => async () => {
    await client.editTransaction(id, previous);
    highlight(id);
    await ctx.refresh();
  };

  async function saveEntry(): Promise<void> {
    entryDraft.clearMarks();
    setNote(note, null);
    let values;
    try {
      values = entryDraft.read();
    } catch (error) {
      showError(entryDraft, error);
      return;
    }
    await busy(entry, async () => {
      try {
        const { date, ...rest } = values;
        const added = await add(date ? values : rest);
        entryDraft.load(null, true);
        entryDraft.payee.focus();
        ctx.snack(`Added ${describe(added)}.`, undoAdd(added.id));
      } catch (error) {
        showError(entryDraft, error);
      }
    });
  }

  function onKeys(form: HTMLElement, save: () => void, cancel: () => void): void {
    form.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        save();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    });
  }
  onKeys(entry, () => void saveEntry(), () => {
    entryDraft.load(null);
    setNote(note, null);
  });

  // Editing in place: one row at a time becomes a form with Delete, Cancel and Save.
  function startEdit(transaction: RegisterTransaction): void {
    if (editing) stopEdit(false);
    const editor = rowEditor("edit");
    const del = el("button", { class: "btn btn-quiet sm del", type: "button" }, icon("trash", "sm"), "Delete");
    const cancel = el("button", { class: "btn btn-quiet sm", type: "button" }, "Cancel");
    const save = el("button", { class: "btn btn-primary sm", type: "button" }, "Save");
    editor.footer.append(el("div", { class: "eacts" }, del, cancel, save));
    editor.draft.load(transaction);
    editor.node.dataset.id = transaction.id;
    editing = { id: transaction.id, node: editor.node, draft: editor.draft };
    const doSave = () => void saveEdit(transaction, editor.draft, editor.node);
    save.addEventListener("click", doSave);
    cancel.addEventListener("click", () => stopEdit(true));
    del.addEventListener("click", () => void remove(transaction, editor.node));
    onKeys(editor.node, doSave, () => stopEdit(true));
    paint();
    editor.draft.payee.focus();
  }

  function stopEdit(focusRow: boolean): void {
    const id = editing?.id;
    editing = null;
    setNote(note, null);
    paint();
    if (focusRow && id) body.querySelector<HTMLElement>(`.rrow[data-id="${CSS.escape(id)}"]`)?.focus();
  }

  async function saveEdit(transaction: RegisterTransaction, draft: Draft, form: HTMLElement): Promise<void> {
    draft.clearMarks();
    setNote(note, null);
    let values;
    try {
      values = draft.read();
    } catch (error) {
      showError(draft, error);
      return;
    }
    const { changes, previous } = diff(transaction, values);
    if (Object.keys(changes).length === 0) {
      stopEdit(true);
      return;
    }
    await busy(form, async () => {
      try {
        const saved = await client.editTransaction(transaction.id, changes);
        editing = null;
        highlight(saved.id);
        await ctx.refresh();
            body.querySelector<HTMLElement>(`.rrow[data-id="${CSS.escape(saved.id)}"]`)?.focus();
        ctx.snack(`Saved ${describe(saved)}.`, undoEdit(saved.id, previous));
      } catch (error) {
        showError(draft, error);
      }
    });
  }

  async function remove(transaction: RegisterTransaction, form: HTMLElement): Promise<void> {
    setNote(note, null);
    await busy(form, async () => {
      try {
        await client.deleteTransaction(transaction.id);
        editing = null;
        await ctx.refresh();
            entryDraft.payee.focus();
        ctx.snack(`Deleted ${describe(transaction)}.`, undoDelete(transaction));
      } catch (error) {
        setNote(note, messageOf(error));
      }
    });
  }

  // Phone: one bottom sheet adds ("Save and add another" keeps the date) or edits a transaction.
  function openPhoneSheet(transaction: RegisterTransaction | null): void {
    const titleId = uid("tx-title");
    let signSeg!: ReturnType<typeof segmented<"out" | "in">>;
    const prefix = el("span", { class: "sign", "aria-hidden": "true" }, `${MINUS}$`);
    const draft = createDraft({
      ...draftData, payees: () => payees, payeeList: payeeListId, defaultDate, inputClass: "input", inline: true,
      onSign: (next) => {
        signSeg?.set(next > 0 ? "in" : "out");
        prefix.textContent = `${next > 0 ? "+" : MINUS}$`;
        prefix.classList.toggle("in", next > 0);
      },
    });
    signSeg = segmented("Out or in", [["out", "Out"], ["in", "In"]] as const, "out", { onChange: (value) => draft.setSign(value === "in" ? 1 : -1) });
    draft.amount.id = uid("sx-amt");
    draft.amount.removeAttribute("aria-label");
    const labelled = (text: string, control: HTMLElement, target: HTMLInputElement) => {
      target.id ||= uid("sx");
      target.removeAttribute("aria-label");
      return el("div", { class: "field" }, el("label", { for: target.id }, text), control);
    };
    const status = el("div", { class: "sstat", role: "status" });
    const accountStatus = () => status.replaceChildren(icon("bank", "sm"), el("span", {}, account.name));
    accountStatus();
    const setStatus = (kind: "ok" | "err", message: string, undo?: () => Promise<void>) => {
      status.className = `sstat ${kind}`;
      const undoButton = undo ? el("button", { class: "btn btn-quiet sm", type: "button" }, "Undo") : null;
      undoButton?.addEventListener("click", () => void run(async () => {
        await undo!();
        setStatus("ok", `Undid ${lastSaved}.`);
        draft.amount.focus();
      }));
      status.replaceChildren(icon(kind === "ok" ? "check" : "alert", "sm"), el("span", {}, message), ...(undoButton ? [undoButton] : []));
    };
    let lastSaved = "";

    const primary = el("button", { class: "btn btn-primary wide", type: "submit" }, transaction ? "Save" : "Save and add another");
    const secondary = el("button", { class: "btn btn-quiet", type: "button" },
      ...(transaction ? [icon("trash", "sm"), "Delete"] : ["Save and close"]));
    const closeButton = el("button", { class: "icon-btn", type: "button", "aria-label": "Close" }, icon("x", "sm"));
    const amountField = el("div", { class: "field" }, el("label", { for: draft.amount.id }, "Amount"), el("div", { class: "amount big" }, prefix, draft.amount));
    const form = el("form", { class: "sheet-form", novalidate: true },
      el("span", { class: "grab", "aria-hidden": "true" }),
      el("div", { class: "sheet-head" }, el("h2", { id: titleId }, transaction ? "Edit transaction" : "New transaction"), closeButton),
      status,
      el("div", { class: "sheet-body" },
        el("div", { class: "amt-row" }, amountField, signSeg.root),
        labelled("Payee", draft.payee, draft.payee),
        labelled("Category", draft.picker.root, draft.picker.input),
        draft.preview,
        el("div", { class: "two" }, labelled("Date", draft.date, draft.date), labelled("Memo", draft.memo, draft.memo))),
      el("div", { class: "sheet-footer" }, primary, el("div", { class: "frow2" }, secondary)));
    const dialog = el("dialog", { class: "sheet tx-sheet", "aria-labelledby": titleId }, form);
    draft.load(transaction);

    let running = false;
    async function run(work: () => Promise<void>): Promise<void> {
      if (running) return;
      running = true;
      form.setAttribute("aria-busy", "true");
      primary.disabled = secondary.disabled = true;
      try {
        await work();
      } catch (error) {
        draft.mark(error instanceof DraftError ? error.field : fieldOf(error));
        setStatus("err", messageOf(error));
      } finally {
        running = false;
        form.removeAttribute("aria-busy");
        primary.disabled = secondary.disabled = false;
      }
    }

    async function saveNew(close: boolean): Promise<void> {
      draft.clearMarks();
      const values = draft.read();
      const added = await add(values);
      lastSaved = describe(added);
      if (close) {
        dialog.close();
        ctx.snack(`Added ${lastSaved}.`, undoAdd(added.id));
        return;
      }
      // Ready for the next one: the date and account stay.
      draft.load(null, true);
      draft.date.value = values.date;
      setStatus("ok", `Added ${lastSaved}.`, undoAdd(added.id));
      draft.amount.focus();
    }

    async function saveExisting(existing: RegisterTransaction): Promise<void> {
      draft.clearMarks();
      const { changes, previous } = diff(existing, draft.read());
      if (Object.keys(changes).length) {
        const saved = await client.editTransaction(existing.id, changes);
        highlight(saved.id);
        await ctx.refresh();
        ctx.snack(`Saved ${describe(saved)}.`, undoEdit(saved.id, previous));
      }
      dialog.close();
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void run(() => transaction ? saveExisting(transaction) : saveNew(false));
    });
    secondary.addEventListener("click", () => void run(async () => {
      if (!transaction) return saveNew(true);
      await client.deleteTransaction(transaction.id);
      await ctx.refresh();
      dialog.close();
      ctx.snack(`Deleted ${describe(transaction)}.`, undoDelete(transaction));
    }));
    form.addEventListener("input", () => {
      draft.clearMarks();
      if (status.classList.contains("err")) {
        status.className = "sstat";
        accountStatus();
      }
    });
    closeButton.addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", (event) => { if (running) event.preventDefault(); });
    dialog.addEventListener("close", () => {
      dialog.remove();
      const row = transaction && body.querySelector<HTMLElement>(`.rrow[data-id="${CSS.escape(transaction.id)}"]`);
      (row ?? addButton).focus();
    });
    document.body.append(dialog);
    dialog.showModal();
    draft.amount.focus();
  }

  function renderRow(transaction: RegisterTransaction): HTMLElement {
    const { category } = transaction;
    const name = category.kind === "transfer" ? transferLabel(category.accountId, transaction.amount, accounts) : categoryLabel(category, table);
    const sub = el("span", { class: "sub" }, el("span", { class: "st" }, `${name} · ${shortDate(transaction.date)}`));
    const row = el("div", { role: "row", class: `rrow${transaction.id === highlightId ? " just-saved" : ""}`, tabindex: "0", "data-id": transaction.id },
      el("div", { role: "cell", class: "c date num" }, shortDate(transaction.date)),
      el("div", { role: "cell", class: "c payee" }, el("span", { class: "pn" }, transaction.payee), sub),
      el("div", { role: "cell", class: "c cat" }, categoryDot(transaction.category, table), el("span", { class: "cn" }, name)),
      el("div", { role: "cell", class: "c memo" }, el("span", {}, transaction.memo)),
      el("div", { role: "cell", class: `c amt num${transaction.amount > 0 ? " in" : ""}` }, formatMoney(transaction.amount)),
      el("div", { role: "cell", class: "c bal num" }, formatMoney(transaction.runningBalance)));
    const open = () => {
      if (account.closed) return;
      if (phone.matches) openPhoneSheet(transaction);
      else startEdit(transaction);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
    return row;
  }

  function paint(): void {
    if (editing && !transactions.some((transaction) => transaction.id === editing!.id)) editing = null;
    body.replaceChildren(...transactions.map((transaction) => transaction.id === editing?.id ? editing.node : renderRow(transaction)));
  }

  return {
    root,
    render(data: RegisterData): void {
      account = data.account;
      table = data.table;
      accounts = data.accounts;
      payees = data.payees;
      transactions = data.register.transactions;
      heading.textContent = account.name;
      // A closed account takes no new transactions.
      entry.hidden = addbar.hidden = account.closed;
      tableNode.setAttribute("aria-label", `${account.name} register`);
      const closing = data.register.balance;
      balance.textContent = formatMoney(closing, { symbol: true });
      payeeList.replaceChildren(...payees.map((entry) => el("option", { value: entry.payee })));
      paint();
      // The register ends with the balance the month began with.
      const oldest = transactions.at(-1);
      const opening = oldest ? oldest.runningBalance - oldest.amount : closing;
      end.replaceChildren(el("span", {}, `Balance before ${shortDate(`${ctx.month}-01`)}`), el("span", {}, formatMoney(opening)));
    },
    note: (message: string | null) => setNote(note, message),
  };
}
