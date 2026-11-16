// Entry point: routing and loading. The History API drives two kinds of page:
//   /                          -> the last-used (or first) budget's Accounts page, or the first-run card
//   /budgets/<id>/accounts     -> the Accounts page
import { createClient } from "../client.js";
import type { Budget } from "../core/index.js";
import { createAccountsPage } from "./accounts.js";
import { byId, el, messageOf, setNote } from "./dom.js";
import { field, openSheet, textInput } from "./sheet.js";
import { accountsPath, createShell } from "./shell.js";

const client = createClient(window.location.origin);
const main = byId("main");
const budgetKey = "bucketeer-budget";
let routeSeq = 0;
let current: Budget | undefined;

function lastUsedBudget(): string | undefined {
  try {
    return window.localStorage.getItem(budgetKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberBudget(id: string): void {
  try {
    window.localStorage.setItem(budgetKey, id);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the route still works.
  }
}

const shell = createShell({
  navigate,
  newBudget: () => openBudgetSheet(),
  renameBudget: () => { if (current) openBudgetSheet(current); },
  undoFailed: (message) => {
    const note = main.querySelector<HTMLElement>(".page > .note");
    if (note) setNote(note, message);
  },
});

async function navigate(path: string): Promise<void> {
  if (path !== window.location.pathname) window.history.pushState(null, "", path);
  await route();
}

/** Name dialog for both "New budget" and "Rename budget". */
function openBudgetSheet(existing?: Budget): void {
  const name = field("Name", (id) => textInput(id, existing?.name ?? ""));
  const input = name.root.querySelector("input") as HTMLInputElement;
  openSheet({
    title: existing ? "Rename budget" : "New budget",
    submitLabel: existing ? "Save" : "Create budget",
    returnFocus: () => byId("budget-button"),
    body: () => [name.root],
    submit: async () => {
      if (existing) {
        await client.renameBudget(existing.id, { name: input.value });
        await route();
      } else {
        const budget = await client.createBudget({ name: input.value });
        await navigate(accountsPath(budget.id));
      }
    },
  });
}

function showMessage(title: string, message: string, retry = true): void {
  const note = el("div", { class: "note", role: "alert" });
  setNote(note, message);
  const retryButton = el("button", { class: "btn btn-secondary", type: "button" }, "Try again");
  retryButton.addEventListener("click", () => void route());
  main.replaceChildren(el("div", { class: "page" }, el("div", { class: "page-row" }, el("h1", {}, title)), note, retry ? retryButton : null));
  document.title = `${title} · Bucketeer`;
}

function showFirstRun(): void {
  const name = field("Budget name", (id) => textInput(id, ""));
  const input = name.root.querySelector("input") as HTMLInputElement;
  const submit = el("button", { class: "btn btn-primary", type: "submit" }, "Create budget");
  const note = el("div", { class: "note", role: "alert" });
  const fields = el("fieldset", { class: "sheet-fields" }, name.root);
  const form = el("form", { class: "start-form", novalidate: true }, fields, note, submit);
  form.addEventListener("input", () => setNote(note, null));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setNote(note, null);
    fields.disabled = submit.disabled = true;
    form.setAttribute("aria-busy", "true");
    try {
      const budget = await client.createBudget({ name: input.value });
      await navigate(accountsPath(budget.id));
    } catch (error) {
      setNote(note, messageOf(error));
      form.removeAttribute("aria-busy");
      fields.disabled = submit.disabled = false;
      input.focus();
    }
  });
  main.replaceChildren(el("div", { class: "page" }, el("section", { class: "start card" }, el("h1", {}, "Start a budget"), form)));
  document.title = "Bucketeer";
  input.focus();
}

async function route(): Promise<void> {
  const seq = ++routeSeq;
  const stale = () => seq !== routeSeq;
  main.setAttribute("aria-busy", "true");
  shell.hideSnack();
  const path = window.location.pathname.replace(/\/+$/, "") || "/";

  try {
    const budgets = await client.listBudgets();
    if (stale()) return;
    if (budgets.length === 0) {
      current = undefined;
      shell.setBudgets(budgets, undefined);
      shell.setAccounts(null);
      if (path !== "/") window.history.replaceState(null, "", "/");
      showFirstRun();
      return;
    }

    let id: string | undefined;
    try {
      id = /^\/budgets\/([^/]+)\/accounts$/.exec(path)?.[1];
      if (id !== undefined) id = decodeURIComponent(id);
    } catch {
      id = "";
    }
    if (id === undefined) {
      const target = budgets.find((budget) => budget.id === lastUsedBudget()) ?? budgets[0]!;
      window.history.replaceState(null, "", accountsPath(target.id));
      id = target.id;
    }
    current = budgets.find((budget) => budget.id === id);
    shell.setBudgets(budgets, current);
    if (!current) {
      shell.setAccounts(null);
      showMessage("Budget not found", "That budget does not exist.", false);
      return;
    }
    const budget = current;
    rememberBudget(budget.id);

    const accounts = await client.listAccounts(budget.id);
    if (stale()) return;
    const page = createAccountsPage({
      client,
      budget,
      snack: shell.showSnack,
      async refresh() {
        try {
          const next = await client.listAccounts(budget.id);
          if (stale()) return;
          shell.setAccounts(next);
          page.render(next);
          page.note(null);
        } catch {
          if (!stale()) page.note("Your change was saved, but the accounts could not refresh. Reload to try again.");
        }
      },
    });
    shell.setAccounts(accounts);
    page.render(accounts);
    main.replaceChildren(page.root);
    document.title = `Accounts · ${budget.name} · Bucketeer`;
  } catch (error) {
    if (stale()) return;
    shell.setAccounts(null);
    showMessage("Could not load", messageOf(error));
  } finally {
    if (!stale()) main.removeAttribute("aria-busy");
  }
}

window.addEventListener("popstate", () => void route());
await route();
