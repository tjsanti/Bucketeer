import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";

const MINUS = "−";
const over = "rgb(179, 36, 59)"; // --over, light

const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
const colorOf = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).color);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const cells = async (row: Locator) => (await row.locator("[role=cell]").allInnerTexts()).map(compact);
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function api(url: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? undefined : response.json();
}

/** Visa at −412.09 with Everyday (Groceries, Household, Clothing). */
async function household(url: string) {
  const budgetId = await seedBudget(url, "Household");
  const visa = await api(url, "POST", `/api/budgets/${budgetId}/accounts`, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });
  const everyday = await api(url, "POST", `/api/budgets/${budgetId}/groups`, { name: "Everyday" });
  const bucket = (name: string, colour: string) => api(url, "POST", `/api/budgets/${budgetId}/buckets`, { name, groupId: everyday.id, type: "plain", colour });
  const groceries = await bucket("Groceries", "green");
  const household = await bucket("Household", "sky");
  const clothing = await bucket("Clothing", "peach");
  const available = async (bucketId: string) => (await api(url, "GET", `/api/buckets/${bucketId}`)).available;
  return { budgetId, visa, groceries, household, clothing, available };
}

test("desktop: build a split, Left to assign reaches 0.00, the note clears, and editing a split offers Undo", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, visa, groceries, household: home, available } = await household(app.url);
  await page.goto(`${app.url}/budgets/${budgetId}/accounts/${visa.id}`);
  await ready(page);

  const entry = page.locator("form.entry");
  const category = entry.getByRole("combobox", { name: "Category" });
  const amount = entry.getByLabel(/^Amount/);
  await entry.getByLabel("Payee").fill("Superstore");
  await amount.fill("80");

  // Split sits after Income; picking it shows two lines and moves to the first line's bucket.
  await category.click();
  const list = page.getByRole("listbox", { name: "Categories" });
  assert.deepEqual((await list.locator(".opt").allInnerTexts()).map(compact).slice(0, 2), ["Income", "Split"]);
  await list.getByRole("option", { name: "Split" }).click();
  assert.equal(await category.inputValue(), "Split");
  const splits = entry.getByRole("group", { name: "Split lines" });
  assert.equal(await splits.getByRole("group", { name: /^Split line \d$/ }).count(), 2);
  const left = splits.locator(".sleft");
  assert.equal(compact(await left.innerText()), "Left to assign 80.00");
  const bucket1 = splits.getByRole("combobox", { name: "Split line 1 bucket" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Split line 1 bucket");

  // A line's picker offers buckets only: never Income or Split.
  await bucket1.click();
  assert.deepEqual((await list.locator(".opt").allInnerTexts()).map(compact), ["Groceries 0.00", "Household 0.00", "Clothing 0.00"]);
  await bucket1.fill("groc");
  await bucket1.press("Enter");
  const amount1 = splits.getByLabel("Split line 1 amount");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Split line 1 amount");
  await amount1.fill("50");
  assert.equal(compact(await left.innerText()), "Left to assign 30.00");
  const bucket2 = splits.getByRole("combobox", { name: "Split line 2 bucket" });
  await bucket2.fill("house");
  await bucket2.press("Enter");
  const amount2 = splits.getByLabel("Split line 2 amount");
  await amount2.fill("20");
  assert.equal(compact(await left.innerText()), "Left to assign 10.00");

  // Saving short is a neutral note with an alert icon, under the lines, covering no field.
  await amount2.press("Enter");
  const note = splits.locator(".snote");
  await note.filter({ hasText: "Split lines total $70.00. $10.00 left to assign to a bucket." }).waitFor();
  assert.equal(await note.locator("svg").count(), 1);
  assert.notEqual(await colorOf(note), over);
  const noteBox = (await note.boundingBox())!;
  for (const field of await entry.locator("input, button").all()) {
    const box = await field.boundingBox();
    if (box) assert.ok(!overlaps(noteBox, box), "The note covers no field.");
  }
  assert.equal(await page.locator(".rrow").count(), 0);
  // It updates as the lines change and clears once they sum.
  await amount2.fill("25");
  assert.equal(compact(await note.innerText()), "Split lines total $75.00. $5.00 left to assign to a bucket.");
  await amount2.fill("30");
  assert.equal(compact(await left.innerText()), "Left to assign 0.00");
  assert.equal(compact(await note.innerText()), "");

  await amount2.press("Enter");
  const rows = page.locator(".rrow");
  await rows.first().waitFor();
  assert.deepEqual((await cells(rows.first())).slice(1), ["Superstore", "Groceries, Household", "", `${MINUS}80.00`, `${MINUS}492.09`]);
  assert.equal(await rows.first().locator(".cat .dot").count(), 2);
  assert.deepEqual([await available(groceries.id), await available(home.id)], [-5_000, -3_000]);
  // The entry row is ready again, without lines.
  assert.equal(await splits.isHidden(), true);

  // Editing a split: its lines come back with amounts; a new line takes what's left.
  await rows.first().click();
  const editor = page.locator("form.edit");
  await editor.waitFor();
  const editLines = editor.getByRole("group", { name: "Split lines" });
  assert.equal(await editor.getByRole("combobox", { name: "Category" }).inputValue(), "Split");
  assert.deepEqual([await editLines.getByRole("combobox", { name: "Split line 1 bucket" }).inputValue(), await editLines.getByLabel("Split line 1 amount").inputValue(),
    await editLines.getByRole("combobox", { name: "Split line 2 bucket" }).inputValue(), await editLines.getByLabel("Split line 2 amount").inputValue()],
  ["Groceries", "50.00", "Household", "30.00"]);
  await editLines.getByLabel("Split line 1 amount").fill("40");
  await editLines.getByRole("button", { name: "Add line" }).click();
  assert.equal(await editLines.getByLabel("Split line 3 amount").inputValue(), "10.00");
  const bucket3 = editLines.getByRole("combobox", { name: "Split line 3 bucket" });
  await bucket3.fill("cloth");
  await bucket3.press("Enter");
  assert.equal(compact(await editLines.locator(".sleft").innerText()), "Left to assign 0.00");
  await editor.getByRole("button", { name: "Save" }).click();
  await editor.waitFor({ state: "detached" });
  assert.equal((await cells(rows.first()))[2], "Groceries, Household, Clothing");
  assert.deepEqual([await available(groceries.id), await available(home.id)], [-4_000, -3_000]);

  const snack = page.locator("#snack");
  assert.equal(compact(await snack.locator(".msg").innerText()), "Saved Superstore.");
  await snack.getByRole("button", { name: "Undo" }).click();
  await rows.filter({ hasText: "Groceries, Household" }).filter({ hasNotText: "Clothing" }).waitFor();
  assert.deepEqual([await available(groceries.id), await available(home.id)], [-5_000, -3_000]);

  // Payee history brings back the split's buckets without amounts.
  await entry.getByLabel("Payee").fill("superstore");
  assert.equal(await category.inputValue(), "Split");
  assert.deepEqual([await bucket1.inputValue(), await amount1.inputValue(), await bucket2.inputValue(), await amount2.inputValue()], ["Groceries", "", "Household", ""]);
  // Picking a bucket instead drops the lines.
  await category.fill("cloth");
  await category.press("Enter");
  assert.equal(await splits.isHidden(), true);

  assert.equal(await noHorizontalScroll(page), true);
  assert.deepEqual(app.pageErrors, []);
});

for (const scheme of ["light", "dark"] as const) {
  test(`phone: build a split in the sheet with 44px targets, Left to assign reaches 0.00 and it saves (${scheme})`, { timeout: 60_000 }, async (t) => {
    const app = await openApp(t, { width: 390, height: 844, touch: true, colorScheme: scheme });
    const { page } = app;
    const { budgetId, visa, groceries, household: home, available } = await household(app.url);
    await page.goto(`${app.url}/budgets/${budgetId}/accounts/${visa.id}`);
    await ready(page);
    await page.getByRole("button", { name: "New transaction" }).tap();
    const sheet = page.getByRole("dialog", { name: "New transaction" });
    await sheet.waitFor();
    await sheet.getByLabel("Amount").fill("80");
    await sheet.getByLabel("Payee").fill("Superstore");
    const category = sheet.getByRole("combobox", { name: "Category" });
    await category.tap();
    const options = sheet.getByRole("listbox", { name: "Categories" });
    await options.getByRole("option", { name: "Split" }).tap();
    const splits = sheet.getByRole("group", { name: "Split lines" });
    await splits.waitFor();
    const left = splits.locator(".sleft");
    assert.equal(compact(await left.innerText()), "Left to assign 80.00");

    for (const [index, name, dollars] of [[1, "Groceries", "50"], [2, "Household", "30"]] as const) {
      const bucket = splits.getByRole("combobox", { name: `Split line ${index} bucket` });
      await bucket.tap();
      const lineOptions = splits.getByRole("listbox", { name: "Categories" });
      assert.deepEqual((await lineOptions.locator(".opt .on").allInnerTexts()), ["Groceries", "Household", "Clothing"]);
      await lineOptions.getByRole("option", { name: new RegExp(name) }).tap();
      assert.equal(await bucket.inputValue(), name);
      await splits.getByLabel(`Split line ${index} amount`).fill(dollars);
    }
    assert.equal(compact(await left.innerText()), "Left to assign 0.00");
    for (const target of [splits.getByRole("combobox", { name: "Split line 1 bucket" }), splits.getByLabel("Split line 1 amount"), splits.getByRole("button", { name: "Add line" })]) {
      const size = (await target.boundingBox())!;
      assert.ok(size.height >= 44, `${await target.evaluate((node) => node.outerHTML.slice(0, 60))} is ${size.height} tall`);
    }
    assert.equal(await noHorizontalScroll(page), true);
    const sheetBox = (await sheet.boundingBox())!;
    assert.ok(sheetBox.width <= 390);

    // Short lines are refused in the sheet with the split's note; it clears once they sum.
    await splits.getByLabel("Split line 2 amount").fill("20");
    await sheet.getByRole("button", { name: "Save and close" }).tap();
    const note = splits.locator(".snote");
    await note.filter({ hasText: "$10.00 left to assign" }).waitFor();
    await splits.getByLabel("Split line 2 amount").fill("30");
    assert.equal(compact(await note.innerText()), "");

    await sheet.getByRole("button", { name: "Save and close" }).tap();
    await sheet.waitFor({ state: "detached" });
    const row = page.locator(".rrow").first();
    await row.waitFor();
    assert.equal(compact(await row.locator(".amt").innerText()), `${MINUS}80.00`);
    assert.match(compact(await row.locator(".sub").innerText()), /^Groceries, Household · /);
    assert.deepEqual([await available(groceries.id), await available(home.id)], [-5_000, -3_000]);
    assert.equal(await noHorizontalScroll(page), true);
    assert.deepEqual(app.pageErrors, []);
  });
}
