// The Buckets page for one month: groups and buckets in a table with each bucket's target, Spent and
// Available that month, the group menu with inline rename, the archived fold, and reordering (drag,
// Alt+arrows, and the phone Reorder state). Every change saves at once and offers Undo as an inverse
// operation. Amounts and every total come from the server in cents; formatting lives in core/money.
import type { createClient } from "../client.js";
import type { Bucket, BucketGroup, BucketMonth, BucketMonthView, BucketTable, Budget, GroupMonth, MonthSummary } from "../core/index.js";
import { formatMoney } from "../core/money.js";
import { monthLabel, openBucketDialog } from "./bucket-dialog.js";
import { el, icon, messageOf, setNote, withVars } from "./dom.js";
import { openRainPreview, rainButton } from "./rain.js";
import { textInput, uid } from "./sheet.js";
import { attachReorder, locate } from "./reorder.js";
import type { Layout, MoveKey, MoveTarget } from "./reorder.js";

/** Every bucket (for editing, ordering and the archived fold) and the month the page shows. */
export interface BucketsData {
  table: BucketTable;
  month: BucketMonthView;
}

export interface BucketsContext {
  client: ReturnType<typeof createClient>;
  budget: Budget;
  /** The month header, beside the page title. */
  monthHeader: HTMLElement;
  /** The server's current month: Make it rain is offered for it and later months only. */
  thisMonth: string;
  /** Re-reads the table and the month. Throws if the page was left meanwhile. */
  reload(): Promise<BucketsData>;
  snack(message: string, undo: () => Promise<void>): void;
  announce(message: string): void;
}

const phone = window.matchMedia("(max-width: 600px)");
// Window and document listeners belong to the page on screen; a new page drops the old one's.
let pageListeners: AbortController | undefined;
const svgNs = "http://www.w3.org/2000/svg";

/**
 * A recurring bucket's vessel: an 18×22 bucket that fills with this month's assigned ÷ monthly amount, clamped
 * to 0–100%. Amber while filling, a soft green when the target is met.
 */
function vessel(assigned: number, amount: number): SVGSVGElement {
  const share = Math.max(0, Math.min(1, assigned / amount));
  const full = assigned >= amount;
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("class", full ? "vessel" : "vessel part");
  svg.setAttribute("viewBox", "0 0 18 22");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", full ? "Monthly target met" : `${Math.round(share * 100)}% of this month’s target assigned`);
  if (share > 0) {
    // The bucket's shape cut at the fill level: its walls taper from 2.1 at the rim (y 3) to 4.6 at the base (y 20.6).
    const top = 3;
    const bottom = 20.6;
    const y = bottom - share * (bottom - top);
    const inset = 2.1 + ((y - top) / (bottom - top)) * 2.5;
    const fill = document.createElementNS(svgNs, "path");
    fill.setAttribute("class", "vf");
    fill.setAttribute("d", `M${inset.toFixed(2)} ${y.toFixed(2)} L4.6 ${bottom} Q4.7 21 5.6 21 H12.4 Q13.3 21 13.4 ${bottom} L${(18 - inset).toFixed(2)} ${y.toFixed(2)} Z`);
    svg.append(fill);
  }
  for (const d of ["M2.1 3 L4.6 20.2 Q4.8 21 5.6 21 H12.4 Q13.2 21 13.4 20.2 L15.9 3", "M1 3 H17"]) {
    const path = document.createElementNS(svgNs, "path");
    path.setAttribute("class", "vl");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function grip(): HTMLElement {
  const span = el("span", { class: "grip", "data-grip": "", "aria-hidden": "true" });
  span.append(icon("grip"));
  return span;
}

const appendAll = (parent: HTMLElement, ...children: (Node | null)[]) => parent.append(...children.filter((child): child is Node => child !== null));
const dot = (colour: string) => withVars(el("span", { class: "dot", "aria-hidden": "true" }), { "--c": `var(--b-${colour})` });

function archivedDay(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

function target(bucket: BucketMonth): Node[] {
  if (bucket.type === "recurring" && bucket.amount !== null) {
    const amount = `${formatMoney(bucket.amount, { symbol: true })} a month`;
    // Exactly met: just the target. Short of it or above it: both figures.
    const text = bucket.assigned === bucket.amount ? el("span", { class: "num" }, amount)
      : el("span", { class: "num" }, el("span", { class: "fund" }, formatMoney(bucket.assigned, { symbol: true })), ` of ${amount}`);
    return [vessel(bucket.assigned, bucket.amount), text];
  }
  if (bucket.type === "goal" && bucket.amount !== null && bucket.goalMonth) {
    const share = Math.max(0, Math.min(1, bucket.available / bucket.amount));
    const percent = Math.floor(share * 100);
    const goal = formatMoney(bucket.amount, { symbol: true });
    const when = monthLabel(bucket.goalMonth);
    return [
      el("span", { class: "goal" },
        withVars(el("span", { class: "bar", role: "img", "aria-label": `${percent}% saved toward a ${goal} goal` }), { "--c": `var(--b-${bucket.colour})`, "--p": `${(share * 100).toFixed(1)}%` }),
        el("span", { class: "pct num" }, `${percent}%`),
        el("span", { class: "gmeta num" }, `of ${goal}`, el("span", { class: "when" }, " ", el("span", { class: "sep" }, "·"), ` ${when}`))),
      el("span", { class: "goal-date num" }, `By ${when}`),
    ];
  }
  return [el("span", { class: "sr-only" }, "No target")];
}

/**
 * The month's summary strip (ADR-0003): Ready to assign, largest, with small cents, violet or the overspent red
 * when negative; Make it rain beside it (absent for past months); then the month's Income, Assigned and Spent.
 */
function renderSummary(summary: MonthSummary, rain: HTMLElement | null): HTMLElement {
  const ready = formatMoney(summary.readyToAssign, { symbol: true });
  const dot = ready.lastIndexOf(".");
  const stat = (name: string, label: string, cents: number) => el("div", { class: "stat" },
    el("span", { class: "label" }, icon(name, "sm"), label), el("span", { class: "figure num" }, formatMoney(cents, { symbol: true })));
  return el("section", { class: "card summary", "aria-label": "Month summary" },
    el("div", { class: `ready${summary.readyToAssign < 0 ? " neg" : ""}` },
      el("div", {},
        el("div", { class: "ready-label", id: "ready-label" }, icon("drop", "sm"), "Ready to assign"),
        el("div", { class: "ready-figure num", "aria-labelledby": "ready-label" }, ready.slice(0, dot), el("span", { class: "cents" }, ready.slice(dot)))),
      rain,
      el("div", { class: "rain-layer", "aria-hidden": "true" })),
    stat("in", "Income", summary.income),
    stat("assign", "Assigned", summary.assigned),
    stat("receipt", "Spent", summary.spent));
}

export function createBucketsPage(ctx: BucketsContext) {
  const { client, budget } = ctx;
  const note = el("div", { class: "note", role: "alert" });
  const actions = el("div", { class: "head-actions" });
  const content = el("div", { class: "buckets-content" });
  const strip = el("div", { class: "summary-wrap" });
  const menu = el("div", { class: "gmenu", role: "menu", hidden: true });
  const root = el("div", { class: "page" }, el("div", { class: "page-row" }, el("h1", {}, "Buckets"), ctx.monthHeader, actions), strip, note, content, menu);

  let table: BucketTable = { groups: [], buckets: [] };
  let month: BucketMonthView = { summary: { month: "", readyToAssign: 0, income: 0, assigned: 0, spent: 0 }, groups: [], buckets: [] };
  let reordering = false;
  let renaming: { groupId: string; draft: string; error: string } | null = null;
  let archivedOpen = false;
  let movedKey: string | null = null;
  let busy = false;
  let menuFor: { group: BucketGroup; button: HTMLButtonElement } | null = null;
  pageListeners?.abort();
  pageListeners = new AbortController();
  const { signal } = pageListeners;

  const activeIn = (groupId: string) => table.buckets.filter((bucket) => !bucket.archived && bucket.groupId === groupId);
  const layout = (): Layout => layoutOf(table);
  const find = (selector: string) => root.querySelector<HTMLElement>(selector);
  const attr = (value: string) => CSS.escape(value);

  function focusKey(key: MoveKey, dir: -1 | 1 = -1): void {
    if (reordering) {
      const buttons = [...root.querySelectorAll<HTMLElement>(`.mv[data-kind="${key.kind}"][data-id="${attr(key.id)}"]`)];
      (buttons.find((button) => button.dataset.dir === String(dir) && button.getAttribute("aria-disabled") !== "true") ?? buttons.find((button) => button.getAttribute("aria-disabled") !== "true") ?? buttons[0])?.focus();
      return;
    }
    find(key.kind === "group" ? `.more-btn[data-group-id="${attr(key.id)}"]` : `.name-btn[data-bucket-id="${attr(key.id)}"]`)?.focus();
  }

  /**
   * Redraws after a write that has saved. Never throws: if the table cannot be read, the page keeps what
   * it last showed and says the change was saved. Returns whether the table was redrawn.
   */
  async function refresh(focusBucketId?: string): Promise<boolean> {
    let next: BucketsData;
    try {
      next = await ctx.reload();
    } catch {
      if (root.isConnected) setNote(note, "Your change was saved, but the buckets could not refresh. Reload to try again.");
      return false;
    }
    render(next);
    setNote(note, null);
    if (focusBucketId) focusKey({ kind: "bucket", id: focusBucketId });
    return true;
  }

  const dialogContext = { client, budget, table: () => table, refresh, snack: ctx.snack };
  const addButtonFocus = () => find("[data-add]") ?? find("h1");

  function openAdd(groupId?: string, opener?: HTMLElement): void {
    closeMenu(false);
    openBucketDialog(dialogContext, { ...(groupId ? { groupId } : {}), returnFocus: () => (opener?.isConnected ? opener : addButtonFocus()) });
  }

  function openEdit(id: string): void {
    // The dialog works on the bucket as it is now (its Available this month), whatever month is shown.
    const bucket = table.buckets.find((candidate) => candidate.id === id);
    if (!bucket) return;
    closeMenu(false);
    openBucketDialog(dialogContext, { bucket, returnFocus: () => find(`.name-btn[data-bucket-id="${attr(bucket.id)}"]`) ?? addButtonFocus() });
  }

  // ----- Moves -----
  function positionMessage(key: MoveKey): string {
    const where = locate(layout(), key);
    if (key.kind === "group") return `${table.groups[where!.index]!.name} group moved to position ${where!.index + 1} of ${table.groups.length}.`;
    const bucket = table.buckets.find((b) => b.id === key.id)!;
    const group = table.groups.find((g) => g.id === where?.groupId);
    return `${bucket.name} moved to ${group?.name ?? ""}, position ${(where?.index ?? 0) + 1} of ${activeIn(group?.id ?? "").length}.`;
  }

  const nameOf = (key: MoveKey) => key.kind === "group"
    ? table.groups.find((group) => group.id === key.id)?.name ?? ""
    : table.buckets.find((bucket) => bucket.id === key.id)?.name ?? "";
  const groupName = (id: string | undefined) => table.groups.find((group) => group.id === id)?.name ?? "";

  async function send(key: MoveKey, to: MoveTarget): Promise<void> {
    if (key.kind === "group") await client.moveGroup(key.id, { index: to.index });
    else await client.moveBucket(key.id, { groupId: to.groupId!, index: to.index });
  }

  async function move(key: MoveKey, to: MoveTarget, dir: -1 | 1): Promise<void> {
    if (busy) return;
    busy = true;
    closeMenu(false);
    const from = locate(layout(), key);
    const name = nameOf(key);
    try {
      if (!from) return;
      try {
        await send(key, to);
      } catch (error) {
        // Nothing moved. Show the table as the server has it now (the target may be gone), keeping the message.
        const message = messageOf(error);
        await ctx.reload().then(render, () => undefined);
        setNote(note, message);
        focusKey(key, dir);
        return;
      }
      movedKey = `${key.kind}:${key.id}`;
      const redrawn = await refresh();
      focusKey(key, dir);
      const upDown = dir < 0 ? "up" : "down";
      const message = key.kind === "group" ? `Moved the ${name} group ${upDown}.`
        : from.groupId === to.groupId ? `Moved ${name} ${upDown}.` : `Moved ${name} to ${groupName(to.groupId)}.`;
      ctx.snack(message, async () => {
        const now = locate(layoutOf((await ctx.reload()).table), key);
        if (!now || now.index !== to.index || now.groupId !== to.groupId) throw new Error(`${name} has moved since, so the move was not undone.`);
        await send(key, from);
        movedKey = `${key.kind}:${key.id}`;
        const back = await refresh();
        focusKey(key, dir < 0 ? 1 : -1);
        ctx.announce(back ? positionMessage(key) : `Moved ${name} back.`);
      });
      // After the snackbar, so the position is what the live region ends up saying. A table that could not
      // be re-read does not know the new position.
      ctx.announce(redrawn ? positionMessage(key) : message);
    } catch (error) {
      setNote(note, messageOf(error));
    } finally {
      busy = false;
    }
  }

  const reorder = attachReorder(content, {
    layout,
    move: (key, to, dir) => void move(key, to, dir),
    atEdge: (key, dir) => ctx.announce(`${key.kind === "group" ? `${nameOf(key)} group` : nameOf(key)} is already ${dir < 0 ? "first" : "last"}.`),
    dragStarted: () => closeMenu(false),
  });

  // ----- Group menu -----
  function closeMenu(refocus: boolean): void {
    if (!menuFor) return;
    const { button } = menuFor;
    menu.hidden = true;
    menuFor = null;
    button.setAttribute("aria-expanded", "false");
    if (refocus && button.isConnected) button.focus();
  }

  function openMenu(group: BucketGroup, button: HTMLButtonElement): void {
    closeMenu(false);
    const items: [string, string, () => void][] = [
      ["plus", `Add bucket to ${group.name}`, () => openAdd(group.id, button)],
      ["pencil", "Rename group", () => startRename(group)],
    ];
    if (activeIn(group.id).length === 0) items.push(["trash", "Delete group", () => void deleteGroup(group)]);
    menu.setAttribute("aria-label", `${group.name} group`);
    menu.replaceChildren(...items.map(([glyph, text, run]) => {
      const item = el("button", { type: "button", role: "menuitem", tabindex: "-1" }, icon(glyph), el("span", {}, text));
      item.addEventListener("click", () => {
        closeMenu(false);
        run();
      });
      return item;
    }));
    menu.hidden = false;
    menuFor = { group, button };
    placeMenu();
    button.setAttribute("aria-expanded", "true");
    menu.querySelector("button")?.focus();
  }

  /** Keeps the menu beside its button, flipping above it when there is no room below. */
  function placeMenu(): void {
    if (!menuFor) return;
    const box = menuFor.button.getBoundingClientRect();
    if (box.bottom < 0 || box.top > window.innerHeight) return closeMenu(false);
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const top = box.bottom + 4 + height <= window.innerHeight - 12 ? box.bottom + 4 : box.top - height - 4;
    menu.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`;
    menu.style.top = `${Math.max(12, Math.min(top, window.innerHeight - height - 12))}px`;
  }

  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") items[(index + 1) % items.length]?.focus();
    else if (event.key === "ArrowUp") items[(index - 1 + items.length) % items.length]?.focus();
    else if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items.at(-1)?.focus();
    else if (event.key === "Escape") closeMenu(true);
    else if (event.key === "Tab") { closeMenu(true); return; }
    else return;
    event.preventDefault();
  });
  document.addEventListener("pointerdown", (event) => {
    if (menuFor && event.target instanceof Element && !menu.contains(event.target) && !event.target.closest(".more-btn")) closeMenu(false);
  }, { signal });
  window.addEventListener("resize", () => closeMenu(false), { signal });
  window.addEventListener("scroll", placeMenu, { passive: true, signal });

  async function deleteGroup(group: BucketGroup): Promise<void> {
    const index = table.groups.findIndex((g) => g.id === group.id);
    try {
      await client.deleteGroup(group.id);
      await refresh();
      const next = table.groups[Math.min(index, table.groups.length - 1)];
      if (next) focusKey({ kind: "group", id: next.id });
      else addButtonFocus()?.focus();
      ctx.announce(`Deleted the ${group.name} group.`);
    } catch (error) {
      setNote(note, messageOf(error));
    }
  }

  // ----- Rename in the row -----
  function startRename(group: BucketGroup): void {
    renaming = { groupId: group.id, draft: group.name, error: "" };
    render({ table, month });
    const input = find(".rn input") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }

  function cancelRename(): void {
    const id = renaming?.groupId;
    renaming = null;
    render({ table, month });
    if (id) focusKey({ kind: "group", id });
  }

  async function commitRename(): Promise<void> {
    if (!renaming || busy) return;
    const { groupId, draft } = renaming;
    const group = table.groups.find((g) => g.id === groupId);
    if (!group) return cancelRename();
    if (draft.trim() === group.name) return cancelRename();
    busy = true;
    try {
      const saved = await client.renameGroup(groupId, { name: draft });
      renaming = null;
      // The rename saved either way; without a fresh table, show the saved name in the one we have.
      if (!(await refresh())) render({ table: { ...table, groups: table.groups.map((g) => (g.id === groupId ? saved : g)) }, month });
      focusKey({ kind: "group", id: groupId });
      ctx.snack(`Renamed ${group.name} to ${saved.name}.`, async () => {
        const current = (await ctx.reload()).table.groups.find((g) => g.id === groupId);
        if (!current) throw new Error("That group was deleted, so the rename was not undone.");
        if (current.name !== saved.name) throw new Error(`${saved.name} has been renamed since, so the rename was not undone.`);
        await client.renameGroup(groupId, { name: group.name });
        await refresh();
        focusKey({ kind: "group", id: groupId });
      });
    } catch (error) {
      if (renaming) {
        renaming.error = messageOf(error);
        render({ table, month });
        (find(".rn input") as HTMLInputElement | null)?.focus();
      }
    } finally {
      busy = false;
    }
  }

  function renameCell(): HTMLElement {
    const state = renaming!;
    const input = textInput(uid("rn"), state.draft);
    const errorId = uid("rn-err");
    if (state.error) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorId);
    }
    input.addEventListener("input", () => { state.draft = input.value; });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename(); }
    });
    const save = el("button", { class: "mv", type: "button", "aria-label": "Save group name" }, icon("check"));
    save.addEventListener("click", () => void commitRename());
    const cancel = el("button", { class: "mv", type: "button", "aria-label": "Cancel" }, icon("x"));
    cancel.addEventListener("click", cancelRename);
    const label = el("label", { class: "sr-only", for: input.id }, "Group name");
    const error = state.error ? el("span", { class: "rn-err", id: errorId, role: "alert" }, icon("alert", "sm"), el("span", {}, state.error)) : null;
    return el("div", { class: "c gcell", role: "rowheader" }, el("div", { class: "rn" }, label, input, save, cancel, error));
  }

  // ----- Restore -----
  async function restore(bucket: Bucket, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await client.restoreBucket(bucket.id);
      await refresh();
      (find(".archived li button") ?? find(".archived summary") ?? find(`.name-btn[data-bucket-id="${attr(bucket.id)}"]`))?.focus();
      ctx.announce(`Restored ${bucket.name}.`);
    } catch (error) {
      button.disabled = false;
      setNote(note, messageOf(error));
    }
  }

  // ----- Rendering -----
  function moveButtons(kind: "group" | "bucket", id: string, label: string, first: boolean, last: boolean): HTMLElement {
    const button = (dir: -1 | 1, disabled: boolean) => {
      const b = el("button", {
        class: "mv", type: "button", "data-kind": kind, "data-id": id, "data-dir": String(dir),
        "aria-label": `Move ${label} ${dir < 0 ? "up" : "down"}`, "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
        ...(disabled ? { "aria-disabled": "true" } : {}),
      }, icon(dir < 0 ? "up" : "dn"));
      return b;
    };
    return el("div", { class: "c ctl", role: "cell" }, button(-1, first), button(1, last));
  }

  function groupRow(group: BucketGroup, totals: GroupMonth | undefined, index: number): HTMLElement {
    const buckets = activeIn(group.id);
    const isRenaming = renaming?.groupId === group.id && !reordering;
    const row = el("div", { class: `bgroup${isRenaming ? " renaming" : ""}${movedKey === `group:${group.id}` ? " moved" : ""}`, role: "row", "data-group-id": group.id });
    if (isRenaming) row.append(renameCell());
    else {
      const more = reordering ? null : el("button", {
        class: "more-btn", type: "button", "data-group-id": group.id, "aria-haspopup": "menu", "aria-expanded": "false",
        "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown", "aria-label": `${group.name} group actions`,
      }, icon("more"));
      more?.addEventListener("click", () => {
        if (menuFor?.group.id === group.id) closeMenu(true);
        else openMenu(group, more);
      });
      row.append(el("div", { class: "c gcell", role: "rowheader" }, grip(), el("span", { class: "gname" }, group.name), el("span", { class: "gcount" }, String(buckets.length)), more));
    }
    appendAll(row,
      el("div", { class: "c det", role: "cell" }),
      el("div", { class: "c num spent", role: "cell" }, formatMoney(totals?.spent ?? 0)),
      el("div", { class: "c num avail", role: "cell" }, formatMoney(totals?.available ?? 0)),
      reordering ? moveButtons("group", group.id, `${group.name} group`, index === 0, index === table.groups.length - 1) : null,
      el("div", { class: "c go", "aria-hidden": "true" }));
    return row;
  }

  function figures(bucket: BucketMonth): HTMLElement[] {
    const over = bucket.available < 0;
    return [
      el("div", { class: "c det", role: "cell" }, ...target(bucket)),
      el("div", { class: "c num spent", role: "cell" }, formatMoney(bucket.spent)),
      el("div", { class: "c num avail", role: "cell" }, formatMoney(bucket.available), over ? el("span", { class: "sr-only" }, " overspent") : null),
    ];
  }

  const rowClass = (bucket: BucketMonth) => `brow${bucket.type === "goal" ? " is-goal" : bucket.type === "plain" ? " is-plain" : ""}${bucket.available < 0 ? " is-over" : ""}`;

  function bucketRow(bucket: BucketMonth, first: boolean, last: boolean): HTMLElement {
    const row = el("div", { class: `${rowClass(bucket)}${movedKey === `bucket:${bucket.id}` ? " moved" : ""}`, role: "row", "data-bucket-id": bucket.id });
    let label: HTMLElement;
    if (reordering) label = el("span", { class: "name" }, bucket.name);
    else {
      label = el("button", {
        class: "name-btn", type: "button", "data-bucket-id": bucket.id, "aria-haspopup": "dialog",
        "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown", "aria-label": `Edit ${bucket.name}`,
      }, el("span", { class: "name" }, bucket.name));
      label.addEventListener("click", () => openEdit(bucket.id));
    }
    appendAll(row,
      el("div", { class: "c bname", role: "rowheader" }, grip(), dot(bucket.colour), label),
      ...figures(bucket),
      reordering ? moveButtons("bucket", bucket.id, bucket.name, first, last) : null,
      el("div", { class: "c go", "aria-hidden": "true" }, reordering ? null : icon("right", "sm")));
    return row;
  }

  /** An archived bucket with activity this month: shown for its figures, but it can't be edited or moved. */
  function archivedRow(bucket: BucketMonth): HTMLElement {
    const row = el("div", { class: `${rowClass(bucket)} is-archived`, role: "row" });
    appendAll(row,
      el("div", { class: "c bname", role: "rowheader" }, el("span", { class: "grip-space", "aria-hidden": "true" }), dot(bucket.colour),
        el("span", { class: "name" }, bucket.name), el("span", { class: "tag" }, "Archived")),
      ...figures(bucket),
      reordering ? el("div", { class: "c ctl", role: "cell" }) : null,
      el("div", { class: "c go", "aria-hidden": "true" }));
    return row;
  }

  function renderTable(): HTMLElement {
    const grid = el("div", { class: `card btable${reordering ? " reordering" : ""}`, role: "table", "aria-label": "Buckets" },
      el("div", { class: "bhead", role: "row" },
        el("div", { class: "c", role: "columnheader" }, "Bucket"),
        el("div", { class: "c det", role: "columnheader" }, "Target or goal"),
        el("div", { class: "c num spent", role: "columnheader" }, "Spent"),
        el("div", { class: "c num avail", role: "columnheader" }, "Available"),
        reordering ? el("div", { class: "c ctl", role: "columnheader" }, el("span", { class: "sr-only" }, "Move")) : null,
        el("div", { class: "c go", "aria-hidden": "true" })));
    const groups = table.groups;
    const shown = new Map(month.buckets.map((bucket) => [bucket.id, bucket]));
    const archivedIn = (groupId: string | null) => month.buckets.filter((bucket) => bucket.archived && bucket.groupId === groupId);
    groups.forEach((group, groupIndex) => {
      grid.append(groupRow(group, month.groups.find((totals) => totals.id === group.id), groupIndex));
      const buckets = activeIn(group.id).map((bucket) => shown.get(bucket.id)).filter((bucket): bucket is BucketMonth => bucket !== undefined);
      const archived = archivedIn(group.id);
      if (!buckets.length && !archived.length) {
        grid.append(el("div", { class: "bempty", role: "row", "data-group-id": group.id },
          el("div", { class: "c", role: "cell" }, "No buckets"),
          el("div", { class: "c det", role: "cell" }),
          el("div", { class: "c spent", role: "cell" }),
          el("div", { class: "c avail", role: "cell" }),
          reordering ? el("div", { class: "c ctl", role: "cell" }) : null,
          el("div", { class: "c go", "aria-hidden": "true" })));
      }
      buckets.forEach((bucket, index) => grid.append(bucketRow(bucket,
        groupIndex === 0 && index === 0,
        groupIndex === groups.length - 1 && index === buckets.length - 1)));
      grid.append(...archived.map(archivedRow));
    });
    // An archived bucket whose group was deleted still shows its month, after every group.
    grid.append(...archivedIn(null).map(archivedRow));
    return grid;
  }

  function renderArchived(archived: Bucket[]): HTMLElement {
    const list = el("ul", {}, ...archived.map((bucket) => {
      const button = el("button", { class: "btn btn-quiet", type: "button", "aria-label": `Restore ${bucket.name}` }, "Restore");
      button.addEventListener("click", () => void restore(bucket, button));
      const group = table.groups.find((g) => g.id === bucket.groupId);
      const meta = [group?.name, `Archived ${archivedDay(bucket.archivedAt)}`].filter(Boolean).join(" · ");
      return el("li", {}, dot(bucket.colour), el("span", { class: "an" }, el("strong", {}, bucket.name), el("small", {}, meta)), button);
    }));
    const details = el("details", { class: "archived", open: archivedOpen },
      el("summary", {}, `Archived buckets · ${archived.length}`, icon("down", "sm")), el("div", { class: "card" }, list));
    details.addEventListener("toggle", () => { archivedOpen = details.open; });
    return details;
  }

  function renderActions(empty: boolean): void {
    if (empty) {
      actions.replaceChildren();
      return;
    }
    if (reordering) {
      const done = el("button", { class: "btn btn-primary", type: "button", "aria-pressed": "true", "data-reorder": "" }, "Done");
      done.addEventListener("click", () => setReordering(false));
      actions.replaceChildren(done);
      return;
    }
    const toggle = el("button", { class: "icon-btn reorder-btn", type: "button", "aria-pressed": "false", "aria-label": "Reorder", "data-reorder": "" }, icon("updown"));
    toggle.addEventListener("click", () => setReordering(true));
    const add = el("button", { class: "btn btn-secondary", type: "button", "data-add": "" }, icon("plus"), "Add bucket");
    add.addEventListener("click", () => openAdd(undefined, add));
    actions.replaceChildren(toggle, add);
  }

  function setReordering(on: boolean): void {
    reordering = on;
    renaming = null;
    closeMenu(false);
    reorder.cancel();
    render({ table, month });
    find("[data-reorder]")?.focus();
  }

  phone.addEventListener("change", () => {
    reorder.cancel();
    if (!phone.matches && reordering) {
      reordering = false;
      render({ table, month });
    }
  }, { signal });

  function openRain(): void {
    closeMenu(false);
    void openRainPreview({
      client, budget, month: month.summary.month, readyToAssign: month.summary.readyToAssign, buckets: month.buckets,
      refresh: () => refresh(), snack: ctx.snack,
      returnFocus: () => find(".btn-rain") ?? find("h1"),
      layer: () => find(".rain-layer"),
    }, (error) => setNote(note, messageOf(error)));
  }

  function render(next: BucketsData): void {
    table = next.table;
    month = next.month;
    closeMenu(false);
    if (!phone.matches) reordering = false;
    const active = table.buckets.filter((bucket) => !bucket.archived);
    const archived = table.buckets.filter((bucket) => bucket.archived)
      .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
    if (!archived.length) archivedOpen = false;
    const empty = table.groups.length === 0 && active.length === 0;
    if (empty) reordering = false;
    renderActions(empty);
    let main: HTMLElement;
    if (empty) {
      const add = el("button", { class: "btn btn-primary", type: "button", "data-add": "" }, icon("plus"), "Add bucket");
      add.addEventListener("click", () => openAdd(undefined, add));
      const big = icon("bucket");
      big.classList.add("big");
      main = el("div", { class: "bempty-state" }, big, el("strong", {}, "No buckets yet"), add);
    } else {
      main = renderTable();
    }
    strip.replaceChildren(renderSummary(month.summary, month.summary.month >= ctx.thisMonth ? rainButton(openRain) : null));
    content.replaceChildren(main, ...(archived.length ? [renderArchived(archived)] : []));
    movedKey = null;
  }

  return {
    root,
    render,
  };
}

function layoutOf(table: BucketTable): Layout {
  return {
    groups: table.groups.map((group) => ({
      id: group.id,
      bucketIds: table.buckets.filter((bucket) => !bucket.archived && bucket.groupId === group.id).map((bucket) => bucket.id),
    })),
  };
}
