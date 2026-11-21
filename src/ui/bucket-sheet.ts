// The bucket sheet (compact screens): tapping a bucket row opens it on its Add / take tab. It shows Available and
// the bucket's figures, an Add | Take toggle (phone keypads lack a minus), the amount, a "Fill" chip for what rain
// would give the bucket, a preview, and an Apply button that names the change. It follows the on-screen keyboard.
import type { BucketMonth } from "../core/index.js";
import { formatMoney } from "../core/money.js";
import { MINUS, describeChange, readDraft } from "./add-take.js";
import type { Draft } from "./add-take.js";
import { monthLabel } from "./bucket-dialog.js";
import { el, icon, withVars } from "./dom.js";
import { openSheet, segmented, uid } from "./sheet.js";

export interface BucketSheetOptions {
  bucket: BucketMonth;
  readyToAssign: number;
  /** Applies a signed change; resolves to an error message if it was refused. */
  apply(delta: number): Promise<string | null>;
  edit(): void;
  returnFocus(): HTMLElement | null;
}

type Mode = "add" | "take";

export function openBucketSheet(options: BucketSheetOptions): void {
  const { bucket, readyToAssign } = options;
  const money = (cents: number) => formatMoney(cents, { symbol: true });
  let mode: Mode = "add";

  const amountId = uid("amt");
  const sign = el("span", { class: "sign", "aria-hidden": "true" }, "+$");
  const amount = el("input", { class: "input num", id: amountId, type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false" });
  const preview = el("div", { class: "preview num", "aria-live": "polite" });
  const chips = el("div", { class: "chips" });
  const direction = segmented<Mode>("Add or take", [["add", "Add"], ["take", "Take"]], "add", { onChange: (value) => setMode(value) });
  direction.root.classList.add("dir");
  direction.root.addEventListener("click", () => amount.focus());

  const targetLine = bucket.type === "recurring" && bucket.amount !== null ? `${money(bucket.amount)} a month`
    : bucket.type === "goal" && bucket.amount !== null && bucket.goalMonth ? `${money(bucket.amount)} by ${monthLabel(bucket.goalMonth)}` : "No target";
  const figure = el("div", { class: `sheet-fig${bucket.available < 0 ? " is-over" : ""}` },
    el("div", {}, el("span", { class: "sheet-label" }, "Available"), el("div", { class: "big num" }, formatMoney(bucket.available))),
    el("div", { class: "ctx num" }, el("span", {}, targetLine), el("span", {}, `Assigned ${formatMoney(bucket.assigned)} · Spent ${formatMoney(bucket.spent)}`)));

  const tabId = uid("tab");
  const panelId = uid("tabpanel");
  const tabs = el("div", { class: "sheet-tabs", role: "tablist", "aria-label": bucket.name },
    el("button", { type: "button", role: "tab", id: tabId, "aria-selected": "true", "aria-controls": panelId }, "Add / take"));
  const editor = el("div", { class: "money-editor", role: "tabpanel", id: panelId, "aria-labelledby": tabId },
    figure, direction.root, el("div", { class: "amount big" }, sign, amount), chips, preview);

  let submitButton: HTMLButtonElement | null = null;
  const draft = (): Draft => readDraft(`${mode === "take" ? "-" : ""}${amount.value}`, bucket, readyToAssign);

  function paint(): void {
    const state = amount.value.trim() ? draft() : { kind: "empty" as const };
    amount.setAttribute("aria-invalid", String(state.kind === "error"));
    if (state.kind === "ok") {
      const after = bucket.available + state.delta;
      preview.replaceChildren(
        el("div", {}, el("span", {}, "Available after"), el("strong", { class: after < 0 ? "neg" : "" }, formatMoney(after))),
        el("div", {}, el("span", {}, "Ready to assign after"), el("strong", {}, money(readyToAssign - state.delta))));
    } else if (state.kind === "error") {
      preview.replaceChildren(el("div", { class: "err" }, icon("alert", "sm"), el("span", {}, state.message)));
    } else {
      preview.replaceChildren(el("div", {}, el("span", {}, "Ready to assign"), el("strong", {}, money(readyToAssign))));
    }
    if (submitButton) {
      submitButton.textContent = state.kind === "ok" ? describeChange(bucket.name, state.delta).replace(/^Added/, "Add").replace(/^Took/, "Take")
        : mode === "add" ? `Add to ${bucket.name}` : `Take from ${bucket.name}`;
    }
  }

  function paintChips(): void {
    chips.replaceChildren();
    if (mode !== "add" || bucket.need <= 0) return;
    const value = formatMoney(bucket.need).replaceAll(",", "");
    const chip = el("button", { type: "button", class: "chip-btn num" }, `Fill ${formatMoney(bucket.need)}`);
    chip.addEventListener("click", () => {
      amount.value = value;
      paint();
      amount.focus();
    });
    chips.append(chip);
  }

  function setMode(next: Mode): void {
    mode = next;
    direction.set(next);
    sign.textContent = `${next === "add" ? "+" : MINUS}$`;
    amount.setAttribute("aria-label", next === "add" ? `Amount to add to ${bucket.name}` : `Amount to take from ${bucket.name}`);
    paintChips();
    paint();
  }

  amount.addEventListener("input", () => {
    // A typed minus switches to Take; the field holds only the amount.
    if (/^[-−]/.test(amount.value)) {
      amount.value = amount.value.replace(/^[-−]/, "");
      setMode("take");
      return;
    }
    paint();
  });

  const sheet = openSheet({
    title: bucket.name,
    titleStart: withVars(el("span", { class: "dot", "aria-hidden": "true" }), { "--c": `var(--b-${bucket.colour})` }),
    submitLabel: `Add to ${bucket.name}`,
    returnFocus: options.returnFocus,
    initialFocus: () => amount,
    body: () => [tabs, editor],
    async submit() {
      const state = draft();
      if (state.kind !== "ok") throw new Error(state.kind === "error" ? state.message : mode === "add" ? "Type an amount to add." : "Type an amount to take.");
      const refused = await options.apply(state.delta);
      if (refused) throw new Error(refused);
    },
  });
  const { dialog } = sheet;
  dialog.classList.add("bucket-sheet");
  submitButton = dialog.querySelector<HTMLButtonElement>("button[type=submit]");
  const edit = el("button", { class: "icon-btn", type: "button", "aria-label": `Edit ${bucket.name}` }, icon("pencil", "sm"));
  edit.addEventListener("click", () => {
    sheet.close();
    options.edit();
  });
  dialog.querySelector(".sheet-head [aria-label=Close]")?.before(edit);
  setMode("add");

  // Follow the on-screen keyboard: lift the sheet to the bottom of the visual viewport.
  const viewport = window.visualViewport;
  const follow = () => {
    if (!viewport) return;
    const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    dialog.style.setProperty("--kb", `${Math.round(covered)}px`);
    if (document.activeElement === amount) amount.scrollIntoView({ block: "nearest" });
  };
  viewport?.addEventListener("resize", follow);
  viewport?.addEventListener("scroll", follow);
  dialog.addEventListener("close", () => {
    viewport?.removeEventListener("resize", follow);
    viewport?.removeEventListener("scroll", follow);
  });
  follow();
}
