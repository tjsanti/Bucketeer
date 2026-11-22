import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";
import type { App } from "./harness.js";

// A dated goal's "By" month is chosen with a year stepper and a month grid, never typed. Months before the
// server's current month cannot be picked (core refuses a past goal month).

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

interface Bucket { id: string; name: string; type: string; amount: number | null; goalMonth: string | null }

async function api<T>(app: App, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${app.url}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return (await response.json()) as T;
}

/** "YYYY-MM" `count` months after `month`. */
function shift(month: string, count: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}
const year = (month: string) => Number(month.slice(0, 4));
const short = (month: string) => `${SHORT[Number(month.slice(5, 7)) - 1]} ${year(month)}`;
const long = (month: string) => `${LONG[Number(month.slice(5, 7)) - 1]} ${year(month)}`;

/** A budget with a Goals group holding Vacation, saving 3,000.00 by `goalMonth`. The server's current month comes back too. */
async function seed(app: App, goalMonth: (current: string) => string) {
  const budgetId = await seedBudget(app.url, "Household");
  const { current } = await api<{ current: string }>(app, "GET", `/api/budgets/${budgetId}/month-range`);
  const goals = await api<{ id: string }>(app, "POST", `/api/budgets/${budgetId}/groups`, { name: "Goals" });
  await api(app, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Vacation", groupId: goals.id, colour: "teal", type: "goal", amount: 300_000, goalMonth: goalMonth(current) });
  await app.page.goto(`${app.url}/budgets/${budgetId}/buckets`);
  await ready(app.page);
  const bucket = async (name: string) => (await api<{ buckets: Bucket[] }>(app, "GET", `/api/budgets/${budgetId}/buckets`)).buckets.find((b) => b.name === name)!;
  return { budgetId, current, bucket };
}

const byButton = (dialog: Locator) => dialog.getByRole("button", { name: /^By\b/ });
const picker = (page: Page) => page.getByRole("dialog", { name: "Choose month" });
const pickerYear = (page: Page) => picker(page).locator(".pick-year").textContent();
const isFocused = (locator: Locator) => locator.evaluate((node) => node === document.activeElement);

test("a new goal's By month defaults a year out, cannot be before this month, and saves the month picked", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { current, bucket } = await seed(app, (now) => shift(now, 9));
  const dialog = page.locator("dialog");

  await page.getByRole("button", { name: "Add bucket" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Laptop");
  await dialog.getByRole("radio", { name: "Dated goal" }).click();
  await dialog.getByLabel("Goal amount").fill("1800");
  const defaultMonth = shift(current, 12);
  assert.equal((await byButton(dialog).innerText()).trim(), short(defaultMonth));

  // The picker opens on the chosen month's year, with that month marked.
  await byButton(dialog).click();
  await picker(page).waitFor();
  assert.equal(await byButton(dialog).getAttribute("aria-expanded"), "true");
  assert.equal(await pickerYear(page), String(year(defaultMonth)));
  assert.equal(await picker(page).getByRole("button", { name: long(defaultMonth) }).getAttribute("aria-current"), "true");

  // Back in this month's year, every earlier month is disabled and the year stops there. The stepper that
  // stopped hands focus to the months, so Escape still closes only the picker.
  await picker(page).getByRole("button", { name: "Previous year" }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await pickerYear(page), String(year(current)));
  assert.equal(await picker(page).getByRole("button", { name: "Previous year" }).isDisabled(), true);
  assert.equal(await picker(page).evaluate((node) => node.contains(document.activeElement)), true, "Focus stays in the picker.");
  await page.keyboard.press("Escape");
  assert.equal(await picker(page).count(), 0);
  assert.equal(await dialog.isVisible(), true, "The bucket dialog stays open.");
  await byButton(dialog).click();
  await picker(page).getByRole("button", { name: "Previous year" }).click();
  assert.equal(await picker(page).getByRole("button", { name: long(current) }).isDisabled(), false);
  for (let back = 1; back <= Number(current.slice(5, 7)) - 1; back++) {
    assert.equal(await picker(page).getByRole("button", { name: long(shift(current, -back)) }).isDisabled(), true, long(shift(current, -back)));
  }

  // Picking closes the picker, shows the month and returns focus to the field.
  const chosen = shift(current, 14);
  await picker(page).getByRole("button", { name: "Next year" }).click();
  if (year(chosen) > year(current) + 1) await picker(page).getByRole("button", { name: "Next year" }).click();
  await picker(page).getByRole("button", { name: long(chosen) }).click();
  assert.equal(await picker(page).count(), 0);
  assert.equal((await byButton(dialog).innerText()).trim(), short(chosen));
  assert.equal(await isFocused(byButton(dialog)), true);

  await dialog.getByRole("button", { name: "Add bucket" }).click();
  await dialog.waitFor({ state: "detached" });
  const laptop = await bucket("Laptop");
  assert.deepEqual([laptop.type, laptop.amount, laptop.goalMonth], ["goal", 180_000, chosen]);
  assert.deepEqual(app.pageErrors, []);
});

test("the By picker works from the keyboard, and Escape closes only the picker", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { current, bucket } = await seed(app, (now) => shift(now, 9));
  const dialog = page.locator("dialog");
  const focusedName = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");

  await page.getByRole("button", { name: "Edit Vacation" }).click();
  const saved = shift(current, 9);
  assert.equal((await byButton(dialog).innerText()).trim(), short(saved), "Edit opens on the saved month.");

  await byButton(dialog).focus();
  await page.keyboard.press("Enter");
  await picker(page).waitFor();
  assert.equal(await focusedName(), long(saved), "Focus starts on the chosen month.");

  // Escape closes the picker and leaves the dialog open, with focus back on By.
  await page.keyboard.press("Escape");
  assert.equal(await picker(page).count(), 0);
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await isFocused(byButton(dialog)), true);
  assert.equal(await byButton(dialog).getAttribute("aria-expanded"), "false");

  // A browser whose Escape still asks the dialog to close, despite the cancelled keydown, closes only the picker.
  await byButton(dialog).click();
  await picker(page).waitFor();
  await dialog.evaluate((node) => node.dispatchEvent(new Event("cancel", { cancelable: true })));
  assert.equal(await picker(page).count(), 0, "The cancel closes the picker.");
  assert.equal(await dialog.isVisible(), true, "The bucket dialog stays open.");
  await byButton(dialog).focus();

  // Tab moves through the months; Enter picks one. Space opens the picker as well.
  await page.keyboard.press(" ");
  await picker(page).waitFor();
  const target = Number(saved.slice(5, 7)) < 12 ? shift(saved, 1) : shift(saved, -1);
  if (target > saved) await page.keyboard.press("Tab");
  else await page.keyboard.press("Shift+Tab");
  assert.equal(await focusedName(), long(target));
  await page.keyboard.press("Enter");
  assert.equal(await picker(page).count(), 0);
  assert.equal((await byButton(dialog).innerText()).trim(), short(target));
  assert.equal(await isFocused(byButton(dialog)), true);

  // Tabbing out of the picker closes it without changing the month.
  await page.keyboard.press("Enter");
  await picker(page).waitFor();
  for (let i = 0; i < 20 && (await picker(page).count()) > 0; i++) await page.keyboard.press("Tab");
  assert.equal(await picker(page).count(), 0);
  assert.equal((await byButton(dialog).innerText()).trim(), short(target));

  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal((await bucket("Vacation")).goalMonth, target);
  assert.deepEqual(app.pageErrors, []);
});

/** The picker lies inside the viewport's gutters and every month in it can be hit there (nothing clips it). */
async function assertPickerOnScreen(page: Page, width: number, height: number): Promise<void> {
  const box = (await picker(page).boundingBox())!;
  assert.ok(box.x >= 16 && box.x + box.width <= width - 16 && box.y >= 0 && box.y + box.height <= height, JSON.stringify(box));
  const hits = await picker(page).locator(".pick-month").evaluateAll((buttons) => buttons.map((button) => {
    const r = button.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === button && r.height >= 44;
  }));
  assert.deepEqual(hits, Array(12).fill(true));
}

test("in the desktop dialog at 1280 × 800 the open picker is not cut off by the dialog", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t, { height: 800 });
  const { page } = app;
  await seed(app, (now) => shift(now, 9));
  const dialog = page.locator("dialog");
  await page.getByRole("button", { name: "Edit Vacation" }).click();
  const top = async (locator: Locator) => (await locator.boundingBox())!.y;
  const before = [await top(dialog.getByRole("heading", { name: "Edit Vacation" })), await top(byButton(dialog))];
  await byButton(dialog).click();
  await picker(page).waitFor();
  await assertPickerOnScreen(page, 1280, 800);
  const after = [await top(dialog.getByRole("heading", { name: "Edit Vacation" })), await top(byButton(dialog))];
  assert.deepEqual(after, before, "Opening the picker scrolls nothing in the dialog.");
  assert.deepEqual(app.pageErrors, []);
});

for (const scheme of ["light", "dark"] as const) {
  test(`at 390px in the ${scheme} theme the By picker fits the bottom sheet and picks a month`, { timeout: 45_000 }, async (t) => {
    const app = await openApp(t, { colorScheme: scheme, width: 390, height: 844 });
    const { page } = app;
    const { current, bucket } = await seed(app, (now) => shift(now, 9));
    const dialog = page.locator("dialog");
    await page.getByRole("button", { name: "Add bucket" }).click();
    await dialog.getByLabel("Name", { exact: true }).fill("Laptop");
    await dialog.getByRole("radio", { name: "Dated goal" }).click();
    await dialog.getByLabel("Goal amount").fill("1800");
    const buttonBox = (await byButton(dialog).boundingBox())!;
    assert.ok(buttonBox.height >= 44, `By is a 44px target (${buttonBox.height}).`);

    await byButton(dialog).click();
    await picker(page).waitFor();
    await assertPickerOnScreen(page, 390, 844);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    // The picker floats over the sheet on a raised, shadowed surface.
    assert.notEqual(await picker(page).evaluate((node) => getComputedStyle(node).boxShadow), "none");

    const chosen = shift(current, 13);
    if (year(chosen) > year(current) + 1) await picker(page).getByRole("button", { name: "Next year" }).click();
    await picker(page).getByRole("button", { name: long(chosen) }).click();
    assert.equal((await byButton(dialog).innerText()).trim(), short(chosen));
    await dialog.getByRole("button", { name: "Add bucket" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal((await bucket("Laptop")).goalMonth, chosen);
    assert.deepEqual(app.pageErrors, []);
  });
}

test("a goal month the server refuses marks By and focuses it", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  // The page was loaded last month: it still offers that month, which the server now refuses.
  await page.route("**/month-range", async (route) => {
    const response = await route.fetch();
    const range = (await response.json()) as { current: string };
    await route.fulfill({ response, json: { ...range, current: shift(range.current, -1) } });
  });
  const { current } = await seed(app, (now) => shift(now, 9));
  const dialog = page.locator("dialog");
  await page.getByRole("button", { name: "Add bucket" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Laptop");
  await dialog.getByRole("radio", { name: "Dated goal" }).click();
  await dialog.getByLabel("Goal amount").fill("1800");
  const stale = shift(current, -1);
  await byButton(dialog).click();
  for (let shown = Number(await pickerYear(page)); shown > year(stale); shown--) await picker(page).getByRole("button", { name: "Previous year" }).click();
  await picker(page).getByRole("button", { name: long(stale) }).click();

  await dialog.getByRole("button", { name: "Add bucket" }).click();
  await dialog.locator(".snote span").waitFor();
  assert.equal(await dialog.locator(".snote span").textContent(), "Goal month cannot be in the past.");
  assert.equal(await byButton(dialog).getAttribute("aria-invalid"), "true");
  assert.equal(await isFocused(byButton(dialog)), true);
  // Picking another month clears the mark; that one saves.
  await byButton(dialog).click();
  await picker(page).getByRole("button", { name: "Next year" }).click();
  await picker(page).getByRole("button", { name: long(shift(stale, 12)) }).click();
  assert.equal(await byButton(dialog).getAttribute("aria-invalid"), null);
  await dialog.getByRole("button", { name: "Add bucket" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(app.pageErrors, []);
});
