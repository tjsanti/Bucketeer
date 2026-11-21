// Entry point: routing and loading. The History API drives two kinds of page:
//   /                          -> the last-used (or first) budget's Accounts page, or the first-run card
//   /budgets/<id>/accounts     -> the Accounts page
//   /budgets/<id>/accounts/<accountId> -> that account's register
//   /budgets/<id>/buckets      -> the Buckets page
// The Accounts and Buckets pages take ?month=YYYY-MM (absent for the current month); in-app links keep the chosen month.
import { createClient } from "../client.js";
import type { Account, Budget, MonthRange } from "../core/index.js";
import { addMonths } from "../core/months.js";
import { createAccountsPage } from "./accounts.js";
import { createBucketsPage } from "./buckets.js";
import { byId, el, messageOf, setNote } from "./dom.js";
import { createMonthHeader } from "./month-header.js";
import { createRegisterPage } from "./register.js";
import { field, openSheet, textInput } from "./sheet.js";
import { accountsPath, createShell } from "./shell.js";
import type { Section } from "./shell.js";

const client = createClient(window.location.origin);
const main = byId("main");
const budgetKey = "bucketeer-budget";
let routeSeq = 0;
let current: Budget | undefined;
// The month chosen on a month header and the server's current month, kept while moving between pages.
let chosenMonth: string | undefined;
let thisMonth: string | undefined;
// The header control that chose the month, refocused once the new month has drawn.
let monthFocus: "previous" | "next" | "picker" | undefined;

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

interface Side {
  accounts: Account[];
  ready: number;
}

/** The sidebar's figures: every account and Ready to assign. */
async function loadSide(budgetId: string): Promise<Side> {
  const [accounts, { readyToAssign }] = await Promise.all([client.listAccounts(budgetId), client.readyToAssign(budgetId)]);
  return { accounts, ready: readyToAssign };
}

function showSide(side: Side | null): void {
  shell.setAccounts(side?.accounts ?? null);
  shell.setReady(side?.ready ?? null);
}

/** The query that carries the chosen month, or "" for the current month. */
const monthQuery = (month: string | undefined) => month && month !== thisMonth ? `?month=${month}` : "";

/** Routes to a path; a path without a query keeps the chosen month. */
async function navigate(path: string): Promise<void> {
  const target = path.includes("?") ? path : `${path}${monthQuery(chosenMonth)}`;
  if (target !== window.location.pathname + window.location.search) window.history.pushState(null, "", target);
  await route();
}

/** The URL's month if it is inside the range, else the current month; a bad one is dropped from the URL. */
function monthFromUrl(range: MonthRange): string {
  const current = addMonths(range.last, -12);
  thisMonth = current;
  const requested = new URLSearchParams(window.location.search).get("month");
  const valid = requested !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) && requested >= range.first && requested <= range.last;
  if (requested !== null && (!valid || requested === current)) window.history.replaceState(null, "", window.location.pathname);
  chosenMonth = valid ? requested : current;
  return chosenMonth;
}

function monthHeader(range: MonthRange, month: string) {
  return createMonthHeader({
    range,
    month,
    choose(next, from) {
      chosenMonth = next;
      monthFocus = from;
      void navigate(window.location.pathname);
    },
  });
}

/** Puts focus back on the month header after a month change redraws the page. */
function restoreMonthFocus(header: ReturnType<typeof createMonthHeader>): void {
  if (monthFocus) header.focus(monthFocus);
  monthFocus = undefined;
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
      showSide(null);
      if (path !== "/") window.history.replaceState(null, "", "/");
      showFirstRun();
      return;
    }

    let id: string | undefined;
    let section: Section = "accounts";
    let accountId: string | undefined;
    const match = /^\/budgets\/([^/]+)\/(?:(buckets)|accounts(?:\/([^/]+))?)$/.exec(path);
    if (match) {
      section = match[2] ? "buckets" : "accounts";
      try {
        id = decodeURIComponent(match[1]!);
        if (match[3] !== undefined) accountId = decodeURIComponent(match[3]);
      } catch {
        id = "";
      }
    }
    if (id === undefined) {
      const target = budgets.find((budget) => budget.id === lastUsedBudget()) ?? budgets[0]!;
      window.history.replaceState(null, "", accountsPath(target.id));
      id = target.id;
    }
    current = budgets.find((budget) => budget.id === id);
    shell.setBudgets(budgets, current);
    shell.setSection(section);
    if (!current) {
      showSide(null);
      showMessage("Budget not found", "That budget does not exist.", false);
      return;
    }
    const budget = current;
    rememberBudget(budget.id);

    if (accountId !== undefined) {
      const side = await loadSide(budget.id);
      if (stale()) return;
      showSide(side);
      const account = side.accounts.find((candidate) => candidate.id === accountId);
      if (!account) {
        showMessage("Account not found", "That account does not exist in this budget.", false);
        return;
      }
      const range = await client.monthRange(budget.id);
      if (stale()) return;
      const month = monthFromUrl(range);
      const load = async () => {
        const [register, table, payees] = await Promise.all([client.accountMonth(account.id, month), client.listBucketTable(budget.id), client.payees(budget.id)]);
        return { register, table, payees };
      };
      const first = await load();
      if (stale()) return;
      const header = monthHeader(range, month);
      const page = createRegisterPage({
        client,
        account,
        snack: shell.showSnack,
        monthHeader: header.root,
        month,
        past: month < addMonths(range.last, -12),
        async refresh() {
          try {
            const [next, data] = await Promise.all([loadSide(budget.id), load()]);
            if (stale()) return;
            showSide(next);
            const current = next.accounts.find((candidate) => candidate.id === account.id);
            if (current) page.render({ account: current, ...data });
          } catch {
            if (!stale()) page.note("Your change was saved, but the register could not refresh. Reload to try again.");
          }
        },
      });
      page.render({ account, ...first });
      main.replaceChildren(page.root);
      restoreMonthFocus(header);
      document.title = `${account.name} · ${budget.name} · Bucketeer`;
      return;
    }

    if (section === "buckets") {
      const [side, range] = await Promise.all([loadSide(budget.id), client.monthRange(budget.id)]);
      if (stale()) return;
      const month = monthFromUrl(range);
      const load = async () => {
        const [table, view] = await Promise.all([client.listBucketTable(budget.id), client.bucketMonth(budget.id, month)]);
        return { table, month: view };
      };
      const first = await load();
      if (stale()) return;
      const header = monthHeader(range, month);
      const page = createBucketsPage({
        client,
        budget,
        monthHeader: header.root,
        snack: shell.showSnack,
        announce: shell.announce,
        async reload() {
          const [next, data] = await Promise.all([loadSide(budget.id), load()]);
          if (stale()) throw new Error("This page has changed.");
          showSide(next);
          return data;
        },
      });
      showSide(side);
      page.render(first);
      main.replaceChildren(page.root);
      restoreMonthFocus(header);
      document.title = `Buckets · ${budget.name} · Bucketeer`;
      return;
    }

    const [side, range] = await Promise.all([loadSide(budget.id), client.monthRange(budget.id)]);
    if (stale()) return;
    const month = monthFromUrl(range);
    const balances = await client.accountBalances(budget.id, month);
    if (stale()) return;
    const header = monthHeader(range, month);
    const page = createAccountsPage({
      client,
      budget,
      monthHeader: header.root,
      snack: shell.showSnack,
      navigate: (target) => void navigate(target),
      async refresh() {
        try {
          const [next, nextBalances] = await Promise.all([loadSide(budget.id), client.accountBalances(budget.id, month)]);
          if (stale()) return;
          showSide(next);
          page.render(next.accounts, nextBalances);
          page.note(null);
        } catch {
          if (!stale()) page.note("Your change was saved, but the accounts could not refresh. Reload to try again.");
        }
      },
    });
    showSide(side);
    page.render(side.accounts, balances);
    main.replaceChildren(page.root);
    restoreMonthFocus(header);
    document.title = `Accounts · ${budget.name} · Bucketeer`;
  } catch (error) {
    if (stale()) return;
    showSide(null);
    showMessage("Could not load", messageOf(error));
  } finally {
    if (!stale()) main.removeAttribute("aria-busy");
  }
}

window.addEventListener("popstate", () => void route());
await route();
