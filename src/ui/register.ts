// An account's page: its balance, then the register (newest first, with running balances) and, on
// desktop, the always-ready entry row. Income is the only category so far.
import type { createClient } from "../client.js";
import { ApiError } from "../client.js";
import type { Account, AccountMonth, RegisterTransaction } from "../core/index.js";
import { formatMoney, parseMoney } from "../core/money.js";
import { lastDayOf } from "../core/months.js";
import { BudgetError } from "../core/types.js";
import { el, messageOf, setNote } from "./dom.js";

export interface RegisterContext {
  client: ReturnType<typeof createClient>;
  account: Account;
  /** Re-reads the account, its register and the sidebar, and redraws them. Never throws. */
  refresh(): Promise<void>;
  /** The month header; the summary and the register show its month. */
  monthHeader: HTMLElement;
  /** The month shown, "YYYY-MM". */
  month: string;
  /** Whether the month is before the current one. */
  past: boolean;
}

/** Today as YYYY-MM-DD in the viewer's own time zone. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const columns = ["Date", "Payee", "Category", "Memo", "Amount", "Balance"] as const;
const columnClass = ["date", "payee", "cat", "memo", "amt", "bal"] as const;

/** "2026-11-14" -> "Nov 14", read as a calendar date so no time zone can shift it. */
function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const categoryName = (transaction: RegisterTransaction) => transaction.category.kind === "income" ? "Income" : "";

export function createRegisterPage(ctx: RegisterContext) {
  const { client } = ctx;
  let account = ctx.account;
  const heading = el("h1", {}, account.name);
  const balance = el("p", { class: "figure num" });
  // New entries start today, or on a past month's last day; that day's balance is the summary's.
  const defaultDate = () => ctx.past ? lastDayOf(ctx.month) : today();
  const summaryLabel = ctx.past ? `Balance on ${shortDate(lastDayOf(ctx.month))}` : "Balance";
  const summary = el("div", { class: "acct-summary card" }, el("p", { class: "label" }, summaryLabel), balance);
  const note = el("div", { class: "note", role: "alert" });

  const input = (name: string, attrs: Record<string, string | boolean> = {}) =>
    el("input", { class: "cin", name, "aria-label": name[0]!.toUpperCase() + name.slice(1), autocomplete: "off", ...attrs });
  const date = input("date", { type: "date", class: "cin num" });
  const payee = input("payee", { type: "text", maxlength: "120" });
  const category = input("category", { type: "text", value: "Income", readonly: true, class: "cin locked", tabindex: "-1" });
  const memo = input("memo", { type: "text", maxlength: "500" });
  const amount = input("amount", { type: "text", inputmode: "decimal", class: "cin num amt-in" });
  const fields = { date, payee, memo, amount } as const;
  date.value = defaultDate();
  const cell = (index: number, child: HTMLElement) => el("div", { class: `c ${columnClass[index]}` }, child);
  const entry = el("form", { class: "entry editor", novalidate: true, "aria-label": "New transaction" },
    el("div", { class: "erow" }, cell(0, date), cell(1, payee), cell(2, category), cell(3, memo), cell(4, amount), el("div", { class: "c bal" })));

  const body = el("div", { role: "rowgroup", class: "rbody" });
  const end = el("div", { class: "reg-end num" });
  const table = el("div", { class: "reg card", role: "table", "aria-label": `${account.name} register` },
    el("div", { role: "rowgroup" }, el("div", { role: "row", class: "rhead" },
      ...columns.map((name, index) => el("div", { role: "columnheader", class: `c ${columnClass[index]}` }, name)))),
    entry,
    body,
    end);
  const root = el("div", { class: "page register" }, el("div", { class: "page-row" }, heading, ctx.monthHeader), summary, note, table);

  function clearInvalid(): void {
    for (const field of Object.values(fields)) field.removeAttribute("aria-invalid");
  }

  function reset(keepDate: boolean): void {
    payee.value = memo.value = amount.value = "";
    if (!keepDate) date.value = defaultDate();
    clearInvalid();
    setNote(note, null);
  }

  let saving = false;
  async function save(): Promise<void> {
    if (saving) return;
    clearInvalid();
    setNote(note, null);
    let cents: number;
    try {
      cents = parseMoney(amount.value);
    } catch (error) {
      amount.setAttribute("aria-invalid", "true");
      setNote(note, messageOf(error));
      return;
    }
    saving = true;
    entry.setAttribute("aria-busy", "true");
    try {
      await client.addTransaction(account.id, {
        ...(date.value && { date: date.value }),
        payee: payee.value,
        memo: memo.value,
        amount: cents,
        category: { kind: "income" },
      });
      reset(true);
      await ctx.refresh();
      payee.focus();
    } catch (error) {
      const field = error instanceof ApiError || error instanceof BudgetError ? error.field : undefined;
      const target = field && field in fields ? fields[field as keyof typeof fields] : undefined;
      target?.setAttribute("aria-invalid", "true");
      setNote(note, messageOf(error));
    } finally {
      saving = false;
      entry.removeAttribute("aria-busy");
    }
  }

  entry.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
  entry.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      reset(false);
    }
  });

  function renderRow(transaction: RegisterTransaction): HTMLElement {
    const sub = el("span", { class: "sub" }, el("span", { class: "st" }, `${categoryName(transaction)} · ${shortDate(transaction.date)}`));
    return el("div", { role: "row", class: "rrow" },
      el("div", { role: "cell", class: "c date num" }, shortDate(transaction.date)),
      el("div", { role: "cell", class: "c payee" }, el("span", { class: "pn" }, transaction.payee), sub),
      el("div", { role: "cell", class: "c cat" }, el("span", { class: "cn" }, categoryName(transaction))),
      el("div", { role: "cell", class: "c memo" }, el("span", {}, transaction.memo)),
      el("div", { role: "cell", class: `c amt num${transaction.amount > 0 ? " in" : ""}` }, formatMoney(transaction.amount)),
      el("div", { role: "cell", class: "c bal num" }, formatMoney(transaction.runningBalance)));
  }

  return {
    root,
    render(next: Account, { balance: closing, transactions }: AccountMonth): void {
      account = next;
      heading.textContent = account.name;
      // A closed account takes no new transactions.
      entry.hidden = account.closed;
      table.setAttribute("aria-label", `${account.name} register`);
      balance.textContent = formatMoney(closing, { symbol: true });
      body.replaceChildren(...transactions.map(renderRow));
      // The register ends with the balance the month began with.
      const oldest = transactions.at(-1);
      const opening = oldest ? oldest.runningBalance - oldest.amount : closing;
      end.replaceChildren(el("span", {}, `Balance before ${shortDate(`${ctx.month}-01`)}`), el("span", {}, formatMoney(opening)));
    },
    note: (message: string | null) => setNote(note, message),
  };
}
