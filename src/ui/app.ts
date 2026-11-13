import { createClient } from "../client.js";
import type { Budget } from "../core/index.js";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const client = createClient(window.location.origin);
const form = element<HTMLFormElement>("budget-form");
const name = element<HTMLInputElement>("budget-name");
const save = element<HTMLButtonElement>("save-budget");
const newBudget = element<HTMLButtonElement>("new-budget");
const list = element<HTMLUListElement>("budget-list");
const listMessage = element("list-message");
const errorMessage = element("error-message");
const saveMessage = element("save-message");
let selected: Budget | undefined;
let busy = false;
let selectionRequest = 0;

const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function showError(error: unknown): void {
  errorMessage.textContent = error instanceof Error ? error.message : "Could not load your budget. Try again.";
  errorMessage.hidden = false;
}

function setBusy(value: boolean): void {
  busy = value;
  name.disabled = value;
  save.disabled = value;
  newBudget.disabled = value;
  form.setAttribute("aria-busy", String(value));
}

function showBudget(budget?: Budget): void {
  selected = budget;
  name.value = budget?.name ?? "";
  element("editor-heading").textContent = budget?.name ?? "Start a budget.";
  element("editor-state").textContent = budget ? "YOUR BUDGET" : "GETTING STARTED";
  element("editor-description").textContent = budget ? "Your budget is saved. Change its name here whenever you need." : "Give it a name. You can save it now and pick it up whenever you need.";
  element("budget-details").hidden = !budget;
  if (budget) {
    element("created-at").textContent = date(budget.createdAt);
    element("updated-at").textContent = date(budget.updatedAt);
  }
  saveMessage.textContent = "";
  errorMessage.hidden = true;
  for (const link of list.querySelectorAll<HTMLAnchorElement>("a")) {
    if (link.dataset.id === budget?.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function refreshList(): Promise<void> {
  const budgets = await client.listBudgets();
  list.replaceChildren();
  listMessage.textContent = budgets.length ? "" : "No budgets yet. Save your first one to get started.";
  listMessage.hidden = budgets.length > 0;
  for (const budget of budgets) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.className = "budget-link";
    link.href = `#${encodeURIComponent(budget.id)}`;
    link.dataset.id = budget.id;
    if (selected?.id === budget.id) link.setAttribute("aria-current", "page");
    const title = document.createElement("strong");
    title.textContent = budget.name;
    const saved = document.createElement("span");
    saved.textContent = `Saved ${date(budget.updatedAt)}`;
    link.append(title, saved);
    item.append(link);
    list.append(item);
  }
}

async function loadSelection(): Promise<void> {
  const request = ++selectionRequest;
  const id = window.location.hash.slice(1);
  if (!id) {
    showBudget();
    setBusy(false);
    return;
  }
  setBusy(true);
  try {
    const budget = await client.openBudget(decodeURIComponent(id));
    if (request === selectionRequest) showBudget(budget);
  } catch (error) {
    if (request === selectionRequest) {
      showBudget();
      showError(error);
    }
  } finally {
    if (request === selectionRequest) setBusy(false);
  }
}

newBudget.addEventListener("click", () => {
  if (busy) return;
  window.history.pushState(null, "", window.location.pathname);
  showBudget();
  name.focus();
});
list.addEventListener("click", (event) => { if (busy) event.preventDefault(); });
window.addEventListener("hashchange", () => { void loadSelection(); });
name.addEventListener("input", () => { saveMessage.textContent = "Unsaved changes"; });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  errorMessage.hidden = true;
  saveMessage.textContent = "Saving...";
  try {
    const input = { name: name.value };
    const budget = await (selected ? client.renameBudget(selected.id, input) : client.createBudget(input));
    window.history.replaceState(null, "", `#${encodeURIComponent(budget.id)}`);
    showBudget(budget);
    saveMessage.textContent = "Saved";
    try {
      await refreshList();
    } catch {
      showError(new Error("Your budget was saved, but the budget list could not refresh. Reload to try again."));
    }
  } catch (error) {
    saveMessage.textContent = "";
    showError(error);
  } finally {
    setBusy(false);
  }
});

try {
  setBusy(true);
  await refreshList();
  await loadSelection();
} catch (error) {
  listMessage.textContent = "Could not load budgets. Reload to try again.";
  showError(error);
  setBusy(false);
}
