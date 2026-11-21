// The Buckets page's add/take pill (desktop): an 80×24 input on every active bucket row. Typing adds from Ready to
// assign and a leading minus takes back. Focus opens the row panel (assigned this month and spent); a valid draft
// previews before → after there, in the row's Available and in the strip's Ready to assign. Errors float beside
// the pill. Enter applies and keeps focus, Tab applies a valid draft and moves to the next bucket's pill (an
// invalid one is kept), Escape clears. The page re-renders after every change; drafts and focus survive that.
import type { BucketMonth } from "../core/index.js";
import { formatMoney } from "../core/money.js";
import { MINUS, describeChange, readDraft, signed } from "./add-take.js";
import type { Draft } from "./add-take.js";
import { el, icon } from "./dom.js";
import { uid } from "./sheet.js";

export interface PillContext {
  readyToAssign(): number;
  /** Applies a signed change; resolves to an error message if it was refused. */
  apply(bucket: BucketMonth, delta: number): Promise<string | null>;
  /** Shows Ready to assign as it would be after a change (cents), or as it is (null). */
  previewReady(cents: number | null): void;
}

interface Confirmation { delta: number; timer: number }

const REST = `+ / ${MINUS}`;
const pillSelector = "input.pill-in[data-bucket-id]";

export function createPills(ctx: PillContext) {
  const drafts = new Map<string, string>();
  const confirmations = new Map<string, Confirmation>();
  // The server's last refusal per bucket, shown while the draft is unchanged. Editing the draft, a successful
  // apply or a redraw (fresh figures) drops it, so the same amount can be tried again.
  const refused = new Map<string, { text: string; message: string }>();
  const panelId = uid("rpanel");
  const noteId = uid("pnote");
  const panel = el("div", { class: "rpanel", role: "cell", id: panelId, "aria-label": "Add or take preview" });
  const note = el("div", { class: "pnote", role: "alert", id: noteId });

  const money = (cents: number) => formatMoney(cents, { symbol: true });

  function line(label: string, from: string, to: string | null, extra = ""): HTMLElement {
    return el("div", {}, el("dt", {}, label),
      el("dd", {}, from, to === null ? null : el("span", { class: "arrow" }, " → "), to === null ? null : el("span", { class: "new" }, to), extra ? el("span", { class: "of" }, ` ${extra}`) : null));
  }

  function assignedLine(bucket: BucketMonth, delta: number): HTMLElement {
    const of = bucket.type === "recurring" && bucket.amount !== null ? `of ${formatMoney(bucket.amount)}` : "";
    return line("Assigned this month", formatMoney(bucket.assigned), delta ? formatMoney(bucket.assigned + delta) : null, of);
  }

  function paintPanel(bucket: BucketMonth, draft: Draft): void {
    const done = confirmations.get(bucket.id);
    if (draft.kind === "ok") {
      const ready = ctx.readyToAssign();
      panel.replaceChildren(
        el("div", { class: "rp-title" }, describeChange(bucket.name, draft.delta, "instruction")),
        el("dl", { class: "rp-rows num" },
          line("Available", formatMoney(bucket.available), formatMoney(bucket.available + draft.delta)),
          line("Ready to assign", money(ready), money(ready - draft.delta)),
          assignedLine(bucket, draft.delta)));
    } else {
      panel.replaceChildren(
        done ? el("div", { class: "rp-title ok" }, icon("check", "sm"), describeChange(bucket.name, done.delta)) : el("div", { class: "rp-title" }, bucket.name),
        el("dl", { class: "rp-rows num" }, assignedLine(bucket, 0), line("Spent", formatMoney(bucket.spent), null)));
    }
  }

  function draftOf(bucket: BucketMonth, text: string): Draft {
    const blocked = refused.get(bucket.id);
    if (blocked && blocked.text === text) return { kind: "error", message: blocked.message };
    return readDraft(text, bucket, ctx.readyToAssign());
  }

  function show(bucket: BucketMonth, input: HTMLInputElement, draft: Draft, forced?: string): void {
    const message = forced ?? (draft.kind === "error" ? draft.message : null);
    input.setAttribute("aria-invalid", String(message !== null));
    const row = input.closest(".brow");
    const fig = row?.querySelector<HTMLElement>(".avail .fig");
    if (fig) {
      const preview = draft.kind === "ok" && !forced;
      fig.textContent = formatMoney(preview ? bucket.available + draft.delta : bucket.available);
      fig.classList.toggle("is-preview", preview);
    }
    ctx.previewReady(draft.kind === "ok" && !forced ? ctx.readyToAssign() - draft.delta : null);
    paintPanel(bucket, forced ? { kind: "empty" } : draft);
    if (row && panel.parentElement !== row) row.append(panel);
    if (message) {
      note.replaceChildren(icon("alert", "sm"), el("span", {}, message));
      if (note.parentElement !== input.parentElement) input.parentElement?.append(note);
    } else note.remove();
  }

  function hide(bucket: BucketMonth, input: HTMLInputElement): void {
    const fig = input.closest(".brow")?.querySelector<HTMLElement>(".avail .fig");
    if (fig) {
      fig.textContent = formatMoney(bucket.available);
      fig.classList.remove("is-preview");
    }
    ctx.previewReady(null);
    panel.remove();
    note.remove();
  }

  function confirm(bucketId: string, delta: number): void {
    const previous = confirmations.get(bucketId);
    if (previous) window.clearTimeout(previous.timer);
    const timer = window.setTimeout(() => {
      confirmations.delete(bucketId);
      const input = document.querySelector<HTMLInputElement>(`${pillSelector}[data-bucket-id="${CSS.escape(bucketId)}"]`);
      if (!input) return;
      input.placeholder = REST;
      input.classList.remove("applied");
    }, 2500);
    confirmations.set(bucketId, { delta, timer });
  }

  /** Returns whether focus may move on. */
  function submit(bucket: BucketMonth, input: HTMLInputElement, via: "enter" | "tab"): boolean {
    const text = input.value;
    const draft = draftOf(bucket, text);
    if (draft.kind === "empty") return true;
    if (draft.kind === "draft") {
      if (via === "tab") return true;
      show(bucket, input, draft, `Type the amount after the minus, like ${MINUS}20.`);
      return false;
    }
    if (draft.kind === "error") {
      show(bucket, input, draft);
      return via === "tab";
    }
    input.value = "";
    drafts.delete(bucket.id);
    confirm(bucket.id, draft.delta);
    input.placeholder = `✓ ${signed(draft.delta)}`;
    input.classList.add("applied");
    if (via === "enter") show(bucket, input, { kind: "empty" });
    void ctx.apply(bucket, draft.delta).then((message) => {
      if (message === null) {
        refused.delete(bucket.id);
        return;
      }
      // Refused (the figures moved meanwhile): the draft comes back with the reason.
      const tracked = confirmations.get(bucket.id);
      if (tracked) window.clearTimeout(tracked.timer);
      confirmations.delete(bucket.id);
      drafts.set(bucket.id, text);
      refused.set(bucket.id, { text, message });
      const current = document.querySelector<HTMLInputElement>(`${pillSelector}[data-bucket-id="${CSS.escape(bucket.id)}"]`);
      if (!current) return;
      current.value = text;
      current.placeholder = REST;
      current.classList.remove("applied");
      current.parentElement?.classList.add("has-draft");
      if (document.activeElement === current) show(bucket, current, draftOf(bucket, text));
    });
    return true;
  }

  function neighbour(input: HTMLInputElement, step: 1 | -1): HTMLInputElement | undefined {
    const all = [...(input.closest("[role=table]")?.querySelectorAll<HTMLInputElement>(pillSelector) ?? [])];
    return all[all.indexOf(input) + step];
  }

  /** The add/take cell for an active bucket's row. */
  function cell(bucket: BucketMonth): HTMLElement {
    refused.delete(bucket.id);
    const done = confirmations.get(bucket.id);
    const input = el("input", {
      class: `pill-in num${done ? " applied" : ""}`, type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false",
      "aria-label": `Add to or take from ${bucket.name}`, "aria-describedby": `${panelId} ${noteId}`, "data-bucket-id": bucket.id,
      placeholder: done ? `✓ ${signed(done.delta)}` : REST,
    });
    input.value = drafts.get(bucket.id) ?? "";
    const wrap = el("span", { class: `pill${input.value ? " has-draft" : ""}` }, input);
    input.addEventListener("focus", () => {
      wrap.classList.remove("has-draft");
      show(bucket, input, draftOf(bucket, input.value));
    });
    input.addEventListener("blur", () => {
      wrap.classList.toggle("has-draft", input.value.trim() !== "");
      hide(bucket, input);
    });
    input.addEventListener("input", () => {
      // A typed hyphen shows as a true minus; the caret stays put.
      if (input.value.includes("-")) {
        const at = input.selectionStart;
        input.value = input.value.replaceAll("-", MINUS);
        if (at !== null) input.setSelectionRange(at, at);
      }
      if (input.value) drafts.set(bucket.id, input.value);
      else drafts.delete(bucket.id);
      refused.delete(bucket.id);
      if (confirmations.has(bucket.id)) {
        window.clearTimeout(confirmations.get(bucket.id)!.timer);
        confirmations.delete(bucket.id);
        input.placeholder = REST;
        input.classList.remove("applied");
      }
      show(bucket, input, draftOf(bucket, input.value));
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit(bucket, input, "enter");
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (input.value) {
          input.value = "";
          drafts.delete(bucket.id);
          show(bucket, input, { kind: "empty" });
        } else hide(bucket, input);
      } else if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        if (!submit(bucket, input, "tab")) {
          event.preventDefault();
          return;
        }
        const next = neighbour(input, event.shiftKey ? -1 : 1);
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }
    });
    return el("div", { class: "c take", role: "cell" }, wrap);
  }

  return {
    cell,
    /** The focused pill before a re-render, to put focus back afterwards. */
    capture(root: HTMLElement): { id: string; start: number | null; end: number | null } | null {
      const active = document.activeElement;
      if (!(active instanceof HTMLInputElement) || !active.matches(pillSelector) || !root.contains(active)) return null;
      return { id: active.dataset.bucketId!, start: active.selectionStart, end: active.selectionEnd };
    },
    restore(root: HTMLElement, focus: { id: string; start: number | null; end: number | null } | null): void {
      if (!focus) return;
      const input = root.querySelector<HTMLInputElement>(`${pillSelector}[data-bucket-id="${CSS.escape(focus.id)}"]`);
      if (!input) return;
      input.focus();
      if (focus.start !== null && focus.end !== null) input.setSelectionRange(Math.min(focus.start, input.value.length), Math.min(focus.end, input.value.length));
    },
  };
}
