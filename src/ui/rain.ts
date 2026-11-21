// Make it rain (ADR-0005): the button beside Ready to assign, the preview of the server's dry run, and the brief
// rain flourish after a confirmed rain. The preview shows the plan exactly as the server computed it; confirming
// asks the server to apply it, and the snackbar's Undo reverses the whole rain (or shows why it can't).
import type { createClient } from "../client.js";
import type { BucketMonth, Budget, RainPlan } from "../core/index.js";
import { formatMoney } from "../core/money.js";
import { el, icon, withVars } from "./dom.js";
import { openSheet } from "./sheet.js";

export interface RainContext {
  client: ReturnType<typeof createClient>;
  budget: Budget;
  month: string;
  readyToAssign: number;
  /** The month's buckets, in bucket order, for names and colours. */
  buckets: BucketMonth[];
  /** Redraws the page after the rain or its undo. Never throws. */
  refresh(): Promise<boolean>;
  snack(message: string, undo: () => Promise<void>): void;
  /** Where focus goes when the preview closes. */
  returnFocus(): HTMLElement | null;
  /** The element the flourish plays over once the page has redrawn. */
  layer(): HTMLElement | null;
}

const money = (cents: number) => formatMoney(cents, { symbol: true });
const monthName = (month: string) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleDateString("en-US", { month: "long" });

export function rainButton(open: () => void): HTMLButtonElement {
  const button = el("button", { class: "btn btn-rain", type: "button" }, icon("rain"), "Make it rain");
  button.addEventListener("click", open);
  return button;
}

/** Loads the dry run and opens the preview. A failed load leaves the page as it was and reports through `onError`. */
export async function openRainPreview(ctx: RainContext, onError: (error: unknown) => void): Promise<void> {
  let plan: RainPlan;
  try {
    plan = await ctx.client.planRain(ctx.budget.id, ctx.month);
  } catch (error) {
    onError(error);
    return;
  }
  const byId = new Map(ctx.buckets.map((bucket) => [bucket.id, bucket]));
  const empty = plan.fills.length === 0;
  const body = empty
    ? [el("p", { class: "rain-empty" }, ctx.readyToAssign <= 0 ? "Nothing ready to assign." : `Every bucket's target is met for ${monthName(ctx.month)}.`)]
    : [
      el("ul", { class: "rain-fills" }, ...plan.fills.map((fill) => {
        const bucket = byId.get(fill.bucketId);
        return el("li", {},
          withVars(el("span", { class: "dot", "aria-hidden": "true" }), { "--c": `var(--b-${bucket?.colour ?? "slate"})` }),
          el("span", { class: "rn" }, bucket?.name ?? "Bucket"), " ",
          el("span", { class: "num" }, money(fill.amount)));
      })),
      el("div", { class: "rain-total" }, el("span", {}, "Total"), " ", el("span", { class: "num" }, money(plan.total))),
      el("div", { class: "rain-ready" }, el("span", {}, "Ready to assign"), " ",
        el("span", { class: "num" }, money(ctx.readyToAssign), " → ", el("strong", {}, money(ctx.readyToAssign - plan.total)))),
    ];

  let dialog: HTMLDialogElement | undefined;
  openSheet({
    title: "Make it rain",
    submitLabel: empty ? "Done" : `Rain ${money(plan.total)}`,
    body: (sheet) => {
      dialog = sheet.dialog;
      dialog.classList.add("rain-sheet");
      return body;
    },
    initialFocus: () => dialog?.querySelector<HTMLElement>("button[type=submit]") ?? null,
    // Evaluated on close: after a rain the page has redrawn, so this finds the new button.
    returnFocus: ctx.returnFocus,
    submit: async () => {
      if (empty) return;
      const rain = await ctx.client.rain(ctx.budget.id, ctx.month);
      await ctx.refresh();
      if (!rain.rainId || rain.fills.length === 0) return;
      const rainId = rain.rainId;
      const count = rain.fills.length;
      ctx.snack(`Rained ${money(rain.total)} into ${count} ${count === 1 ? "bucket" : "buckets"}.`, async () => {
        await ctx.client.undoRain(rainId);
        await ctx.refresh();
      });
      flourish(ctx.layer());
    },
  });
}

const DROPS = 14;
const LENGTH = 900; // ms: the longest drop (760ms) after the latest start (140ms)

/** Drops falling through Ready to assign, under a second, cleared by any click or key; none under reduced motion. */
function flourish(layer: HTMLElement | null): void {
  if (!layer || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const stop = new AbortController();
  const clear = () => {
    stop.abort();
    window.clearTimeout(timer);
    layer.replaceChildren();
  };
  layer.replaceChildren(...Array.from({ length: DROPS }, (_, index) => withVars(el("i"), {
    "--x": `${6 + ((index * 61) % 88)}%`,
    "--d": `${(index * 37) % 140}ms`,
  })));
  const timer = window.setTimeout(clear, LENGTH);
  for (const type of ["pointerdown", "keydown"] as const) window.addEventListener(type, clear, { once: true, capture: true, signal: stop.signal });
}
