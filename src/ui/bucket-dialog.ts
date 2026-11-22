// The Add and Edit bucket dialog: name, group, colour, type and its amounts, and (in Edit) Archive.
// Rules (type shapes, goal months, name clashes, archiving) are checked by the server; this module only
// turns what was typed into cents, offers goal months from this month on, and shows the server's message
// beside the right field.
import { ApiError } from "../client.js";
import type { createClient } from "../client.js";
import { BUCKET_COLOURS, leastUsedColour } from "../core/colours.js";
import type { BucketColour } from "../core/colours.js";
import type { Bucket, BucketEditInput, BucketTable, BucketType, Budget, NewBucketInput } from "../core/index.js";
import { addMonths } from "../core/months.js";
import { formatMoney, parseMoney } from "../core/money.js";
import { el, icon, withVars } from "./dom.js";
import { attachMonthPicker, shortMonthLabel } from "./month-picker.js";
import { dropdown, field, FieldError, moneyInput, openSheet, segmented, swatches, textInput, uid } from "./sheet.js";
import type { Sheet } from "./sheet.js";

export interface BucketDialogContext {
  client: ReturnType<typeof createClient>;
  budget: Budget;
  /** The server's current month, "YYYY-MM": the earliest goal month on offer. */
  thisMonth: string;
  /** The table as last loaded. */
  table(): BucketTable;
  /**
   * Reloads and redraws the page after a write that saved, then focuses the given bucket's row (or keeps
   * focus where it is). Never throws: a failed reload leaves a "saved, but could not refresh" note.
   */
  refresh(focusBucketId?: string): Promise<boolean>;
  snack(message: string, undo: () => Promise<void>): void;
}

const hueNames: Record<BucketColour, string> = {
  sky: "Sky", denim: "Denim", blue: "Blue", slate: "Slate", teal: "Teal", mint: "Mint", green: "Green", forest: "Forest",
  lime: "Lime", olive: "Olive", sun: "Sun", cocoa: "Cocoa", peach: "Peach", tangerine: "Tangerine", rose: "Rose", plum: "Plum",
};

const typeOptions = [["recurring", "Recurring"], ["goal", "Dated goal"], ["plain", "Plain"]] as const;

/** "2027-08" -> "Aug 2027". */
export const monthLabel = shortMonthLabel;

/** A new goal is due a year from this month until another month is picked. */
const DEFAULT_GOAL_MONTHS = 12;

const dot = (colour: string) => withVars(el("span", { class: "dot", "aria-hidden": "true" }), { "--c": `var(--b-${colour})` });

export function openBucketDialog(ctx: BucketDialogContext, options: { bucket?: Bucket; groupId?: string; returnFocus: () => HTMLElement | null }): void {
  const { client, budget } = ctx;
  const existing = options.bucket;
  const table = ctx.table();
  const active = table.buckets.filter((bucket) => !bucket.archived);

  const name = field("Name", (id) => textInput(id, existing?.name ?? ""));
  const nameInput = name.root.querySelector("input") as HTMLInputElement;

  const group = dropdown({
    label: "Group",
    options: table.groups.map((g) => ({ value: g.id, label: g.name })),
    value: existing?.groupId ?? options.groupId ?? null,
    newItem: "New group",
    newLabel: "New group name",
    backLabel: "Choose existing",
  });

  const titleDot = dot(existing?.colour ?? "slate");
  const colour = swatches({
    label: "Colour",
    options: BUCKET_COLOURS.map((value) => ({ value, name: hueNames[value] })),
    value: existing?.colour ?? leastUsedColour(active),
    columns: 8,
    onChange: (value) => titleDot.style.setProperty("--c", `var(--b-${value})`),
  });
  titleDot.style.setProperty("--c", `var(--b-${colour.value()})`);

  // Each type keeps its own draft amount, so switching back and forth loses nothing.
  const drafts: Record<"recurring" | "goal", string> = {
    recurring: existing?.type === "recurring" && existing.amount !== null ? formatMoney(existing.amount) : "",
    goal: existing?.type === "goal" && existing.amount !== null ? formatMoney(existing.amount) : "",
  };
  let shownType: BucketType = existing?.type ?? "recurring";
  const amount = field("Amount per month", (id) => moneyInput(id, "").wrap);
  const amountInput = amount.root.querySelector("input") as HTMLInputElement;
  const by = goalMonthField(existing?.goalMonth ?? addMonths(ctx.thisMonth, DEFAULT_GOAL_MONTHS), ctx.thisMonth);
  const details = el("div", { class: "two details" }, amount.root, by.root);
  const showType = (next: BucketType, save = true) => {
    if (save && shownType !== "plain") drafts[shownType] = amountInput.value;
    shownType = next;
    details.hidden = next === "plain";
    by.root.hidden = next !== "goal";
    if (next !== "plain") {
      amount.label.textContent = next === "goal" ? "Goal amount" : "Amount per month";
      amountInput.value = drafts[next];
    }
  };
  const type = segmented<BucketType>("Type", typeOptions, shownType, { onChange: (next) => showType(next) });
  const typeLabel = uid("type-label");
  type.root.setAttribute("aria-labelledby", typeLabel);
  type.root.removeAttribute("aria-label");
  const typeField = el("div", { class: "field" }, el("span", { class: "flabel", id: typeLabel }, "Type"), type.root);
  showType(shownType, false);

  // Tidy what was typed when leaving a field; leave anything unreadable for the save to report.
  amountInput.addEventListener("blur", () => {
    try {
      const cents = parseMoney(amountInput.value);
      if (cents > 0) amountInput.value = formatMoney(cents);
    } catch {
      // Reported on save.
    }
  });

  function readAmount(): number | null {
    if (amountInput.value.trim() === "") return null;
    try {
      return parseMoney(amountInput.value);
    } catch (error) {
      throw new FieldError((error as Error).message, amountInput);
    }
  }
  /** Type, amount and month as the server takes them for the chosen type. */
  function shape(): { type: BucketType; amount?: number | null; goalMonth?: string | null } {
    const chosen = type.value();
    if (chosen === "plain") return { type: chosen };
    if (chosen === "recurring") return { type: chosen, amount: readAmount() };
    return { type: chosen, amount: readAmount(), goalMonth: by.value() };
  }
  function groupChoice(): { groupId: string } | { newGroupName: string } {
    const value = group.value();
    return value.kind === "existing" ? { groupId: value.value } : { newGroupName: value.name };
  }

  const fieldFor = (error: unknown) => {
    switch (error instanceof ApiError ? error.field : undefined) {
      case "name": return nameInput;
      case "group": return group.control();
      case "amount": return amountInput;
      case "month": return by.button;
      default: return null;
    }
  };

  const fields = [name.root, group.root, colour.root, typeField, details];

  if (!existing) {
    let createdId: string | null = null;
    openSheet({
      title: "Add bucket",
      titleStart: titleDot,
      anchor: "top",
      submitLabel: "Add bucket",
      // After adding, focus goes to the new row rather than back to the opener.
      returnFocus: () => (createdId ? rowButton(createdId) : null) ?? options.returnFocus(),
      fieldFor,
      body: () => fields,
      submit: async () => {
        const input: NewBucketInput = { name: nameInput.value, ...groupChoice(), colour: colour.value() as BucketColour, ...shape() };
        const created = await client.createBucket(budget.id, input);
        createdId = created.id;
        await ctx.refresh(created.id);
      },
    });
    return;
  }

  const bucket = existing;
  openSheet({
    title: `Edit ${bucket.name}`,
    titleStart: titleDot,
    anchor: "top",
    submitLabel: "Save",
    returnFocus: options.returnFocus,
    fieldFor,
    body: (sheet) => [...fields, archiveSection(sheet)],
    submit: async () => {
      const changes: BucketEditInput = {};
      if (nameInput.value.trim() !== bucket.name) changes.name = nameInput.value;
      const choice = groupChoice();
      if (!("groupId" in choice) || choice.groupId !== bucket.groupId) Object.assign(changes, choice);
      if (colour.value() !== bucket.colour) changes.colour = colour.value() as BucketColour;
      const next = shape();
      if (next.type !== bucket.type) Object.assign(changes, next);
      else {
        if (next.amount !== undefined && next.amount !== bucket.amount) changes.amount = next.amount;
        if (next.goalMonth !== undefined && next.goalMonth !== bucket.goalMonth) changes.goalMonth = next.goalMonth;
      }
      if (Object.keys(changes).length === 0) return;
      const before = locateBucket(ctx.table(), bucket.id);
      const saved = await client.editBucket(bucket.id, changes);
      await ctx.refresh(bucket.id);
      ctx.snack(`Saved ${saved.name}.`, () => undoEdit(ctx, bucket, saved, changes, before));
    },
  });

  function archiveSection(sheet: Sheet): HTMLElement {
    const section = el("div", { class: "arch" }, el("span", { class: "flabel" }, "Archive"));
    const available = bucket.available;
    if (available < 0) {
      const whyId = uid("why");
      section.append(el("div", { class: "close-row" },
        el("button", { class: "btn btn-danger wrap", type: "button", disabled: true, "aria-describedby": whyId }, `Archive ${bucket.name}`),
        el("span", { class: "why", id: whyId }, "Can’t archive while Available is ", el("span", { class: "over num" }, formatMoney(available)))));
      return section;
    }
    if (available > 0) {
      section.append(el("div", { class: "arch-prev num" },
        el("div", {}, dot(bucket.colour), el("span", { class: "ap-n", title: bucket.name }, bucket.name),
          el("span", { class: "ap-v" }, `${formatMoney(available)} → `, el("strong", {}, formatMoney(0)))),
        el("div", {}, withVars(el("span", { class: "dot ring", "aria-hidden": "true" }), { "--c": "var(--unassigned)" }), el("span", { class: "ap-n" }, "Ready to assign"),
          el("span", { class: "ap-v" }, el("strong", {}, `+${formatMoney(available)}`)))));
    }
    const label = available > 0 ? `Archive and return ${formatMoney(available, { symbol: true })}` : `Archive ${bucket.name}`;
    const button = el("button", { class: "btn btn-danger wrap", type: "button" }, label);
    button.addEventListener("click", () => void sheet.run(async () => {
      const place = locateBucket(ctx.table(), bucket.id);
      const { returned } = await client.archiveBucket(bucket.id);
      await ctx.refresh();
      // Undo restores (which appends to its group), then moves the bucket back to where it was.
      ctx.snack(returned > 0 ? `Archived ${bucket.name} and returned ${formatMoney(returned, { symbol: true })}.` : `Archived ${bucket.name}.`, async () => {
        await client.restoreBucket(bucket.id);
        // Back to its old place if that group still exists (the table here may be stale, so the server decides).
        if (place) {
          try {
            await client.moveBucket(bucket.id, place);
          } catch (error) {
            if (!(error instanceof ApiError && error.code === "not_found")) throw error;
          }
        }
        await ctx.refresh(bucket.id);
      });
    }));
    section.append(button);
    return section;
  }
}

/**
 * The goal's "By" month: a button that looks like the other inputs, showing "Aug 2027", and opens the month picker.
 * Months before this month are disabled; the saved month stays pickable even once it has passed.
 */
function goalMonthField(initial: string, thisMonth: string): { root: HTMLDivElement; button: HTMLButtonElement; value(): string } {
  let month = initial;
  const labelId = uid("by-label");
  const valueId = uid("by-value");
  const valueText = el("span", { class: "sv", id: valueId }, monthLabel(month));
  const button = el("button", { class: "input select-btn", type: "button", "aria-labelledby": `${labelId} ${valueId}` }, valueText, icon("down", "sm"));
  const root = el("div", { class: "field" }, el("span", { class: "flabel", id: labelId }, "By"), button);
  attachMonthPicker({
    trigger: button,
    root,
    value: () => month,
    first: thisMonth,
    last: "9999-12",
    float: true,
    choose(next) {
      month = next;
      valueText.textContent = monthLabel(month);
      button.focus();
      root.dispatchEvent(new Event("input", { bubbles: true }));
    },
  });
  return { root, button, value: () => month };
}

const rowButton = (id: string) => document.querySelector<HTMLElement>(`.name-btn[data-bucket-id="${CSS.escape(id)}"]`);

export function locateBucket(table: BucketTable, id: string): { groupId: string; index: number } | null {
  const bucket = table.buckets.find((b) => b.id === id && !b.archived);
  if (!bucket?.groupId) return null;
  const index = table.buckets.filter((b) => !b.archived && b.groupId === bucket.groupId).findIndex((b) => b.id === id);
  return { groupId: bucket.groupId, index };
}

/** Puts back the fields an edit changed. Core refuses (bucket_changed) if the bucket has changed since. */
async function undoEdit(ctx: BucketDialogContext, before: Bucket, saved: Bucket, changes: BucketEditInput, place: { groupId: string; index: number } | null): Promise<void> {
  const inverse: BucketEditInput = {};
  if (changes.name !== undefined) inverse.name = before.name;
  if (changes.colour !== undefined) inverse.colour = before.colour;
  const groupChanged = changes.groupId !== undefined || changes.newGroupName !== undefined;
  if (groupChanged && before.groupId) inverse.groupId = before.groupId;
  if (changes.type !== undefined) {
    inverse.type = before.type;
    if (before.type !== "plain") inverse.amount = before.amount;
    if (before.type === "goal") inverse.goalMonth = before.goalMonth;
  } else {
    if (changes.amount !== undefined) inverse.amount = before.amount;
    if (changes.goalMonth !== undefined) inverse.goalMonth = before.goalMonth;
  }
  await ctx.client.revertBucket(before.id, { ...inverse, revertOf: saved.updatedAt });
  // A group change appends to the end of the group; put it back where it was.
  if (groupChanged && place) await ctx.client.moveBucket(before.id, place);
  // An edit that made a new group leaves it empty after the undo; remove it.
  if (changes.newGroupName !== undefined && saved.groupId && saved.groupId !== before.groupId) {
    try {
      await ctx.client.deleteGroup(saved.groupId);
    } catch (error) {
      if (!(error instanceof ApiError && (error.code === "group_not_empty" || error.code === "not_found"))) throw error;
    }
  }
  await ctx.refresh(before.id);
}
