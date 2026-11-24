import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { engine, openApp, ready, seedBudget } from "./harness.js";
import type { App } from "./harness.js";

// Independent expectations, taken from the plan and the locked design (not from the code under test).
const MINUS = "−";
const overLight = "rgb(179, 36, 59)"; // --over #B3243B
const overDark = "rgb(255, 150, 164)"; // --over #FF96A4
const inkLight = "rgb(21, 48, 60)"; // --text #15303C
const darkBackground = "rgb(15, 23, 30)"; // --bg #0F171E
const hueNames = ["Sky", "Denim", "Blue", "Slate", "Teal", "Mint", "Green", "Forest", "Lime", "Olive", "Sun", "Cocoa", "Peach", "Tangerine", "Rose", "Plum"];

interface Group { id: string; name: string }
interface Bucket { id: string; name: string; groupId: string | null; colour: string; type: string; amount: number | null; goalMonth: string | null; archived: boolean }
interface Table { groups: Group[]; buckets: Bucket[] }

async function api<T>(app: App, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${app.url}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const tableOf = (app: App, budgetId: string) => api<Table>(app, "GET", `/api/budgets/${budgetId}/buckets`);

/** Group name -> active bucket names, in the server's order. */
async function order(app: App, budgetId: string): Promise<Record<string, string[]>> {
  const table = await tableOf(app, budgetId);
  return Object.fromEntries(table.groups.map((group) => [group.name, table.buckets.filter((b) => !b.archived && b.groupId === group.id).map((b) => b.name)]));
}

interface Seeded { budgetId: string; groups: Record<string, string>; buckets: Record<string, string> }

/** Fixed: Rent, Gym · Everyday: Groceries, Dining out, Fuel · Goals: Vacation · Kids (empty). */
async function seed(app: App, options: { kids?: boolean } = {}): Promise<Seeded> {
  const budgetId = await seedBudget(app.url, "Household");
  const groups: Record<string, string> = {};
  for (const name of ["Fixed", "Everyday", "Goals", ...(options.kids ? ["Kids"] : [])]) {
    groups[name] = (await api<Group>(app, "POST", `/api/budgets/${budgetId}/groups`, { name })).id;
  }
  const buckets: Record<string, string> = {};
  const specs: [string, string, Record<string, unknown>][] = [
    ["Fixed", "Rent", { colour: "blue", type: "recurring", amount: 165000 }],
    ["Fixed", "Gym", { colour: "plum", type: "recurring", amount: 4000 }],
    ["Everyday", "Groceries", { colour: "green", type: "recurring", amount: 60000 }],
    ["Everyday", "Dining out", { colour: "rose", type: "recurring", amount: 15000 }],
    ["Everyday", "Fuel", { colour: "denim", type: "recurring", amount: 16000 }],
    ["Goals", "Vacation", { colour: "teal", type: "goal", amount: 300000, goalMonth: "2027-08" }],
  ];
  for (const [group, name, fields] of specs) {
    buckets[name] = (await api<Bucket>(app, "POST", `/api/budgets/${budgetId}/buckets`, { name, groupId: groups[group], ...fields })).id;
  }
  return { budgetId, groups, buckets };
}

async function openBuckets(app: App, budgetId: string): Promise<void> {
  await app.page.goto(`${app.url}/budgets/${budgetId}/buckets`);
  await ready(app.page);
}

const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
const colorOf = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).color);
const announced = (page: Page, text: string) => page.waitForFunction((expected) => document.getElementById("announce")?.textContent === expected, text, { timeout: 3_000 });
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function waitForSnack(page: Page, text: string): Promise<void> {
  await page.waitForFunction((expected) => document.getElementById("snack-msg")?.textContent === expected && !document.getElementById("snack")?.hidden, text, { timeout: 5_000 });
}

/** Drags a row by its grip to a y position (a row's top edge marks "just above that row"). */
async function drag(page: Page, row: Locator, toY: number, options: { cancel?: boolean } = {}): Promise<void> {
  await row.hover();
  const grip = await row.locator("[data-grip]").boundingBox();
  assert.ok(grip, "The row has a grip.");
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 20, toY, { steps: 8 });
  if (options.cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}

/** Retries an assertion until it passes (the page saves and redraws after a click resolves). */
async function eventually(check: () => Promise<void>, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > end) throw error;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}

const rowTop = async (locator: Locator) => (await locator.boundingBox())!.y + 2;

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const goalMonthButton = (dialog: Locator) => dialog.getByRole("button", { name: /^By\b/ });

/** Opens the dialog's By picker, steps to the month's year and picks the month ("YYYY-MM"). */
async function pickGoalMonth(page: Page, dialog: Locator, month: string): Promise<void> {
  await goalMonthButton(dialog).click();
  const picker = page.getByRole("dialog", { name: "Choose month" });
  const year = Number(month.slice(0, 4));
  for (let shown = Number(await picker.locator(".pick-year").textContent()); shown !== year; shown += shown < year ? 1 : -1) {
    await picker.getByRole("button", { name: shown < year ? "Next year" : "Previous year" }).click();
  }
  await picker.getByRole("button", { name: `${monthNames[Number(month.slice(5, 7)) - 1]} ${year}` }).click();
}

test("the Buckets page is reached from the nav and its deep link; / still opens Accounts", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await seed(app);

  await page.goto(app.url);
  await ready(page);
  assert.equal(new URL(page.url()).pathname, `/budgets/${budgetId}/accounts`);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Accounts");
  assert.deepEqual(await page.locator("#nav a").allTextContents(), ["Buckets", "Accounts"]);

  await page.getByRole("link", { name: "Buckets" }).click();
  await ready(page);
  assert.equal(new URL(page.url()).pathname, `/budgets/${budgetId}/buckets`);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Buckets");
  assert.equal(await page.getByRole("link", { name: "Buckets" }).getAttribute("aria-current"), "page");
  assert.equal(await page.getByRole("link", { name: "Accounts" }).getAttribute("aria-current"), null);

  // The deep link survives a reload; back returns to Accounts.
  await page.reload();
  await ready(page);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Buckets");
  await page.goBack();
  await ready(page);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Accounts");

  // Table content: group rows with counts and the three kinds of target.
  await openBuckets(app, budgetId);
  const grid = page.getByRole("table", { name: "Buckets" });
  assert.deepEqual((await grid.locator(".bgroup .gname").allTextContents()), ["Fixed", "Everyday", "Goals"]);
  assert.deepEqual(await grid.locator(".bgroup .gcount").allTextContents(), ["2", "3", "1"]);
  const rent = grid.getByRole("row", { name: /Rent/ });
  assert.equal(compact(await rent.locator(".det").innerText()), "$0.00 of $1,650.00 per month");
  const vacation = grid.getByRole("row", { name: /Vacation/ });
  assert.equal(compact(await vacation.locator(".gmeta").innerText()), "of $3,000.00 · Aug 2027");
  assert.equal(await vacation.locator(".pct").textContent(), "0%");
  assert.equal(await vacation.getByRole("img").getAttribute("aria-label"), "0% saved toward a $3,000.00 goal");
  assert.equal(await rent.locator(".avail").textContent(), "0.00");
  assert.deepEqual(app.pageErrors, []);
  assert.deepEqual(app.foreignRequests, []);
});

test("buckets can be added, edited, archived and restored, with Undo for edit and archive", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t, { height: 800 });
  const { page } = app;
  const budgetId = await seedBudget(app.url, "Household");
  await openBuckets(app, budgetId);
  const dialog = page.locator("dialog");

  // First run: an empty state with one Add bucket; the group starts as a new-group field.
  assert.equal(compact(await page.locator(".bempty-state").innerText()), "No buckets yet Add bucket");
  await page.getByRole("button", { name: "Add bucket" }).click();
  assert.equal(await dialog.getByRole("heading").textContent(), "Add bucket");
  assert.equal(await dialog.getByLabel("New group name").isVisible(), true);
  assert.equal(await dialog.getByRole("combobox").isVisible(), false);
  assert.equal(await dialog.getByRole("button", { name: "Choose existing" }).isVisible(), false);
  // The default colour is the first in palette order when nothing is used yet.
  assert.equal(await dialog.getByRole("radio", { name: "Sky" }).getAttribute("aria-checked"), "true");
  await dialog.getByLabel("Name", { exact: true }).fill("Rent");
  await dialog.getByLabel("New group name").fill("Fixed");
  await dialog.getByLabel("Amount per month").fill("1,650");
  await dialog.getByRole("button", { name: "Add bucket" }).click();
  await dialog.waitFor({ state: "detached" });
  let table = await tableOf(app, budgetId);
  assert.deepEqual(table.groups.map((g) => g.name), ["Fixed"]);
  assert.deepEqual(table.buckets.map((b) => [b.name, b.colour, b.type, b.amount, b.goalMonth]), [["Rent", "sky", "recurring", 165000, null]]);
  assert.equal(await focusedLabel(page), "Edit Rent", "Focus lands on the new row.");

  // A second bucket defaults to the next unused colour.
  await page.getByRole("button", { name: "Add bucket" }).click();
  assert.equal(await dialog.getByRole("radio", { name: "Denim" }).getAttribute("aria-checked"), "true");
  await dialog.getByLabel("Name", { exact: true }).fill("Clothing");
  await dialog.getByRole("radio", { name: "Plain" }).click();
  await dialog.getByRole("button", { name: "Add bucket" }).click();
  await dialog.waitFor({ state: "detached" });
  table = await tableOf(app, budgetId);
  assert.deepEqual(table.buckets.map((b) => [b.name, b.colour, b.type, b.amount]), [["Rent", "sky", "recurring", 165000], ["Clothing", "denim", "plain", null]]);

  // A name clash: the server's message shows in neutral ink, the name field is marked and focused, and input is kept.
  await page.getByRole("button", { name: "Add bucket" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("rent");
  await dialog.getByRole("radio", { name: "Plain" }).click();
  await dialog.getByRole("button", { name: "Add bucket" }).click();
  const note = dialog.locator(".snote");
  await note.locator("span").waitFor();
  assert.match(await note.innerText(), /already exists/);
  assert.equal(await colorOf(note), inkLight);
  const nameField = dialog.getByLabel("Name", { exact: true });
  assert.equal(await nameField.getAttribute("aria-invalid"), "true");
  assert.equal(await nameField.evaluate((node) => node === document.activeElement), true);
  assert.equal(await nameField.inputValue(), "rent");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  // Edit: whole-row click opens Edit; change amount, colour and name; Undo puts every field back.
  // A real click on the target text, well away from the name: the name button's hit area covers the row.
  const targetBox = (await page.getByRole("table", { name: "Buckets" }).getByRole("row", { name: /Rent/ }).locator(".det").boundingBox())!;
  await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
  assert.equal(await dialog.getByRole("heading").textContent(), "Edit Rent");
  assert.equal(await dialog.getByLabel("Amount per month").inputValue(), "1,650.00");
  await dialog.getByLabel("Name", { exact: true }).fill("Mortgage");
  await dialog.getByLabel("Amount per month").fill("1,700.50");
  await dialog.getByRole("radio", { name: "Plum" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  let rent = (await tableOf(app, budgetId)).buckets.find((b) => b.id === table.buckets[0]!.id)!;
  assert.deepEqual([rent.name, rent.amount, rent.colour], ["Mortgage", 170050, "plum"]);
  assert.equal(await focusedLabel(page), "Edit Mortgage");
  await waitForSnack(page, "Saved Mortgage.");
  await page.locator("#snack-undo").click();
  await page.getByRole("button", { name: "Edit Rent" }).waitFor();
  rent = (await tableOf(app, budgetId)).buckets.find((b) => b.id === rent.id)!;
  assert.deepEqual([rent.name, rent.amount, rent.colour, rent.type], ["Rent", 165000, "sky", "recurring"]);

  // Undo of a type change restores the old type and amount.
  await page.getByRole("button", { name: "Edit Rent" }).click();
  await dialog.getByRole("radio", { name: "Plain" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal((await tableOf(app, budgetId)).buckets.find((b) => b.id === rent.id)!.amount, null);
  await waitForSnack(page, "Saved Rent.");
  await page.locator("#snack-undo").click();
  await eventually(async () => {
    rent = (await tableOf(app, budgetId)).buckets.find((b) => b.id === rent.id)!;
    assert.deepEqual([rent.type, rent.amount], ["recurring", 165000]);
  });
  await eventually(async () => assert.equal(compact(await page.getByRole("row", { name: /Rent/ }).locator(".det").innerText()), "$0.00 of $1,650.00 per month"));

  // Archive from Edit (the zero case): the row moves to the fold; Undo restores it.
  await page.getByRole("button", { name: "Edit Clothing" }).click();
  await dialog.getByRole("button", { name: "Archive Clothing" }).click();
  await dialog.waitFor({ state: "detached" });
  await waitForSnack(page, "Archived Clothing.");
  assert.equal(await page.getByRole("button", { name: "Edit Clothing" }).count(), 0);
  assert.equal(compact(await page.locator("details.archived summary").innerText()), "Archived buckets · 1");
  assert.equal((await tableOf(app, budgetId)).buckets.find((b) => b.name === "Clothing")!.archived, true);
  await page.locator("#snack-undo").click();
  await page.getByRole("button", { name: "Edit Clothing" }).waitFor();
  assert.equal((await tableOf(app, budgetId)).buckets.find((b) => b.name === "Clothing")!.archived, false);
  assert.equal(await page.locator("details.archived").count(), 0);

  // Archive again, then Restore from the fold. An archived bucket offers no Edit.
  await page.getByRole("button", { name: "Edit Clothing" }).click();
  await dialog.getByRole("button", { name: "Archive Clothing" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator("details.archived summary").click();
  const archivedRow = page.locator("details.archived li");
  assert.match(compact(await archivedRow.innerText()), /^Clothing Fixed · Archived [A-Z][a-z]{2} \d{1,2} Restore$/);
  assert.equal(await page.getByRole("button", { name: "Edit Clothing" }).count(), 0);
  await page.getByRole("button", { name: "Restore Clothing" }).click();
  await page.getByRole("button", { name: "Edit Clothing" }).waitFor();
  assert.deepEqual(await order(app, budgetId), { Fixed: ["Rent", "Clothing"] });
  assert.deepEqual(app.pageErrors, []);
});

test("the group dropdown opens without changing the choice, has typeahead and a new-group mode", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t, { height: 800 });
  const { page } = app;
  const { budgetId, groups } = await seed(app);
  await openBuckets(app, budgetId);
  const dialog = page.locator("dialog");

  // "Add bucket to Everyday" from the group menu preselects Everyday.
  await page.getByRole("button", { name: "Everyday group actions" }).click();
  assert.deepEqual(await page.getByRole("menuitem").allInnerTexts(), ["Add bucket to Everyday", "Rename group"]);
  await page.getByRole("menuitem", { name: "Add bucket to Everyday" }).click();
  const combo = dialog.getByRole("combobox", { name: "Group" });
  const list = dialog.getByRole("listbox");
  assert.equal(compact(await combo.innerText()), "Everyday");

  // Arrowing opens the list on the current choice and moves the active option, but never picks.
  await combo.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await list.isVisible(), true);
  assert.equal(await combo.getAttribute("aria-expanded"), "true");
  const active = () => combo.evaluate((node) => document.getElementById(node.getAttribute("aria-activedescendant") ?? "")?.textContent ?? null);
  assert.equal(await active(), "Everyday");
  await page.keyboard.press("ArrowDown");
  assert.equal(await active(), "Goals");
  assert.equal(compact(await combo.innerText()), "Everyday");
  assert.equal(await dialog.getByRole("option", { name: "Everyday" }).getAttribute("aria-selected"), "true");

  // Escape closes only the list.
  await page.keyboard.press("Escape");
  assert.equal(await list.isVisible(), false);
  assert.equal(await dialog.isVisible(), true);
  assert.equal(compact(await combo.innerText()), "Everyday");

  // Typeahead jumps without picking; Enter picks.
  await page.keyboard.press("f");
  assert.equal(await list.isVisible(), true);
  assert.equal(await active(), "Fixed");
  assert.equal(compact(await combo.innerText()), "Everyday");
  await page.keyboard.press("Enter");
  assert.equal(await list.isVisible(), false);
  assert.equal(compact(await combo.innerText()), "Fixed");
  assert.equal(await combo.evaluate((node) => node === document.activeElement), true);

  // After a click opens the list, the keys still reach it (Safari doesn't focus a clicked button).
  await combo.click();
  assert.equal(await active(), "Fixed");
  await page.keyboard.press("ArrowDown");
  assert.equal(await active(), "Everyday", "ArrowDown after a click moves the active option.");
  await page.keyboard.press("Escape");
  assert.equal(await list.isVisible(), false);
  assert.equal(await dialog.isVisible(), true, "Escape after a click closes only the list.");

  // Pointer: click opens, clicking an option picks it.
  await combo.click();
  await dialog.getByRole("option", { name: "Goals" }).click();
  assert.equal(compact(await combo.innerText()), "Goals");

  // "New group" turns the control into a name field, with a way back.
  await page.keyboard.press("n");
  assert.equal(await active(), "New group");
  await page.keyboard.press("Enter");
  const newName = dialog.getByLabel("New group name");
  assert.equal(await newName.evaluate((node) => node === document.activeElement), true);
  await dialog.getByRole("button", { name: "Choose existing" }).click();
  assert.equal(compact(await combo.innerText()), "Goals");
  await combo.click();
  await dialog.getByRole("option", { name: "New group" }).click();

  await dialog.getByLabel("Name", { exact: true }).fill("Swimming");
  await newName.fill("Kids");
  await dialog.getByRole("radio", { name: "Plain" }).click();
  await dialog.getByRole("button", { name: "Add bucket" }).click();
  await dialog.waitFor({ state: "detached" });
  const after = await order(app, budgetId);
  assert.deepEqual(after.Kids, ["Swimming"]);
  assert.deepEqual(after.Goals, ["Vacation"]);

  // Edit: moving a bucket to another group through the dropdown, then Undo, puts it back in its old place.
  await page.getByRole("button", { name: "Edit Groceries" }).click();
  await combo.click();
  await dialog.getByRole("option", { name: "Fixed" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual((await order(app, budgetId)).Fixed, ["Rent", "Gym", "Groceries"]);
  await waitForSnack(page, "Saved Groceries.");
  await page.locator("#snack-undo").click();
  await eventually(async () => assert.deepEqual(await order(app, budgetId), { Fixed: ["Rent", "Gym"], Everyday: ["Groceries", "Dining out", "Fuel"], Goals: ["Vacation"], Kids: ["Swimming"] }));
  await eventually(async () => assert.deepEqual(await page.locator(".brow .name").allTextContents(), ["Rent", "Gym", "Groceries", "Dining out", "Fuel", "Vacation", "Swimming"]));
  assert.ok(groups.Everyday);
  assert.deepEqual(app.pageErrors, []);
});

test("colour swatches move by arrow keys and are named; each type keeps its own amount", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t, { height: 800 });
  const { page } = app;
  const { budgetId } = await seed(app);
  await openBuckets(app, budgetId);
  const dialog = page.locator("dialog");
  await page.getByRole("button", { name: "Add bucket" }).click();

  const radios = dialog.getByRole("radiogroup", { name: "Colour" }).getByRole("radio");
  assert.deepEqual(await radios.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))), hueNames);
  // Seeded buckets use blue, plum, green, rose, denim and teal: the least used in palette order is Sky.
  const checked = () => dialog.getByRole("radiogroup", { name: "Colour" }).locator('[aria-checked="true"]').getAttribute("aria-label");
  const hueText = () => dialog.locator(".hue-name").textContent();
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  assert.equal(await checked(), "Sky");
  assert.equal(await hueText(), "Sky");
  assert.deepEqual(await radios.evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).tabIndex === 0).length), 1, "One tab stop for the whole group.");

  await dialog.getByRole("radio", { name: "Sky" }).focus();
  await page.keyboard.press("ArrowRight");
  assert.deepEqual([await checked(), await focused(), await hueText()], ["Denim", "Denim", "Denim"]);
  await page.keyboard.press("ArrowDown");
  assert.deepEqual([await checked(), await focused()], ["Olive", "Olive"], "Down moves a whole row.");
  await page.keyboard.press("ArrowUp");
  assert.equal(await checked(), "Denim");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await checked(), "Plum", "Left from the first colour wraps to the last.");
  await page.keyboard.press("Home");
  assert.equal(await checked(), "Sky");
  await page.keyboard.press("End");
  assert.equal(await checked(), "Plum");
  // The title dot previews the choice.
  assert.equal(await dialog.locator(".sheet-head .dot").evaluate((node) => getComputedStyle(node).backgroundColor),
    await dialog.getByRole("radio", { name: "Plum" }).locator(".sw-dot").evaluate((node) => getComputedStyle(node).backgroundColor));

  // Type switching: each type keeps its own draft; Plain folds the fields away.
  await dialog.getByLabel("Name", { exact: true }).fill("Laptop");
  await dialog.getByLabel("Amount per month").fill("160");
  await dialog.getByRole("radio", { name: "Dated goal" }).click();
  assert.equal(await dialog.getByLabel("Goal amount").inputValue(), "");
  await dialog.getByLabel("Goal amount").fill("1800");
  await pickGoalMonth(page, dialog, "2027-08");
  assert.equal((await goalMonthButton(dialog).innerText()).trim(), "Aug 2027");
  await dialog.getByRole("radio", { name: "Recurring" }).click();
  assert.equal(await dialog.getByLabel("Amount per month").inputValue(), "160.00", "The recurring draft is kept (tidied on blur).");
  assert.equal(await goalMonthButton(dialog).isVisible(), false);
  await dialog.getByRole("radio", { name: "Plain" }).click();
  assert.equal(await dialog.getByLabel("Amount per month").isVisible(), false);
  await dialog.getByRole("radio", { name: "Dated goal" }).click();
  assert.equal(await dialog.getByLabel("Goal amount").inputValue(), "1,800.00");
  assert.equal((await goalMonthButton(dialog).innerText()).trim(), "Aug 2027", "The goal month is kept too.");
  await dialog.getByRole("button", { name: "Add bucket" }).click();
  await dialog.waitFor({ state: "detached" });
  const laptop = (await tableOf(app, budgetId)).buckets.find((b) => b.name === "Laptop")!;
  assert.deepEqual([laptop.type, laptop.amount, laptop.goalMonth, laptop.colour], ["goal", 180000, "2027-08", "plum"]);

  // Desktop dialog: anchored near the top, so the top does not move when the height changes; nothing scrolls at 1280 x 800.
  await page.getByRole("button", { name: "Edit Laptop" }).click();
  const box = () => dialog.evaluate((node) => { const r = node.getBoundingClientRect(); return { top: r.top, height: r.height }; });
  const before = await box();
  assert.ok(before.top < 60, `The dialog sits near the top (${before.top}).`);
  await dialog.getByRole("radio", { name: "Plain" }).click();
  const after = await box();
  assert.equal(after.top, before.top);
  assert.ok(after.height < before.height);
  assert.equal(await dialog.locator(".sheet-body").evaluate((node) => node.scrollHeight <= node.clientHeight), true);
  assert.deepEqual(app.pageErrors, []);
});

test("groups render with No buckets, rename inline with Undo, and delete only when empty", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, groups } = await seed(app, { kids: true });
  await openBuckets(app, budgetId);

  const kids = page.locator(".bempty");
  assert.equal(compact(await kids.innerText()), "No buckets");

  // Escape cancels a rename without saving.
  await page.getByRole("button", { name: "Everyday group actions" }).click();
  await page.getByRole("menuitem", { name: "Rename group" }).click();
  const input = page.getByLabel("Group name", { exact: true });
  assert.equal(await input.inputValue(), "Everyday");
  await input.fill("Daily");
  await page.keyboard.press("Escape");
  assert.equal(await input.count(), 0);
  assert.equal(await focusedLabel(page), "Everyday group actions");
  assert.deepEqual((await tableOf(app, budgetId)).groups.map((g) => g.name), ["Fixed", "Everyday", "Goals", "Kids"]);

  // A clash keeps the row open with the server's message.
  await page.getByRole("button", { name: "Everyday group actions" }).click();
  await page.getByRole("menuitem", { name: "Rename group" }).click();
  await input.fill("fixed");
  await page.keyboard.press("Enter");
  await page.locator(".rn-err").waitFor();
  assert.match(await page.locator(".rn-err").innerText(), /already exists/);
  assert.equal(await input.getAttribute("aria-invalid"), "true");

  // Enter saves; Undo renames back.
  await input.fill("Daily");
  await page.keyboard.press("Enter");
  await waitForSnack(page, "Renamed Everyday to Daily.");
  assert.equal((await tableOf(app, budgetId)).groups.find((g) => g.id === groups.Everyday)!.name, "Daily");
  assert.equal(await focusedLabel(page), "Daily group actions");
  await page.locator("#snack-undo").click();
  await page.getByRole("button", { name: "Everyday group actions" }).waitFor();
  assert.equal((await tableOf(app, budgetId)).groups.find((g) => g.id === groups.Everyday)!.name, "Everyday");

  // An Undo the server refuses shows its message on the page.
  await page.getByRole("button", { name: "Goals group actions" }).click();
  await page.getByRole("menuitem", { name: "Rename group" }).click();
  await input.fill("Savings");
  await page.keyboard.press("Enter");
  await waitForSnack(page, "Renamed Goals to Savings.");
  await api(app, "POST", `/api/budgets/${budgetId}/groups`, { name: "Goals" });
  await page.locator("#snack-undo").click();
  await page.locator(".page > .note span").waitFor();
  assert.match(await page.locator(".page > .note").innerText(), /already exists/);
  assert.equal((await tableOf(app, budgetId)).groups.find((g) => g.id === groups.Goals)!.name, "Savings");

  // Delete group is offered only for a group without active buckets.
  await page.reload();
  await ready(page);
  await page.getByRole("button", { name: "Fixed group actions" }).click();
  assert.equal(await page.getByRole("menuitem", { name: "Delete group" }).count(), 0);
  await page.keyboard.press("Escape");
  assert.equal(await focusedLabel(page), "Fixed group actions");
  await page.getByRole("button", { name: "Kids group actions" }).click();
  await page.getByRole("menuitem", { name: "Delete group" }).click();
  await page.getByRole("button", { name: "Kids group actions" }).waitFor({ state: "detached" });
  assert.equal((await tableOf(app, budgetId)).groups.some((g) => g.id === groups.Kids), false);
  assert.deepEqual(app.pageErrors, []);
});

interface CardLook {
  /** The page's own background, as [r, g, b]. */
  pageBackground: number[];
  /** The month summary card's corners and shadow, which every card shares. */
  summaryCard: { radius: string; shadow: string };
  /** How many rows of column headers show, whether they sit on the first group's card, and the space between them and that group. */
  headerRows: number;
  headerOnFirstCard: boolean;
  headerToFirstGroup: number;
  /** Per group, in order: whether the surface under its row is its own, and that surface's corners and shadow. */
  cards: { name: string; own: boolean; radius: string; shadow: string }[];
  /** Between one group's card and the next: the space, and what shows in its middle across the card and under the Available column. */
  gaps: { above: string; gap: number; middle: number[]; availColumn: number[] }[];
  bucketGaps: number[];
  /** Rows whose Available cell (or Spent, where it shows) is not under the column's header. */
  misaligned: string[];
  /** Each group row's background behind its name as [r, g, b], with its hue in degrees. */
  groupBackgrounds: Record<string, { rgb: number[]; hue: number }>;
  groupAvail: number[];
  bucketBackground: number[];
  inkContrast: number[];
}

/** How the groups look: each on its own card with the page between, their tint against the page and a bucket row, and their text contrast. */
const cardLook = (page: Page): Promise<CardLook> => page.evaluate(() => {
  // Computed colours come as rgb(), rgba(), or color(srgb r g b / a) with 0-1 channels (from color-mix).
  const rgba = (value: string) => {
    const parts = (value.match(/[\d.]+/g) ?? []).map(Number);
    const scale = value.startsWith("color(srgb") ? 255 : 1;
    const [r = 0, g = 0, b = 0] = parts.map((part) => part * scale);
    return { r, g, b, a: value.startsWith("rgba") || value.includes("/") ? parts[3] ?? 1 : 1 };
  };
  // The colour behind an element: its own background over its ancestors' until one is opaque.
  const backgroundOf = (node: Element) => {
    const layers = [];
    for (let at: Element | null = node; at; at = at.parentElement) {
      const layer = rgba(getComputedStyle(at).backgroundColor);
      if (layer.a > 0) layers.push(layer);
      if (layer.a >= 1) break;
    }
    return layers.reverse().reduce((under, over) => ({
      r: over.r * over.a + under.r * (1 - over.a), g: over.g * over.a + under.g * (1 - over.a), b: over.b * over.a + under.b * (1 - over.a), a: 1,
    }), { r: 255, g: 255, b: 255, a: 1 });
  };
  // The surface a row sits on: its nearest ancestor with a background of its own.
  const surfaceOf = (row: Element) => {
    let at = row.parentElement;
    while (at && rgba(getComputedStyle(at).backgroundColor).a === 0) at = at.parentElement;
    return at!;
  };
  const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (text: Element) => {
    const [a, b] = [luminance(rgba(getComputedStyle(text).color)), luminance(backgroundOf(text))].sort((x, y) => y - x);
    return (a! + 0.05) / (b! + 0.05);
  };
  const triple = (c: { r: number; g: number; b: number }) => [c.r, c.g, c.b];
  const hue = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const shows = (node: Element) => node.getClientRects().length > 0;
  const box = (node: Element) => node.getBoundingClientRect();
  const table = document.querySelector('[role="table"][aria-label="Buckets"]')!;
  const rows = [...table.querySelectorAll<HTMLElement>('[role="row"]')].filter(shows);
  const headers = rows.filter((row) => row.querySelector('[role="columnheader"]'));
  const header = headers[0]!;
  const groups = rows.filter((row) => row.classList.contains("bgroup"));
  const nameOf = (group: Element) => group.querySelector(".gname")!.textContent ?? "";
  const surfaces = groups.map(surfaceOf);
  const summary = getComputedStyle(document.querySelector(".summary")!);
  const page = triple(backgroundOf(document.body));
  const columnX = (cell: Element) => box(cell).left + box(cell).width / 2;
  const behind = (x: number, y: number) => triple(backgroundOf(document.elementFromPoint(x, y)!));
  const columns = [".c.avail", ".c.spent"].map((selector) => ({ selector, head: header.querySelector(selector)! })).filter(({ head }) => shows(head));
  const firstGroup = groups[0]!;
  return {
    pageBackground: page,
    summaryCard: { radius: summary.borderRadius, shadow: summary.boxShadow },
    headerRows: headers.length,
    headerOnFirstCard: surfaceOf(header) === surfaces[0],
    headerToFirstGroup: box(firstGroup).top - box(header).bottom,
    cards: groups.map((group, index) => {
      const style = getComputedStyle(surfaces[index]!);
      return { name: nameOf(group), own: surfaces.indexOf(surfaces[index]!) === index, radius: style.borderRadius, shadow: style.boxShadow };
    }),
    gaps: surfaces.slice(1).map((card, index) => {
      const above = box(surfaces[index]!).bottom;
      const y = (above + box(card).top) / 2;
      // To the hundredth of a pixel: Firefox lays out in sixtieths, so a 20px gap can measure 19.99994.
      return { above: nameOf(groups[index + 1]!), gap: Math.round((box(card).top - above) * 100) / 100, middle: behind(box(card).left + box(card).width / 2, y), availColumn: behind(columnX(columns[0]!.head), y) };
    }),
    bucketGaps: rows.filter((row, index) => index > 0 && row.classList.contains("brow") && rows[index - 1]!.classList.contains("brow")).map((row) => box(row).top - box(rows[rows.indexOf(row) - 1]!).bottom),
    misaligned: rows.filter((row) => row !== header && columns.some(({ selector, head }) => {
      const cell = row.querySelector(`:scope > ${selector}`);
      return cell && shows(cell) && (Math.abs(box(cell).left - box(head).left) > 0.5 || Math.abs(box(cell).right - box(head).right) > 0.5);
    })).map((row) => row.textContent ?? ""),
    groupBackgrounds: Object.fromEntries(groups.map((group) => {
      const background = backgroundOf(group.querySelector(".gcell")!);
      return [nameOf(group), { rgb: triple(background), hue: hue(background) }];
    })),
    groupAvail: triple(backgroundOf(firstGroup.querySelector(".c.avail")!)),
    bucketBackground: triple(backgroundOf(table.querySelector(".brow .bname")!)),
    inkContrast: [...firstGroup.querySelectorAll(".gname, .gcount, .c.spent, .c.avail")].filter(shows).map(contrast),
  };
});

/** How far apart two colours are, as a straight line through RGB. */
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((channel, i) => channel - b[i]!));

test("each group is its own card with the page showing between, under one header, its row tinted apart from page and buckets, in both themes and at 390px", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t, { height: 1400 });
  const { page } = app;
  const { budgetId } = await seed(app, { kids: true });
  await openBuckets(app, budgetId);

  // One table, one header row, and each group a row group of its own row and buckets.
  const grid = page.getByRole("table", { name: "Buckets" });
  assert.equal(await grid.count(), 1);
  assert.deepEqual(await grid.getByRole("columnheader").allInnerTexts(), ["Bucket", "Target or goal", "Spent", "Add / take", "Available"]);
  assert.deepEqual(await grid.getByRole("rowgroup").evaluateAll((sections) => sections.map((section) => [...section.querySelectorAll('[role="row"]')]
    .map((row) => (row.querySelector(".gname, .name") ?? row.querySelector('[role="columnheader"], [role="cell"]'))?.textContent))),
  [["Bucket"], ["Fixed", "Rent", "Gym"], ["Everyday", "Groceries", "Dining out", "Fuel"], ["Goals", "Vacation"], ["Kids", "No buckets"]]);

  const cases = [
    { scheme: "light", width: 1280 }, { scheme: "dark", width: 1280 },
    { scheme: "light", width: 390 }, { scheme: "dark", width: 390 },
  ] as const;
  for (const { scheme, width } of cases) {
    const where = `${scheme} at ${width}px`;
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height: 1400 });
    const look = await cardLook(page);

    // Cards: one per group, shaped like the summary card, the header atop the first.
    assert.equal(look.headerRows, 1, `${where}: the column headers show once`);
    assert.ok(look.headerOnFirstCard, `${where}: the header sits atop the first group's card`);
    assert.ok(Math.abs(look.headerToFirstGroup) <= 0.5, `${where}: the first group follows the header (${look.headerToFirstGroup})`);
    assert.deepEqual(look.cards.map((card) => card.name), ["Fixed", "Everyday", "Goals", "Kids"]);
    for (const card of look.cards) {
      assert.ok(card.own, `${where}: ${card.name} has a card of its own`);
      assert.deepEqual({ radius: card.radius, shadow: card.shadow }, look.summaryCard, `${where}: ${card.name}'s card has the card radius and shadow`);
    }
    // Between cards, a real gap (about 20–24px) where the page shows, across the card and under the Available column.
    assert.deepEqual(look.gaps.map((gap) => gap.above), ["Everyday", "Goals", "Kids"]);
    for (const { above, gap, middle, availColumn } of look.gaps) {
      assert.ok(gap >= 20 && gap <= 24, `${where}: a 20–24px gap above ${above} (${gap})`);
      assert.ok(distance(middle, look.pageBackground) < 1, `${where}: the page shows in the gap above ${above} (${middle.join()})`);
      assert.ok(distance(availColumn, look.pageBackground) < 1, `${where}: the Available tint stops at the card above ${above} (${availColumn.join()})`);
    }
    for (const gap of look.bucketGaps) assert.ok(Math.abs(gap) <= 0.5, `${where}: bucket rows within a group touch (${gap})`);
    assert.deepEqual(look.misaligned, [], `${where}: every card's columns line up under the header`);

    // The group row's tint: clearly apart from the page (as far as dark's) and from a bucket row, in the cool family.
    const tint = look.groupBackgrounds.Fixed!;
    const fromPage = distance(tint.rgb, look.pageBackground);
    const fromBuckets = distance(tint.rgb, look.bucketBackground);
    assert.ok(fromPage >= 30, `${where}: a group row is tinted clearly apart from the page (${fromPage.toFixed(1)})`);
    assert.ok(fromBuckets >= 15, `${where}: a group row is tinted apart from a bucket row (${fromBuckets.toFixed(1)})`);
    // Its Available cell a shade deeper: apart from the row, and further from the page.
    assert.ok(distance(look.groupAvail, tint.rgb) >= 10, `${where}: the group's Available cell is a shade apart (${distance(look.groupAvail, tint.rgb).toFixed(1)})`);
    assert.ok(distance(look.groupAvail, look.pageBackground) > fromPage, `${where}: the group's Available cell is deeper than its row`);
    // Not the violet of Ready to assign (254°) or the overspent red (350°): the same 25° floor the bucket hues keep.
    const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    assert.ok(hueGap(tint.hue, 254) >= 25 && hueGap(tint.hue, 350) >= 25, `${where}: the tint stays clear of violet and red (${tint.hue.toFixed(0)}°)`);
    for (const ratio of look.inkContrast) assert.ok(ratio >= 4.5, `${where}: group row text keeps 4.5:1 on the tint (${ratio.toFixed(2)})`);

    if (width === 390) assert.equal(await noHorizontalScroll(page), true, where);
    else {
      // The drop target's highlight still shows on a tinted header (the tint is not the accent).
      const fuel = page.locator(".brow", { hasText: "Fuel" });
      await fuel.hover();
      const grip = (await fuel.locator("[data-grip]").boundingBox())!;
      await page.mouse.move(grip.x + 5, grip.y + 5);
      await page.mouse.down();
      await page.mouse.move(grip.x + 20, (await page.locator(".bgroup", { hasText: "Goals" }).boundingBox())!.y + 60, { steps: 8 });
      assert.deepEqual(await page.locator(".bgroup.drop-into .gname").allTextContents(), ["Goals"]);
      const lit = distance((await cardLook(page)).groupBackgrounds.Goals!.rgb, look.groupBackgrounds.Goals!.rgb);
      assert.ok(lit >= 12, `${where}: the drop target is lit clearly over the tint (${lit.toFixed(1)})`);
      await page.keyboard.press("Escape");
      await page.mouse.up();

      // A group's drop line sits in the gap between two cards, not on a card's edge.
      const kids = page.locator(".bgroup", { hasText: "Kids" });
      await kids.hover();
      const kidsGrip = (await kids.locator("[data-grip]").boundingBox())!;
      await page.mouse.move(kidsGrip.x + 5, kidsGrip.y + 5);
      await page.mouse.down();
      const everyday = (await page.locator(".bgroup", { hasText: "Everyday" }).boundingBox())!;
      await page.mouse.move(kidsGrip.x + 20, everyday.y + 2, { steps: 8 });
      const line = (await page.locator(".drop-line").boundingBox())!;
      const gym = (await page.locator(".brow", { hasText: "Gym" }).boundingBox())!;
      const lineY = line.y + line.height / 2;
      assert.ok(lineY > gym.y + gym.height + 4 && lineY < everyday.y - 4, `${where}: a group's drop line sits in the gap above Everyday (${lineY}, between ${gym.y + gym.height} and ${everyday.y})`);
      await page.keyboard.press("Escape");
      await page.mouse.up();
    }
  }
  assert.deepEqual(app.pageErrors, []);
});

/** Spends a bucket's whole month (10.00) and archives it, so it shows that month as an archived row. */
async function archiveWithActivity(app: App, budgetId: string, bucketId: string): Promise<void> {
  const thisMonth = new Date().toLocaleDateString("en-CA").slice(0, 7);
  const accounts = await api<{ id: string }[]>(app, "GET", `/api/budgets/${budgetId}/accounts`);
  const account = accounts[0] ?? await api<{ id: string }>(app, "POST", `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: `${thisMonth}-01` });
  await api(app, "POST", `/api/buckets/${bucketId}/assign`, { month: thisMonth, amount: 1_000 });
  await api(app, "POST", `/api/accounts/${account.id}/transactions`, { amount: -1_000, category: { kind: "bucket", bucketId } });
  await api(app, "POST", `/api/buckets/${bucketId}/archive`);
}

test("archived buckets whose group was deleted sit on a card of their own after the groups, which group drags pass over", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t, { height: 1000 });
  const { page } = app;
  const { budgetId, groups } = await seed(app);
  // Magazine: archived, still in Fixed. Club: archived, its group Old deleted since.
  const magazine = await api<Bucket>(app, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Magazine", groupId: groups.Fixed, colour: "olive", type: "plain" });
  const old = await api<Group>(app, "POST", `/api/budgets/${budgetId}/groups`, { name: "Old" });
  const club = await api<Bucket>(app, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Club", groupId: old.id, colour: "cocoa", type: "plain" });
  await archiveWithActivity(app, budgetId, magazine.id);
  await archiveWithActivity(app, budgetId, club.id);
  await api(app, "DELETE", `/api/groups/${old.id}`);
  await openBuckets(app, budgetId);
  const grid = page.getByRole("table", { name: "Buckets" });

  assert.deepEqual(await grid.getByRole("rowgroup").evaluateAll((sections) => sections.map((section) => [...section.querySelectorAll('[role="row"]')]
    .map((row) => (row.querySelector(".gname, .name") ?? row.querySelector('[role="columnheader"]'))?.textContent))),
  [["Bucket"], ["Fixed", "Rent", "Gym", "Magazine"], ["Everyday", "Groceries", "Dining out", "Fuel"], ["Goals", "Vacation"], ["Club"]]);
  const look = await cardLook(page);
  assert.equal(look.gaps.length, 2, "Fixed, Everyday and Goals are three cards");
  const clubRow = grid.locator(".brow", { hasText: "Club" });
  const goalsBottom = await grid.locator(".brow", { hasText: "Vacation" }).evaluate((row) => row.getBoundingClientRect().bottom);
  const clubBox = (await clubRow.boundingBox())!;
  assert.ok(clubBox.y - goalsBottom >= 20, `Club's card stands apart from Goals' (${clubBox.y - goalsBottom})`);
  assert.equal(await clubRow.evaluate((row) => getComputedStyle(row).borderTopWidth), "0px", "No line at the top of Club's card");

  // A group dragged past the end lands after the last group, with its line at that group's card.
  const fixed = grid.locator(".bgroup", { hasText: "Fixed" });
  await fixed.hover();
  const grip = (await fixed.locator("[data-grip]").boundingBox())!;
  await page.mouse.move(grip.x + 5, grip.y + 5);
  await page.mouse.down();
  await page.mouse.move(grip.x + 20, clubBox.y + clubBox.height + 10, { steps: 8 });
  const line = (await page.locator(".drop-line").boundingBox())!;
  assert.ok(Math.abs(line.y + line.height / 2 - goalsBottom) <= 2, `The line marks the end of Goals' card (${line.y + line.height / 2} vs ${goalsBottom})`);
  await page.mouse.up();
  await waitForSnack(page, "Moved the Fixed group down.");
  assert.deepEqual((await tableOf(app, budgetId)).groups.map((g) => g.name), ["Everyday", "Goals", "Fixed"]);

  // Phone Reorder hides archived rows, and with them Club's card. A group dragged high goes to the top, though
  // the last group (Fixed) ends in a hidden row.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Reorder" }).click();
  assert.equal(await clubRow.isVisible(), false);
  assert.equal(await grid.locator(".bcard").evaluateAll((cards) => cards.filter((card) => card.getClientRects().length > 0 && card.getBoundingClientRect().height === 0).length), 0, "No empty card shows");
  await drag(page, grid.locator(".bgroup", { hasText: "Goals" }), 20);
  await waitForSnack(page, "Moved the Goals group up.");
  assert.deepEqual((await tableOf(app, budgetId)).groups.map((g) => g.name), ["Goals", "Everyday", "Fixed"]);
  assert.deepEqual(app.pageErrors, []);
});

test("drag reorders within and across groups and into an empty group; Escape cancels; a group carries its buckets", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await seed(app, { kids: true });
  await openBuckets(app, budgetId);
  const grid = page.getByRole("table", { name: "Buckets" });
  const bucketRow = (name: string) => grid.locator(".brow", { hasText: name });
  const groupRow = (name: string) => grid.locator(".bgroup", { hasText: name });

  // Within a group: Fuel above Groceries.
  await drag(page, bucketRow("Fuel"), await rowTop(bucketRow("Groceries")));
  await waitForSnack(page, "Moved Fuel up.");
  assert.deepEqual((await order(app, budgetId)).Everyday, ["Fuel", "Groceries", "Dining out"]);
  assert.deepEqual(await grid.locator(".brow .name").allTextContents(), ["Rent", "Gym", "Fuel", "Groceries", "Dining out", "Vacation"]);
  assert.equal(await page.locator(".drag-ghost, .drop-line").count(), 0);

  // While dragging across groups: a lifted copy, a drop line, the source faded, the target group tinted.
  const fuel = bucketRow("Fuel");
  await fuel.hover();
  const grip = (await fuel.locator("[data-grip]").boundingBox())!;
  await page.mouse.move(grip.x + 5, grip.y + 5);
  await page.mouse.down();
  await page.mouse.move(grip.x + 20, (await groupRow("Goals").boundingBox())!.y + 60, { steps: 8 });
  assert.equal(await page.locator(".drag-ghost").count(), 1);
  assert.equal(await page.locator(".drop-line").isVisible(), true);
  assert.equal(await fuel.evaluate((node) => Number(getComputedStyle(node).opacity) < 1), true);
  assert.deepEqual(await grid.locator(".bgroup.drop-into .gname").allTextContents(), ["Goals"]);
  // Escape cancels: nothing saved, nothing left behind.
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await page.locator(".drag-ghost, .drop-line, .drop-into").count(), 0);
  assert.deepEqual((await order(app, budgetId)).Everyday, ["Fuel", "Groceries", "Dining out"]);
  assert.equal(await page.locator("#snack-msg").textContent(), "Moved Fuel up.");

  // Across groups: Fuel to the end of Goals.
  await drag(page, bucketRow("Fuel"), (await bucketRow("Vacation").boundingBox())!.y + 38);
  await waitForSnack(page, "Moved Fuel to Goals.");
  assert.deepEqual(await order(app, budgetId), { Fixed: ["Rent", "Gym"], Everyday: ["Groceries", "Dining out"], Goals: ["Vacation", "Fuel"], Kids: [] });

  // Into an empty group, onto its "No buckets" row.
  const empty = grid.locator(".bempty");
  const emptyBox = (await empty.boundingBox())!;
  await drag(page, bucketRow("Rent"), emptyBox.y + emptyBox.height / 2);
  await waitForSnack(page, "Moved Rent to Kids.");
  assert.deepEqual((await order(app, budgetId)).Kids, ["Rent"]);
  assert.equal(await grid.locator(".bempty").count(), 0);

  // A group row carries its buckets: Goals above Fixed.
  await drag(page, groupRow("Goals"), await rowTop(groupRow("Fixed")));
  await waitForSnack(page, "Moved the Goals group up.");
  assert.deepEqual((await tableOf(app, budgetId)).groups.map((g) => g.name), ["Goals", "Fixed", "Everyday", "Kids"]);
  assert.deepEqual(await order(app, budgetId), { Goals: ["Vacation", "Fuel"], Fixed: ["Gym"], Everyday: ["Groceries", "Dining out"], Kids: ["Rent"] });
  assert.deepEqual(await grid.locator(".bgroup .gname, .brow .name").allTextContents(),
    ["Goals", "Vacation", "Fuel", "Fixed", "Gym", "Everyday", "Groceries", "Dining out", "Kids", "Rent"]);

  // Undo of the group move.
  await page.locator("#snack-undo").click();
  await eventually(async () => assert.equal(await grid.locator(".bgroup .gname").first().textContent(), "Fixed"));
  assert.deepEqual((await tableOf(app, budgetId)).groups.map((g) => g.name), ["Fixed", "Everyday", "Goals", "Kids"]);
  assert.deepEqual(app.pageErrors, []);
});

test("Alt+arrows move rows across groups, keep focus, announce the position, and Undo moves back", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, buckets } = await seed(app);
  await openBuckets(app, budgetId);
  const gym = page.getByRole("button", { name: "Edit Gym" });
  assert.equal(await gym.getAttribute("aria-keyshortcuts"), "Alt+ArrowUp Alt+ArrowDown");

  // Gym is last in Fixed: Alt+Down crosses into Everyday, first place.
  await gym.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await waitForSnack(page, "Moved Gym to Everyday.");
  await announced(page, "Gym moved to Everyday, position 1 of 4.");
  assert.deepEqual(await order(app, budgetId), { Fixed: ["Rent"], Everyday: ["Gym", "Groceries", "Dining out", "Fuel"], Goals: ["Vacation"] });
  assert.equal(await focusedLabel(page), "Edit Gym");

  // Within the group.
  await page.keyboard.press("Alt+ArrowDown");
  await waitForSnack(page, "Moved Gym down.");
  await announced(page, "Gym moved to Everyday, position 2 of 4.");
  assert.deepEqual((await order(app, budgetId)).Everyday, ["Groceries", "Gym", "Dining out", "Fuel"]);
  assert.equal(await focusedLabel(page), "Edit Gym");

  // Undo is the inverse move.
  await page.locator("#snack-undo").click();
  await announced(page, "Gym moved to Everyday, position 1 of 4.");
  assert.deepEqual((await order(app, budgetId)).Everyday, ["Gym", "Groceries", "Dining out", "Fuel"]);
  assert.equal(await focusedLabel(page), "Edit Gym");

  // At the very top there is nowhere to go: nothing is saved and that is announced.
  await page.getByRole("button", { name: "Edit Rent" }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForFunction(() => /Rent/.test(document.getElementById("announce")?.textContent ?? "") && /first/.test(document.getElementById("announce")?.textContent ?? ""));
  assert.deepEqual((await order(app, budgetId)).Fixed, ["Rent"]);

  // Groups move with Alt+arrows on their menu button.
  await page.getByRole("button", { name: "Goals group actions" }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await waitForSnack(page, "Moved the Goals group up.");
  await announced(page, "Goals group moved to position 2 of 3.");
  assert.deepEqual((await tableOf(app, budgetId)).groups.map((g) => g.name), ["Fixed", "Goals", "Everyday"]);
  assert.equal(await focusedLabel(page), "Goals group actions");

  // An Undo whose target has changed since is refused with a reason, and nothing moves.
  await page.getByRole("button", { name: "Edit Fuel" }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await waitForSnack(page, "Moved Fuel up.");
  await api(app, "POST", `/api/buckets/${buckets.Fuel}/move`, { groupId: (await tableOf(app, budgetId)).groups[0]!.id, index: 0 });
  await page.locator("#snack-undo").click();
  await page.locator(".page > .note span").waitFor();
  assert.match(await page.locator(".page > .note").innerText(), /Fuel/);
  assert.deepEqual((await order(app, budgetId)).Fixed, ["Fuel", "Rent"]);
  assert.deepEqual(app.pageErrors, []);
});

test("available figures: positive and overspent rendering, and the archive section for each", { timeout: 45_000 }, async (t) => {
  for (const scheme of ["light", "dark"] as const) {
    const app = await openApp(t, { colorScheme: scheme, height: 800 });
    const { page } = app;
    const { budgetId, buckets } = await seed(app);
    // Groceries 186.53 and Vacation 1,240.00 assigned this month; Dining out overspent by 18.25.
    const thisMonth = new Date().toLocaleDateString("en-CA").slice(0, 7);
    const checking = await api<{ id: string }>(app, "POST", `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 200_000, startingDate: `${thisMonth}-01` });
    await api(app, "POST", `/api/buckets/${buckets.Groceries}/assign`, { month: thisMonth, amount: 18_653 });
    await api(app, "POST", `/api/buckets/${buckets.Vacation}/assign`, { month: thisMonth, amount: 124_000 });
    await api(app, "POST", `/api/accounts/${checking.id}/transactions`, { amount: -1_825, category: { kind: "bucket", bucketId: buckets["Dining out"] } });
    await openBuckets(app, budgetId);
    const grid = page.getByRole("table", { name: "Buckets" });
    const dining = grid.getByRole("row", { name: /Dining out/ });
    const groceries = grid.getByRole("row", { name: /Groceries/ });
    const over = scheme === "light" ? overLight : overDark;

    assert.equal(await dining.locator(".avail").textContent(), `${MINUS}18.25 overspent`, "Overspent is also said in words.");
    assert.equal(await colorOf(dining.locator(".avail")), over);
    assert.notEqual(await colorOf(groceries.locator(".avail")), over, "Red is only for overspent.");
    assert.equal(await groceries.locator(".avail").textContent(), "186.53");
    // Everyday total: 186.53 − 18.25 + 0.00 = 168.28.
    assert.equal(await grid.locator(".bgroup", { hasText: "Everyday" }).locator(".avail").textContent(), "168.28");
    // Vacation: 1,240.00 of 3,000.00 is 41%.
    assert.equal(await grid.getByRole("row", { name: /Vacation/ }).locator(".pct").textContent(), "41%");
    if (scheme === "dark") assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), darkBackground);

    const dialog = page.locator("dialog");
    await page.getByRole("button", { name: "Edit Dining out" }).click();
    const blocked = dialog.getByRole("button", { name: "Archive Dining out" });
    assert.equal(await blocked.isDisabled(), true);
    const why = dialog.locator(`#${await blocked.getAttribute("aria-describedby")}`);
    assert.equal(compact(await why.innerText()), `Can’t archive while Available is ${MINUS}18.25`);
    assert.equal(await colorOf(why.locator(".over")), over);
    assert.equal(await dialog.locator(".sheet-body").evaluate((node) => node.scrollHeight <= node.clientHeight), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Edit Groceries" }).click();
    assert.equal(compact(await dialog.locator(".arch-prev").innerText()), "Groceries 186.53 → 0.00 Ready to assign +186.53");
    assert.equal(await dialog.getByRole("button", { name: "Archive and return $186.53" }).isEnabled(), true);
    assert.equal(await dialog.locator(".sheet-body").evaluate((node) => node.scrollHeight <= node.clientHeight), true);
    // The positive path: the money goes back to Ready to assign (2,000.00 − 186.53 − 1,240.00 + 186.53), and
    // Undo restores the bucket without re-assigning it.
    assert.equal(compact(await page.getByRole("region", { name: "Month summary" }).locator(".ready-figure").innerText()), "$573.47");
    await dialog.getByRole("button", { name: "Archive and return $186.53" }).click();
    await dialog.waitFor({ state: "detached" });
    await waitForSnack(page, "Archived Groceries and returned $186.53.");
    await eventually(async () => assert.equal(compact(await page.getByRole("region", { name: "Month summary" }).locator(".ready-figure").innerText()), "$760.00"));
    assert.equal(await page.getByRole("button", { name: "Edit Groceries" }).count(), 0);
    await page.locator("#snack-undo").click();
    await eventually(async () => assert.equal(await grid.getByRole("row", { name: /Groceries/ }).locator(".avail").textContent(), "0.00"));
    assert.equal(compact(await page.getByRole("region", { name: "Month summary" }).locator(".ready-figure").innerText()), "$760.00");

    // Money assigned in a later month blocks archiving; the dialog says which month.
    const [year, monthNumber] = thisMonth.split("-").map(Number) as [number, number];
    const next = new Date(Date.UTC(year, monthNumber, 1));
    const nextMonth = next.toISOString().slice(0, 7);
    const nextName = next.toLocaleString("en-US", { month: "long", timeZone: "UTC" }) + (next.getUTCFullYear() === year ? "" : ` ${next.getUTCFullYear()}`);
    await api(app, "POST", `/api/buckets/${buckets.Vacation}/assign`, { month: nextMonth, amount: 1_000 });
    await page.getByRole("button", { name: "Edit Vacation" }).click();
    await dialog.getByRole("button", { name: "Archive and return $1,240.00" }).click();
    await eventually(async () => assert.equal(compact(await dialog.locator(".snote").innerText()), `Vacation has money assigned in ${nextName}.`));
    assert.equal(await page.getByRole("button", { name: "Edit Vacation" }).count(), 1);
    await page.keyboard.press("Escape");
    assert.deepEqual(app.pageErrors, []);
  }
});

test("at 390px: no horizontal scroll, Reorder mode with 44px move buttons and grip drag, and bottom sheets", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t, { width: 390, height: 844 });
  const { page } = app;
  const { budgetId } = await seed(app);
  await openBuckets(app, budgetId);
  assert.equal(await noHorizontalScroll(page), true);
  const grid = page.getByRole("table", { name: "Buckets" });

  // No grips until Reorder is on; the row opens the bucket sheet.
  assert.equal(await grid.locator("[data-grip]").first().isVisible(), false);
  const reorder = page.getByRole("button", { name: "Reorder" });
  assert.equal(await reorder.getAttribute("aria-pressed"), "false");
  const reorderBox = (await reorder.boundingBox())!;
  assert.ok(reorderBox.width >= 44 && reorderBox.height >= 44);

  // Dialog is a bottom sheet with 44px swatches.
  await page.getByRole("button", { name: "Add bucket" }).click();
  const dialog = page.locator("dialog");
  const sheet = (await dialog.boundingBox())!;
  assert.ok(Math.abs(sheet.y + sheet.height - 844) <= 1, "The sheet sits on the bottom edge.");
  for (const box of await dialog.getByRole("radio").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height })))) {
    assert.ok(box.w >= 44 && box.h >= 44, `swatch ${box.w}x${box.h}`);
  }
  assert.equal(await noHorizontalScroll(page), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  await reorder.click();
  const done = page.getByRole("button", { name: "Done" });
  assert.equal(await done.getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("button", { name: /^Edit / }).count(), 0, "Taps do not open Edit while reordering.");
  await grid.locator(".brow", { hasText: "Gym" }).click();
  assert.equal(await dialog.count(), 0);
  assert.equal(await page.getByRole("button", { name: "Move Rent up" }).getAttribute("aria-disabled"), "true");
  const up = page.getByRole("button", { name: "Move Fuel up" });
  const upBox = (await up.boundingBox())!;
  assert.ok(upBox.width >= 44 && upBox.height >= 44);
  assert.equal(await noHorizontalScroll(page), true);

  await up.click();
  await waitForSnack(page, "Moved Fuel up.");
  assert.deepEqual((await order(app, budgetId)).Everyday, ["Groceries", "Fuel", "Dining out"]);
  assert.equal(await focusedLabel(page), "Move Fuel up");
  await page.getByRole("button", { name: "Move Groceries up" }).click();
  await waitForSnack(page, "Moved Groceries to Fixed.");
  assert.deepEqual((await order(app, budgetId)).Fixed, ["Rent", "Gym", "Groceries"]);

  // Grip drag works in Reorder mode.
  // The summary strip sits above the table, so bring Rent to the top to have both rows on screen.
  await grid.locator(".brow", { hasText: "Rent" }).evaluate((row) => row.scrollIntoView({ block: "start" }));
  const vacation = grid.locator(".brow", { hasText: "Vacation" });
  await drag(page, vacation, await rowTop(grid.locator(".brow", { hasText: "Rent" })));
  await waitForSnack(page, "Moved Vacation to Fixed.");
  assert.deepEqual((await order(app, budgetId)).Fixed, ["Vacation", "Rent", "Gym", "Groceries"]);

  await done.click();
  assert.equal(await page.getByRole("button", { name: "Reorder" }).getAttribute("aria-pressed"), "false");
  assert.equal(await page.getByRole("button", { name: "Rent", exact: true }).count(), 1);
  assert.equal(await noHorizontalScroll(page), true);
  assert.deepEqual(app.pageErrors, []);
});

// ----- Corrections after review -----

const savedNote = /^Your change was saved, but the buckets could not refresh\. Reload to try again\.$/;
const pageNote = (page: Page) => page.locator(".page > .note");

/** Makes the page's table reads fail while `on()` is true; writes still reach the server. */
async function failTableReads(page: Page, on: () => boolean): Promise<void> {
  await page.route("**/api/budgets/*/buckets", async (route) => {
    if (on() && route.request().method() === "GET") await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Down." } } });
    else await route.continue();
  });
}

test("a move the server refuses keeps its message, changes nothing and keeps focus", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, groups } = await seed(app, { kids: true });
  await openBuckets(app, budgetId);
  // Kids is deleted elsewhere while this page still shows it as the drop below Vacation.
  await api(app, "DELETE", `/api/groups/${groups.Kids}`);
  await page.getByRole("button", { name: "Edit Vacation" }).focus();
  await page.keyboard.press("Alt+ArrowDown");

  // The page re-reads the table (Kids disappears) and the refusal stays on screen afterwards.
  await page.locator(`.bgroup[data-group-id="${groups.Kids}"]`).waitFor({ state: "detached" });
  await eventually(async () => assert.equal(compact(await pageNote(page).innerText()), "Group not found."));
  await page.waitForTimeout(300);
  assert.equal(compact(await pageNote(page).innerText()), "Group not found.");
  assert.equal(await focusedLabel(page), "Edit Vacation");
  assert.equal(await page.locator("#snack").isHidden(), true, "A refused move offers no Undo.");
  assert.deepEqual(await order(app, budgetId), {
    Fixed: ["Rent", "Gym"], Everyday: ["Groceries", "Dining out", "Fuel"], Goals: ["Vacation"],
  });
  assert.deepEqual(app.pageErrors, []);
});

test("a change that saved is reported as saved when the table cannot be re-read", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, buckets, groups } = await seed(app);
  let failing = false;
  await failTableReads(page, () => failing);
  await openBuckets(app, budgetId);
  const dialog = page.locator("dialog");
  const fresh = async () => {
    failing = false;
    await page.reload();
    await ready(page);
  };
  const bucketNamed = async (name: string) => (await tableOf(app, budgetId)).buckets.filter((b) => b.name === name);

  // Add: the dialog closes (nothing invites a second submit) and exactly one bucket exists.
  failing = true;
  await page.getByRole("button", { name: "Everyday group actions" }).click();
  await page.getByRole("menuitem", { name: "Add bucket to Everyday" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Books");
  await dialog.getByRole("radio", { name: "Plain" }).click();
  await dialog.getByRole("button", { name: "Add bucket" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.match(compact(await pageNote(page).innerText()), savedNote);
  assert.deepEqual((await bucketNamed("Books")).map((b) => [b.groupId, b.type]), [[groups.Everyday, "plain"]]);

  // A write the server refuses still shows its own message in the dialog, not "saved".
  await page.getByRole("button", { name: "Everyday group actions" }).click();
  await page.getByRole("menuitem", { name: "Add bucket to Everyday" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("books");
  await dialog.getByRole("radio", { name: "Plain" }).click();
  await dialog.getByRole("button", { name: "Add bucket" }).click();
  await dialog.locator(".snote span").waitFor();
  assert.match(await dialog.locator(".snote").innerText(), /already exists/);
  assert.equal((await bucketNamed("Books")).length, 1);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });

  // Edit: closes, saves once, and keeps a working Undo.
  await fresh();
  failing = true;
  await page.getByRole("button", { name: "Edit Gym" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Gym and pool");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  await waitForSnack(page, "Saved Gym and pool.");
  assert.match(compact(await pageNote(page).innerText()), savedNote);
  assert.deepEqual((await bucketNamed("Gym and pool")).map((b) => b.id), [buckets.Gym]);
  failing = false;
  await page.locator("#snack-undo").click();
  await eventually(async () => assert.deepEqual((await bucketNamed("Gym")).map((b) => b.id), [buckets.Gym]));
  await eventually(async () => assert.equal(compact(await pageNote(page).innerText()), ""), 2_000);

  // Move: saved once, the snackbar still offers Undo, and Undo moves it back.
  await fresh();
  failing = true;
  await page.getByRole("button", { name: "Edit Rent" }).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await waitForSnack(page, "Moved Rent down.");
  assert.match(compact(await pageNote(page).innerText()), savedNote);
  assert.deepEqual((await order(app, budgetId)).Fixed, ["Gym", "Rent"]);
  failing = false;
  await page.locator("#snack-undo").click();
  await eventually(async () => assert.deepEqual((await order(app, budgetId)).Fixed, ["Rent", "Gym"]));

  // Rename: the inline field closes and the row shows the saved name.
  await fresh();
  failing = true;
  await page.getByRole("button", { name: "Everyday group actions" }).click();
  await page.getByRole("menuitem", { name: "Rename group" }).click();
  await page.getByRole("textbox", { name: "Group name" }).fill("Daily");
  await page.keyboard.press("Enter");
  await waitForSnack(page, "Renamed Everyday to Daily.");
  assert.equal(await page.getByRole("textbox", { name: "Group name" }).count(), 0);
  assert.equal(await page.locator(`.bgroup[data-group-id="${groups.Everyday}"] .gname`).textContent(), "Daily");
  assert.match(compact(await pageNote(page).innerText()), savedNote);
  assert.deepEqual((await tableOf(app, budgetId)).groups.map((g) => g.name), ["Fixed", "Daily", "Goals"]);

  // Archive: the dialog closes and the bucket is archived once.
  await fresh();
  failing = true;
  await page.getByRole("button", { name: "Edit Fuel" }).click();
  await dialog.getByRole("button", { name: "Archive Fuel" }).click();
  await dialog.waitFor({ state: "detached" });
  await waitForSnack(page, "Archived Fuel.");
  assert.match(compact(await pageNote(page).innerText()), savedNote);
  assert.equal((await bucketNamed("Fuel"))[0]!.archived, true);

  // Restore from the fold.
  await fresh();
  failing = true;
  await page.locator("details.archived summary").click();
  await page.getByRole("button", { name: "Restore Fuel" }).click();
  await eventually(async () => assert.match(compact(await pageNote(page).innerText()), savedNote));
  assert.equal((await bucketNamed("Fuel"))[0]!.archived, false);
  assert.deepEqual(app.pageErrors, []);
});

test("Undo of an archive restores the bucket's position, or the end of the first group once its own is gone", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await seed(app);
  const spare = await api<Group>(app, "POST", `/api/budgets/${budgetId}/groups`, { name: "Spare" });
  const clothing = await api<Bucket>(app, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Clothing", groupId: spare.id, type: "plain" });
  await openBuckets(app, budgetId);
  const dialog = page.locator("dialog");

  // Rent was first in Fixed and Dining out is in the middle of Everyday: Undo puts each back where it was.
  await page.getByRole("button", { name: "Edit Rent" }).click();
  await dialog.getByRole("button", { name: "Archive Rent" }).click();
  await waitForSnack(page, "Archived Rent.");
  await page.locator("#snack-undo").click();
  await page.getByRole("button", { name: "Edit Rent" }).waitFor();
  assert.deepEqual((await order(app, budgetId)).Fixed, ["Rent", "Gym"]);
  await page.getByRole("button", { name: "Edit Dining out" }).click();
  await dialog.getByRole("button", { name: "Archive Dining out" }).click();
  await waitForSnack(page, "Archived Dining out.");
  assert.deepEqual((await order(app, budgetId)).Everyday, ["Groceries", "Fuel"]);
  await page.locator("#snack-undo").click();
  await eventually(async () => assert.deepEqual((await order(app, budgetId)).Everyday, ["Groceries", "Dining out", "Fuel"]));
  await eventually(async () => assert.deepEqual(await page.locator(".brow .name").allTextContents(), ["Rent", "Gym", "Groceries", "Dining out", "Fuel", "Vacation", "Clothing"]));

  // Clothing's group is deleted while it is archived: Undo puts it at the end of the first group.
  await page.getByRole("button", { name: "Edit Clothing" }).click();
  await dialog.getByRole("button", { name: "Archive Clothing" }).click();
  await waitForSnack(page, "Archived Clothing.");
  await api(app, "DELETE", `/api/groups/${spare.id}`);
  await page.locator("#snack-undo").click();
  await page.getByRole("button", { name: "Edit Clothing" }).waitFor();
  assert.deepEqual(await order(app, budgetId), {
    Fixed: ["Rent", "Gym", "Clothing"], Everyday: ["Groceries", "Dining out", "Fuel"], Goals: ["Vacation"],
  });
  const restored = (await tableOf(app, budgetId)).buckets.find((b) => b.id === clothing.id)!;
  assert.equal(restored.archived, false);
  assert.deepEqual(app.pageErrors, []);
});

test("Undo of a goal edit puts the goal back, and Undo of an edit that made a new group removes that group", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t, { height: 800 });
  const { page } = app;
  const { budgetId, buckets } = await seed(app);
  await openBuckets(app, budgetId);
  const dialog = page.locator("dialog");
  const bucketNow = async (name: string) => (await tableOf(app, budgetId)).buckets.find((b) => b.name === name)!;

  // The goal's amount and month change, then Undo restores both through the revert path.
  await page.getByRole("button", { name: "Edit Vacation" }).click();
  await dialog.getByLabel("Goal amount").fill("4,000.00");
  assert.equal((await goalMonthButton(dialog).innerText()).trim(), "Aug 2027", "Edit opens on the saved month.");
  await pickGoalMonth(page, dialog, "2028-03");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual([(await bucketNow("Vacation")).amount, (await bucketNow("Vacation")).goalMonth], [400000, "2028-03"]);
  await waitForSnack(page, "Saved Vacation.");
  await page.locator("#snack-undo").click();
  await eventually(async () => assert.deepEqual([(await bucketNow("Vacation")).amount, (await bucketNow("Vacation")).goalMonth], [300000, "2027-08"]));
  assert.equal(await page.locator("#snack").isHidden(), true, "Undo succeeded without an error.");

  // Moving Gym (second in Fixed) into a brand-new group creates it; Undo puts Gym back and deletes the empty group.
  await page.getByRole("button", { name: "Edit Gym" }).click();
  await dialog.getByRole("combobox").click();
  await dialog.getByRole("option", { name: "New group" }).click();
  await dialog.getByLabel("New group name").fill("Temp");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual((await order(app, budgetId)).Temp, ["Gym"]);
  await waitForSnack(page, "Saved Gym.");
  await page.locator("#snack-undo").click();
  await eventually(async () => assert.deepEqual(await order(app, budgetId), { Fixed: ["Rent", "Gym"], Everyday: ["Groceries", "Dining out", "Fuel"], Goals: ["Vacation"] }));
  await eventually(async () => assert.deepEqual(await page.locator(".bgroup .gname").allTextContents(), ["Fixed", "Everyday", "Goals"]));

  // If the new group has gained a bucket since, Undo still puts Gym back but leaves that group alone.
  await page.getByRole("button", { name: "Edit Gym" }).click();
  await dialog.getByRole("combobox").click();
  await dialog.getByRole("option", { name: "New group" }).click();
  await dialog.getByLabel("New group name").fill("Temp");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  await waitForSnack(page, "Saved Gym.");
  const temp = (await tableOf(app, budgetId)).groups.find((g) => g.name === "Temp")!;
  await api(app, "POST", `/api/buckets/${buckets.Rent}/move`, { groupId: temp.id, index: 0 });
  await page.locator("#snack-undo").click();
  await eventually(async () => assert.deepEqual((await order(app, budgetId)).Fixed, ["Gym"]));
  assert.deepEqual((await order(app, budgetId)).Temp, ["Rent"]);

  // An Undo of an edit to a bucket that has changed since is refused with a reason.
  await page.getByRole("button", { name: "Edit Gym" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Fitness");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  await waitForSnack(page, "Saved Fitness.");
  await api(app, "PATCH", `/api/buckets/${buckets.Gym}`, { colour: "plum" });
  await page.locator("#snack-undo").click();
  await eventually(async () => assert.equal(compact(await pageNote(page).innerText()), "Fitness has changed since, so the edit was not undone."));
  assert.equal((await bucketNow("Fitness")).name, "Fitness");
  assert.deepEqual(app.pageErrors, []);
});

test("a name that clashes with an archived bucket marks Name, even when it contains the word group", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, groups } = await seed(app);
  const old = await api<Bucket>(app, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Kids group", groupId: groups.Fixed, type: "plain" });
  await api(app, "POST", `/api/buckets/${old.id}/archive`);
  await openBuckets(app, budgetId);
  const dialog = page.locator("dialog");
  await page.getByRole("button", { name: "Everyday group actions" }).click();
  await page.getByRole("menuitem", { name: "Add bucket to Everyday" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("kids group");
  await dialog.getByRole("radio", { name: "Plain" }).click();
  await dialog.getByRole("button", { name: "Add bucket" }).click();
  await dialog.locator(".snote span").waitFor();
  assert.match(await dialog.locator(".snote").innerText(), /archived bucket is already named Kids group/);
  const nameField = dialog.getByLabel("Name", { exact: true });
  assert.equal(await nameField.getAttribute("aria-invalid"), "true");
  assert.equal(await nameField.evaluate((node) => node === document.activeElement), true);
  assert.equal(await dialog.getByRole("combobox").getAttribute("aria-invalid"), null);
  assert.deepEqual(app.pageErrors, []);
});

test("an archive Undo the server refuses shows why and leaves the bucket archived", { timeout: 30_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const budgetId = await seedBudget(app.url, "Solo");
  const only = await api<Group>(app, "POST", `/api/budgets/${budgetId}/groups`, { name: "Only" });
  const lamp = await api<Bucket>(app, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Lamp", groupId: only.id, type: "plain" });
  await openBuckets(app, budgetId);
  await page.getByRole("button", { name: "Edit Lamp" }).click();
  await page.locator("dialog").getByRole("button", { name: "Archive Lamp" }).click();
  await waitForSnack(page, "Archived Lamp.");
  // With no group left anywhere, a restore has nowhere to go.
  await api(app, "DELETE", `/api/groups/${only.id}`);
  await page.locator("#snack-undo").click();
  await eventually(async () => assert.equal(compact(await pageNote(page).innerText()), "Create a group first."));
  const stored = (await tableOf(app, budgetId)).buckets.find((b) => b.id === lamp.id)!;
  assert.equal(stored.archived, true);
  assert.deepEqual(app.pageErrors, []);
});

test("on a touch phone, only the grip drags in Reorder mode; swipes on rows scroll the page", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t, { width: 390, height: 600, touch: true });
  const { page } = app;
  const { budgetId } = await seed(app);
  await openBuckets(app, budgetId);
  const grid = page.getByRole("table", { name: "Buckets" });
  const seeded = { Fixed: ["Rent", "Gym"], Everyday: ["Groceries", "Dining out", "Fuel"], Goals: ["Vacation"] };
  // Playwright sends touch moves only to Chromium (through CDP), whose input pipeline turns them into scrolling and
  // pointer events as a phone's does. In WebKit and Firefox it can only tap: there a swipe is checked through the
  // touch-action that lets the browser scroll it, and the grip is dragged with the pointer events of a mouse.
  const cdp = engine === "chromium" ? await page.context().newCDPSession(page) : null;
  const touch = (type: string, points: { x: number; y: number }[]) => cdp!.send("Input.dispatchTouchEvent", { type: type as "touchStart", touchPoints: points });
  async function swipe(from: { x: number; y: number }, toY: number): Promise<void> {
    await touch("touchStart", [from]);
    for (let i = 1; i <= 10; i++) await touch("touchMove", [{ x: from.x, y: from.y + ((toY - from.y) * i) / 10 }]);
    // Hold still before lifting: after a flick, Chromium on Linux takes the next tap as stopping the fling, not a click.
    await page.waitForTimeout(200);
    await touch("touchEnd", []);
  }
  async function drag(from: { x: number; y: number }, toY: number): Promise<void> {
    if (cdp) return swipe(from, toY);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x, from.y + ((toY - from.y) * i) / 10);
    await page.mouse.up();
  }
  /** A vertical swipe on `locator` scrolls: it and every element around it leave vertical panning to the browser. */
  const pans = (locator: Locator) => locator.evaluate((node) => {
    for (let at: Element | null = node; at; at = at.parentElement) {
      const action = getComputedStyle(at).touchAction;
      if (!(action === "auto" || action === "manipulation" || action.includes("pan-y"))) return false;
    }
    return true;
  });
  const centre = async (locator: Locator) => {
    const box = (await locator.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const tap = async (locator: Locator) => {
    const point = await centre(locator);
    await page.touchscreen.tap(point.x, point.y);
  };
  const scrollY = () => page.evaluate(() => window.scrollY);

  // Reorder mode: a swipe up starting on a row's name scrolls the page and moves nothing.
  await page.getByRole("button", { name: "Reorder" }).tap();
  assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight), "The page is tall enough to scroll.");
  const fuel = grid.locator(".brow", { hasText: "Fuel" });
  if (cdp) {
    const fuelName = await centre(fuel.locator(".name"));
    await swipe(fuelName, fuelName.y - 150);
    await eventually(async () => assert.ok((await scrollY()) > 0, "The swipe scrolled the page."));
  } else {
    assert.equal(await pans(fuel.locator(".name")), true, "A swipe on a row's name scrolls the page.");
    assert.equal(await fuel.locator("[data-grip]").evaluate((node) => getComputedStyle(node).touchAction), "none", "A swipe on the grip drags.");
  }
  assert.equal(await page.locator(".drag-ghost").count(), 0);
  assert.deepEqual(await order(app, budgetId), seeded);

  // A tap on a row in Reorder mode opens nothing and moves nothing.
  await page.evaluate(() => window.scrollTo(0, 0));
  await tap(grid.locator(".brow", { hasText: "Gym" }).locator(".name"));
  await page.waitForTimeout(200);
  assert.equal(await page.locator("dialog").count(), 0);
  assert.equal(await page.locator("#snack").isHidden(), true);

  // A drag from Groceries' grip to just above Rent moves it, and the move is saved.
  await grid.locator(".brow", { hasText: "Rent" }).evaluate((row) => row.scrollIntoView({ block: "start" }));
  const grip = await centre(grid.locator(".brow", { hasText: "Groceries" }).locator("[data-grip]"));
  const rentTop = (await grid.locator(".brow", { hasText: "Rent" }).boundingBox())!.y + 2;
  await drag(grip, rentTop);
  await waitForSnack(page, "Moved Groceries to Fixed.");
  assert.deepEqual(await order(app, budgetId), { ...seeded, Fixed: ["Groceries", "Rent", "Gym"], Everyday: ["Dining out", "Fuel"] });

  // Out of Reorder mode there is no grip to drag; a swipe on a row scrolls, and a tap opens the bucket sheet.
  await page.getByRole("button", { name: "Done" }).tap();
  // The summary strip sits above the table; keep Gym on screen, low enough that the page can still scroll down.
  const showGym = () => grid.locator(".brow", { hasText: "Gym" }).evaluate((row) => row.scrollIntoView({ block: "end" }));
  await page.evaluate(() => window.scrollTo(0, 0));
  await showGym();
  const startY = await scrollY();
  const before = await order(app, budgetId);
  const gym = grid.locator(".brow", { hasText: "Gym" });
  assert.equal(await gym.locator("[data-grip]").isVisible(), false, "Out of Reorder mode there is no grip.");
  if (cdp) {
    const gymName = await centre(gym.locator(".name"));
    await swipe(gymName, gymName.y - 150);
    await eventually(async () => assert.ok((await scrollY()) > startY));
  } else {
    assert.equal(await pans(gym.locator(".name")), true, "A swipe on a row scrolls the page.");
  }
  assert.equal(await page.locator(".drag-ghost").count(), 0);
  assert.equal(await page.locator("dialog").count(), 0);
  assert.deepEqual(await order(app, budgetId), before);
  await grid.locator(".brow", { hasText: "Gym" }).evaluate((row) => row.scrollIntoView({ block: "center" }));
  await tap(grid.locator(".brow", { hasText: "Gym" }).locator(".name"));
  assert.equal(await page.locator("dialog").getByRole("heading").textContent(), "Gym");
  assert.deepEqual(app.pageErrors, []);
});
