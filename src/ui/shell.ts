// The app frame around the page: budget picker, navigation, sidebar accounts and the snackbar.
// The markup lives in index.html; this module only fills it in and wires it up.
import type { Account, Budget } from "../core/index.js";
import { formatMoney } from "../core/money.js";
import { byId, el, icon, messageOf } from "./dom.js";

export interface ShellHandlers {
  navigate(path: string): void;
  newBudget(): void;
  renameBudget(): void;
  /** Called when an Undo from the snackbar fails. */
  undoFailed(message: string): void;
}

export const accountsPath = (budgetId: string) => `/budgets/${encodeURIComponent(budgetId)}/accounts`;

export function createShell(handlers: ShellHandlers) {
  const wrap = byId("budget-wrap");
  const button = byId<HTMLButtonElement>("budget-button");
  const label = byId("budget-label");
  const menu = byId("budget-menu");
  const budgetList = byId<HTMLUListElement>("budget-list");
  const renameItem = byId<HTMLButtonElement>("menu-rename");
  const nav = byId("nav");
  const navAccounts = byId<HTMLAnchorElement>("nav-accounts");
  const sideAccounts = byId("side-accounts");
  const sideList = byId<HTMLUListElement>("side-list");
  const snack = byId("snack");
  const snackMessage = byId("snack-msg");
  const snackUndo = byId<HTMLButtonElement>("snack-undo");
  const announceRegion = byId("announce");

  const menuItems = () => [...menu.querySelectorAll<HTMLButtonElement>("button.menu-item:not([hidden])")];
  const setOpen = (open: boolean) => {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  const closeMenu = () => {
    setOpen(false);
    button.focus();
  };

  button.addEventListener("click", () => setOpen(menu.hidden));
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && event.target instanceof Node && !wrap.contains(event.target)) setOpen(false);
  });
  // Tabbing out of the menu closes it. (focusin, not focusout: Safari does not focus buttons on click.)
  document.addEventListener("focusin", (event) => {
    if (!menu.hidden && event.target instanceof Node && !wrap.contains(event.target)) setOpen(false);
  });
  wrap.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (menu.hidden) setOpen(true);
    const items = menuItems();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const last = items.length - 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? last
      : event.key === "ArrowDown" ? (index < 0 || index === last ? 0 : index + 1)
      : (index <= 0 ? last : index - 1);
    items[next]?.focus();
  });
  byId("menu-new").addEventListener("click", () => { closeMenu(); handlers.newBudget(); });
  renameItem.addEventListener("click", () => { closeMenu(); handlers.renameBudget(); });

  // Brand and nav are real links; plain clicks route in the page.
  for (const link of [navAccounts, document.querySelector<HTMLAnchorElement>(".wordmark")]) {
    link?.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      handlers.navigate(new URL(link.href).pathname);
    });
  }

  let snackTimer: number | undefined;
  const hideSnack = () => {
    window.clearTimeout(snackTimer);
    snack.hidden = true;
  };
  const announce = (message: string) => {
    announceRegion.textContent = "";
    window.setTimeout(() => { announceRegion.textContent = message; }, 50);
  };
  snackUndo.addEventListener("click", () => {
    const undo = pendingUndo;
    hideSnack();
    undo?.().catch((error: unknown) => handlers.undoFailed(messageOf(error)));
  });
  byId("snack-x").addEventListener("click", hideSnack);
  snack.addEventListener("keydown", (event) => { if (event.key === "Escape") hideSnack(); });
  let pendingUndo: (() => Promise<void>) | undefined;
  const armSnackTimer = () => {
    window.clearTimeout(snackTimer);
    snackTimer = window.setTimeout(() => {
      // Never pull the snackbar out from under a keyboard user who is on it.
      if (snack.contains(document.activeElement)) armSnackTimer();
      else hideSnack();
    }, 6000);
  };

  return {
    announce,
    /** The picker needs at least one budget; with none the first-run card is the only control. */
    setBudgets(budgets: Budget[], current: Budget | undefined): void {
      wrap.hidden = budgets.length === 0;
      label.textContent = current?.name ?? "Choose a budget";
      renameItem.hidden = !current;
      renameItem.parentElement!.hidden = !current;
      budgetList.replaceChildren(...budgets.map((budget) => {
        const item = el("button", { class: "menu-item", type: "button" }, el("span", { class: "mi-name" }, budget.name));
        if (budget.id === current?.id) {
          item.setAttribute("aria-current", "true");
          item.append(icon("check", "sm"));
        }
        item.addEventListener("click", () => {
          closeMenu();
          handlers.navigate(accountsPath(budget.id));
        });
        return el("li", {}, item);
      }));
      nav.hidden = !current;
      if (current) navAccounts.href = accountsPath(current.id);
    },
    /** null hides the sidebar list (no budget, or nothing to show). */
    setAccounts(accounts: Account[] | null): void {
      const open = accounts?.filter((account) => !account.closed) ?? [];
      sideAccounts.hidden = open.length === 0;
      const total = open.reduce((sum, account) => sum + account.balance, 0);
      sideList.replaceChildren(
        ...open.map((account) => el("li", { class: "row" }, el("span", { class: "an" }, account.name), el("span", {}, formatMoney(account.balance)))),
        el("li", { class: "total" }, el("span", {}, "Total"), el("span", {}, formatMoney(total, { symbol: true }))));
    },
    showSnack(message: string, undo: () => Promise<void>): void {
      pendingUndo = undo;
      snackMessage.textContent = message;
      snack.hidden = false;
      announce(message);
      armSnackTimer();
    },
    hideSnack,
  };
}
