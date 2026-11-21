// The Accounts page: the table, the closed list, and the Add and Edit dialogs.
// Amounts come from the server in cents; parsing and formatting live in core/money.
import type { createClient } from "../client.js";
import type { Account, AccountType, Budget } from "../core/index.js";
import { formatMoney, parseMoney } from "../core/money.js";
import { el, icon, messageOf, setNote } from "./dom.js";
import { field, moneyInput, openSheet, segmented, textInput, uid } from "./sheet.js";
import { accountPath, routeLink } from "./shell.js";

export interface AccountsContext {
  client: ReturnType<typeof createClient>;
  budget: Budget;
  /** Re-reads the accounts and redraws the sidebar and this page. Never throws. */
  refresh(): Promise<void>;
  /** Shows a snackbar with an Undo button. */
  snack(message: string, undo: () => Promise<void>): void;
  /** Routes to another page of the app. */
  navigate(path: string): void;
}

const typeOptions = [["checking", "Checking"], ["savings", "Savings"], ["credit-card", "Credit card"], ["cash", "Cash"]] as const;

/** Today as YYYY-MM-DD in the viewer's own time zone. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const closedDate = (iso: string | null) => iso
  ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  : "";

export function createAccountsPage(ctx: AccountsContext) {
  const { client, budget } = ctx;
  const addButton = el("button", { class: "btn btn-secondary", type: "button" }, icon("plus"), "Add account");
  const note = el("div", { class: "note", role: "alert" });
  const content = el("div", { class: "accounts-content" });
  const root = el("div", { class: "page" },
    el("div", { class: "page-row" }, el("h1", {}, "Accounts"), addButton),
    note,
    content);
  let closedOpen = false;

  const editButton = (id: string) => [...content.querySelectorAll<HTMLButtonElement>("[data-edit-id]")].find((button) => button.dataset.editId === id) ?? null;

  /** Add and Edit share the name, balance and date fields. */
  function accountFields(initial: { name: string; type: AccountType; amount: string; date: string; typeLocked: boolean }) {
    const name = field("Name", (id) => textInput(id, initial.name));
    const nameInput = name.root.querySelector("input") as HTMLInputElement;
    const amount = field(initial.type === "credit-card" ? "Amount owed" : "Starting balance", (id) => moneyInput(id, initial.amount).wrap);
    const amountInput = amount.root.querySelector("input") as HTMLInputElement;
    const type = segmented("Account type", typeOptions, initial.type, {
      disabled: initial.typeLocked,
      onChange: (value) => { amount.label.textContent = value === "credit-card" ? "Amount owed" : "Starting balance"; },
    });
    const typeLabel = uid("type-label");
    const typeField = el("div", { class: "field" }, el("span", { class: "flabel", id: typeLabel }, "Type"), type.root);
    type.root.setAttribute("aria-labelledby", typeLabel);
    type.root.removeAttribute("aria-label");
    const date = field("Balance on", (id) => {
      const input = el("input", { class: "input num", id, type: "date" });
      input.value = initial.date;
      return input;
    });
    const dateInput = date.root.querySelector("input") as HTMLInputElement;
    /** Cents as the server stores them: a card's debt is negative, but the user types what they owe. */
    const cents = () => {
      const typed = amountInput.value.trim() === "" ? 0 : parseMoney(amountInput.value);
      return (type.value() === "credit-card" ? -typed : typed) || 0;
    };
    const dateValue = () => {
      if (!dateInput.value) throw new Error("Choose the date this balance is from.");
      return dateInput.value;
    };
    return { nameField: name.root, nameInput, typeField, amountField: amount.root, dateField: date.root, type, cents, dateValue };
  }

  function openAdd(): void {
    const f = accountFields({ name: "", type: "checking", amount: "", date: today(), typeLocked: false });
    openSheet({
      title: "Add account",
      submitLabel: "Add account",
      returnFocus: () => addButton,
      body: () => [f.nameField, f.typeField, el("div", { class: "two" }, f.amountField, f.dateField)],
      submit: async () => {
        const startingBalance = f.cents();
        const startingDate = f.dateValue();
        await client.createAccount(budget.id, { name: f.nameInput.value, type: f.type.value(), startingBalance, startingDate });
        await ctx.refresh();
      },
    });
  }

  function openEdit(account: Account): void {
    const card = account.type === "credit-card";
    const f = accountFields({
      name: account.name,
      type: account.type,
      amount: formatMoney(card ? -account.startingBalance || 0 : account.startingBalance),
      date: account.startingDate,
      typeLocked: true,
    });
    const whyId = uid("why");
    const closeRow = el("div", { class: "close-row" });
    openSheet({
      title: `Edit ${account.name}`,
      submitLabel: "Save",
      returnFocus: () => editButton(account.id) ?? addButton,
      body: (sheet) => {
        if (account.balance === 0) {
          const close = el("button", { class: "btn btn-danger", type: "button" }, `Close ${account.name}`);
          close.addEventListener("click", () => void sheet.run(async () => {
            await client.closeAccount(account.id);
            await ctx.refresh();
            ctx.snack(`Closed ${account.name}.`, async () => {
              await client.reopenAccount(account.id);
              await ctx.refresh();
              editButton(account.id)?.focus();
            });
          }));
          closeRow.append(close);
        } else {
          closeRow.append(
            el("button", { class: "btn btn-danger", type: "button", disabled: true, "aria-describedby": whyId }, `Close ${account.name}`),
            el("span", { class: "why num", id: whyId }, `Balance must be ${formatMoney(0)}`));
        }
        return [f.nameField, f.typeField, el("div", { class: "two" }, f.amountField, f.dateField),
          el("div", { class: "field close-field" }, el("span", { class: "flabel" }, "Close account"), closeRow)];
      },
      submit: async () => {
        const changes: { name?: string; startingBalance?: number; startingDate?: string } = {};
        const startingBalance = f.cents();
        const startingDate = f.dateValue();
        if (f.nameInput.value.trim() !== account.name) changes.name = f.nameInput.value;
        if (startingBalance !== account.startingBalance) changes.startingBalance = startingBalance;
        if (startingDate !== account.startingDate) changes.startingDate = startingDate;
        if (Object.keys(changes).length === 0) return;
        await client.editAccount(account.id, changes);
        await ctx.refresh();
      },
    });
  }

  addButton.addEventListener("click", openAdd);

  async function reopen(account: Account, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    setNote(note, null);
    try {
      await client.reopenAccount(account.id);
      await ctx.refresh();
      editButton(account.id)?.focus();
    } catch (error) {
      button.disabled = false;
      setNote(note, messageOf(error));
    }
  }

  function renderTable(open: Account[]): HTMLElement {
    const total = open.reduce((sum, account) => sum + account.balance, 0);
    const rows = open.map((account) => {
      const edit = el("button", { class: "row-edit", type: "button", "aria-label": `Edit ${account.name}`, "data-edit-id": account.id }, icon("pencil"));
      const row = el("tr", { class: "orow" },
        el("th", { scope: "row", class: "aname" }, routeLink(el("a", { href: accountPath(budget.id, account.id) }, account.name), ctx.navigate)),
        el("td", { class: "bal num" }, formatMoney(account.balance)),
        el("td", { class: "go" }, edit));
      row.addEventListener("click", (event) => {
        if (!(event.target instanceof Element && event.target.closest("a"))) openEdit(account);
      });
      return row;
    });
    return el("div", { class: "otable card" }, el("table", { "aria-label": "Accounts" },
      el("thead", {}, el("tr", {},
        el("th", { scope: "col" }, "Account"),
        el("th", { scope: "col", class: "bal" }, "Balance"),
        el("th", { scope: "col", class: "go" }, el("span", { class: "sr-only" }, "Edit")))),
      el("tbody", {}, ...rows),
      el("tfoot", {}, el("tr", { class: "ototal" },
        el("th", { scope: "row" }, "Total"),
        el("td", { class: "bal num" }, formatMoney(total, { symbol: true })),
        el("td", { class: "go" })))));
  }

  function renderClosed(closed: Account[]): HTMLElement {
    const list = el("ul", {}, ...closed.map((account) => {
      const button = el("button", { class: "btn btn-quiet sm", type: "button", "aria-label": `Reopen ${account.name}` }, "Reopen");
      button.addEventListener("click", () => void reopen(account, button));
      return el("li", {},
        el("span", { class: "cname" }, account.name),
        el("span", { class: "cmeta num" }, `Closed ${closedDate(account.closedAt)} · ${formatMoney(account.balance)}`),
        button);
    }));
    const details = el("details", { class: "closed", open: closedOpen }, el("summary", {}, `Closed accounts · ${closed.length}`, icon("down", "sm")), list);
    details.addEventListener("toggle", () => { closedOpen = details.open; });
    return details;
  }

  function render(next: Account[]): void {
    const open = next.filter((account) => !account.closed);
    const closed = next.filter((account) => account.closed);
    if (closed.length === 0) closedOpen = false;
    content.replaceChildren(
      open.length ? renderTable(open) : el("p", { class: "empty" }, "No accounts yet."),
      ...(closed.length ? [renderClosed(closed)] : []));
  }

  return {
    root,
    render,
    note: (message: string | null) => setNote(note, message),
  };
}
