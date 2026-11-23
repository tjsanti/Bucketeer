// Recent activity: the budget's latest transactions, read-only, newest first. The Accounts overview adds an
// Account column. A transfer appears once, by its money-out side, as "Transfer · Checking → Visa" with an
// unsigned amount. There's no "View all" link until the Transactions page exists.
import type { Account, BucketTable, Transaction } from "../core/index.js";
import { formatMoney } from "../core/money.js";
import { categoryDot, categoryLabel } from "./category-picker.js";
import { el } from "./dom.js";

/** How many transactions the list shows. */
export const RECENT_LIMIT = 6;

/** "2026-11-14" -> "Nov 14", read as a calendar date so no time zone can shift it. */
function shortDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The section, or null when the budget has no transactions yet. */
export function recentActivity(config: { transactions: Transaction[]; accounts: Account[]; table: BucketTable; showAccount: boolean }): HTMLElement | null {
  const { transactions, accounts, table, showAccount } = config;
  if (transactions.length === 0) return null;
  const nameOf = (id: string) => accounts.find((account) => account.id === id)?.name ?? "";
  const cell = (className: string, ...children: (Node | string | null)[]) => el("div", { role: "cell", class: `c ${className}` }, ...children);

  const rows = transactions.map((transaction) => {
    const { category } = transaction;
    const from = nameOf(transaction.accountId);
    const transfer = category.kind === "transfer";
    const path = transfer ? `${from} → ${nameOf(category.accountId)}` : from;
    const label = transfer ? (showAccount ? "Transfer" : `Transfer · ${path}`) : categoryLabel(category, table);
    const amount = transfer ? Math.abs(transaction.amount) : transaction.amount;
    // On a phone the row is two lines: the payee (or the category, when there's no payee) over the date and the rest.
    const sub = [shortDate(transaction.date), ...(transaction.payee ? [label] : []), ...(showAccount && !transfer ? [from] : []), ...(transfer && !transaction.payee ? [path] : [])].join(" · ");
    return el("div", { role: "row", class: "arow" },
      cell("date num", shortDate(transaction.date)),
      cell("payee", el("span", { class: "pn" }, transaction.payee), transaction.payee ? null : el("span", { class: "pfall" }, transfer ? "Transfer" : label),
        el("span", { class: "sub" }, sub)),
      cell("cat", categoryDot(category, table), el("span", { class: "cn" }, label)),
      showAccount ? cell("acct", el("span", { class: "cn" }, path)) : null,
      cell(`amt num${!transfer && amount > 0 ? " in" : ""}`, formatMoney(amount)));
  });

  const headings = ["Date", "Payee", "Category", ...(showAccount ? ["Account"] : []), "Amount"];
  const headingClass = ["date", "payee", "cat", ...(showAccount ? ["acct"] : []), "amt"];
  return el("section", { class: "recent", "aria-labelledby": "recent-h" },
    el("h2", { id: "recent-h" }, "Recent activity"),
    el("div", { class: `atable card${showAccount ? " with-acct" : ""}`, role: "table", "aria-label": "Recent activity" },
      el("div", { role: "rowgroup" }, el("div", { role: "row", class: "ahead" },
        ...headings.map((name, index) => el("div", { role: "columnheader", class: `c ${headingClass[index]}` }, name)))),
      el("div", { role: "rowgroup" }, ...rows)));
}
