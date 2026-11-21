// The category combobox for transactions: Income first, then each bucket group with its active buckets
// (colour dot and Available, overspent in red), then the accounts money can be transferred to (with their
// balances). Typing filters; the arrows and Enter pick. Archived buckets are never offered, but a transaction
// already filed to one still shows its name.
import type { Account, Bucket, BucketTable, Category, CategoryInput } from "../core/index.js";
import { formatMoney } from "../core/money.js";
import { el, icon, withVars } from "./dom.js";
import { uid } from "./sheet.js";

interface Option {
  category: CategoryInput;
  label: string;
  group: string;
  bucket?: Bucket;
  account?: Account;
}

export interface CategoryPicker {
  root: HTMLElement;
  input: HTMLInputElement;
  value(): CategoryInput | null;
  /** Sets the value without counting as the user's choice. */
  set(category: CategoryInput | null): void;
  isOpen(): boolean;
}

/** A transfer is the same category whatever its transferId: the server keeps the pair's. */
export function sameCategory(a: CategoryInput | null, b: CategoryInput | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "bucket") return b.kind === "bucket" && a.bucketId === b.bucketId;
  if (a.kind === "transfer") return b.kind === "transfer" && a.accountId === b.accountId;
  return a.kind === b.kind;
}

const accountName = (accounts: readonly Account[], id: string) => accounts.find((account) => account.id === id)?.name ?? "";

/** The category as its field shows it: "Income", the bucket's name, or "Transfer · Visa". */
export function categoryLabel(category: CategoryInput | Category, table: BucketTable, accounts: readonly Account[] = []): string {
  if (category.kind === "income") return "Income";
  if (category.kind === "transfer") return `Transfer · ${accountName(accounts, category.accountId)}`;
  return table.buckets.find((bucket) => bucket.id === category.bucketId)?.name ?? "";
}

/** A transfer in a register row: "To Visa" for money out, "From Checking" for money in. */
export function transferLabel(otherAccountId: string, amount: number, accounts: readonly Account[]): string {
  return `${amount < 0 ? "To" : "From"} ${accountName(accounts, otherAccountId)}`;
}

/** The dot shown before a category: the bucket's colour, a violet ring for Income, or the transfer arrows. */
export function categoryDot(category: CategoryInput | Category | null, table: BucketTable): HTMLElement | null {
  if (!category) return null;
  if (category.kind === "income") return withVars(el("span", { class: "dot ring", "aria-hidden": "true" }), { "--c": "var(--unassigned)" });
  if (category.kind === "transfer") return el("span", { class: "lead-ic", "aria-hidden": "true" }, icon("xfer", "sm"));
  const bucket = table.buckets.find((candidate) => candidate.id === category.bucketId);
  return bucket ? withVars(el("span", { class: "dot", "aria-hidden": "true" }), { "--c": `var(--b-${bucket.colour})` }) : null;
}

function optionsOf(table: BucketTable, accounts: readonly Account[]): Option[] {
  const options: Option[] = [{ category: { kind: "income" }, label: "Income", group: "" }];
  for (const group of table.groups) {
    for (const bucket of table.buckets) {
      if (bucket.archived || bucket.groupId !== group.id) continue;
      options.push({ category: { kind: "bucket", bucketId: bucket.id }, label: bucket.name, group: group.name, bucket });
    }
  }
  for (const account of accounts) options.push({ category: { kind: "transfer", accountId: account.id }, label: account.name, group: "Transfer", account });
  return options;
}

/**
 * `inline` lays the list out under the field (the phone sheet); otherwise it floats over the page in a fixed
 * layer, so the register's rounded card can't clip it.
 */
export function categoryPicker(config: {
  label: string;
  table: () => BucketTable;
  /** Every account in the budget, for naming a transfer's other account. */
  accounts?: () => readonly Account[];
  /** The accounts this transaction can be transferred to, in the order to offer them. */
  transferAccounts?: () => readonly Account[];
  value: CategoryInput | null;
  inline?: boolean;
  onPick?: (category: CategoryInput) => void;
  inputClass?: string;
}): CategoryPicker {
  let value = config.value;
  const transferAccounts = config.transferAccounts ?? (() => []);
  const labelOf = (category: CategoryInput) => categoryLabel(category, config.table(), config.accounts?.() ?? transferAccounts());
  let shown: Option[] = [];
  let active = 0;
  const listId = uid("cat-list");
  const lead = el("span", { class: "lead" });
  const input = el("input", {
    class: config.inputClass ?? "cin has-chev", type: "text", autocomplete: "off", role: "combobox", "aria-label": config.label,
    "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": listId, placeholder: "Choose",
  });
  const list = el("div", { class: config.inline ? "picker inline" : "picker", role: "listbox", id: listId, "aria-label": "Categories", hidden: true });
  // Pressing the list must not move focus off the input.
  list.addEventListener("mousedown", (event) => event.preventDefault());
  const root = el("div", { class: "cat-in" }, lead, input, icon("down", "sm"), config.inline ? list : null);

  function paintValue(): void {
    const table = config.table();
    input.value = value ? labelOf(value) : "";
    lead.replaceChildren(...[categoryDot(value, table)].filter((node): node is HTMLElement => !!node));
    root.classList.toggle("has-lead", !!value);
  }

  function place(): void {
    if (config.inline || list.hidden) return;
    const box = input.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    list.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 328))}px`;
    if (below < 240 && box.top > below) {
      list.style.top = "";
      list.style.bottom = `${window.innerHeight - box.top + 4}px`;
    } else {
      list.style.bottom = "";
      list.style.top = `${box.bottom + 4}px`;
    }
  }

  function render(filter: string): void {
    const text = filter.trim().toLowerCase();
    shown = optionsOf(config.table(), transferAccounts()).filter((option) => !text || option.label.toLowerCase().includes(text) || (option.group && option.group.toLowerCase().startsWith(text)));
    const current = shown.findIndex((option) => sameCategory(option.category, value));
    active = text ? 0 : Math.max(0, current);
    const nodes: HTMLElement[] = [];
    let group: string | null = null;
    shown.forEach((option, index) => {
      if (option.group !== group) {
        group = option.group;
        if (group) nodes.push(el("div", { class: "og", role: "presentation" }, group));
      }
      const figure = option.bucket ? el("span", { class: `ov num${option.bucket.available < 0 ? " neg" : ""}` }, formatMoney(option.bucket.available))
        : option.account ? el("span", { class: "ov num" }, formatMoney(option.account.balance)) : null;
      const node = el("div", { class: "opt", role: "option", id: `${listId}-${index}`, "aria-selected": "false" },
        categoryDot(option.category, config.table()), el("span", { class: "on" }, option.label), figure);
      node.addEventListener("click", () => choose(index));
      nodes.push(node);
    });
    list.replaceChildren(...(nodes.length ? nodes : [el("div", { class: "picker-empty" }, "No match")]));
    paintActive();
  }

  function paintActive(): void {
    list.querySelectorAll(".opt").forEach((node, index) => node.setAttribute("aria-selected", String(index === active)));
    const node = shown.length ? document.getElementById(`${listId}-${active}`) : null;
    if (node) {
      input.setAttribute("aria-activedescendant", node.id);
      if (node.offsetTop < list.scrollTop) list.scrollTop = node.offsetTop - 6;
      else if (node.offsetTop + node.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = node.offsetTop + node.offsetHeight - list.clientHeight + 6;
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  const isOpen = () => !list.hidden;
  function open(filter = ""): void {
    // The floating list lives on the body only while open, so a picker that leaves the page leaves nothing behind.
    if (!config.inline && !list.isConnected) document.body.append(list);
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    render(filter);
    place();
    if (!config.inline) {
      window.addEventListener("resize", place);
      document.addEventListener("scroll", place, true);
    }
  }
  function close(): void {
    window.removeEventListener("resize", place);
    document.removeEventListener("scroll", place, true);
    list.hidden = true;
    if (!config.inline) list.remove();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function choose(index: number): void {
    const option = shown[index];
    close();
    if (!option) {
      paintValue();
      return;
    }
    value = option.category;
    paintValue();
    config.onPick?.(value);
  }

  input.addEventListener("focus", () => {
    input.select();
    if (!isOpen()) open();
  });
  input.addEventListener("click", () => { if (!isOpen()) open(); });
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen()) open();
      else if (shown.length) {
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
        paintActive();
      }
    } else if (event.key === "Enter" && isOpen()) {
      // Picks the option; it doesn't save the row around it.
      event.preventDefault();
      event.stopPropagation();
      choose(active);
    } else if (event.key === "Escape" && isOpen()) {
      event.preventDefault();
      event.stopPropagation();
      close();
      paintValue();
    } else if (event.key === "Tab" && isOpen()) {
      // Typeahead: Tab takes the highlighted match for what was typed.
      if (input.value && input.value !== (value ? labelOf(value) : "")) choose(active);
      else close();
    }
  });
  input.addEventListener("blur", () => {
    close();
    paintValue();
  });
  paintValue();

  return {
    root,
    input,
    value: () => value,
    set(category) {
      value = category;
      paintValue();
    },
    isOpen,
  };
}
