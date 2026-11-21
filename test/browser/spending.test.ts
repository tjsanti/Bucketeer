import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";

const MINUS = "−";
const over = { light: "rgb(179, 36, 59)", dark: "rgb(255, 150, 164)" }; // --over

const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
const colorOf = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).color);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const cells = async (row: Locator) => (await row.locator("[role=cell]").allInnerTexts()).map(compact);

function localDate(daysAgo = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
}
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const label = (date: Date) => date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

async function api(url: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? undefined : response.json();
}

/** Checking at 1,000.00 and Visa at −412.09, with Everyday (Eating out, Groceries) and Fixed (Rent, plus an archived Old). */
async function household(url: string) {
  const budgetId = await seedBudget(url, "Household");
  const checking = await api(url, "POST", `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" });
  const visa = await api(url, "POST", `/api/budgets/${budgetId}/accounts`, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });
  const everyday = await api(url, "POST", `/api/budgets/${budgetId}/groups`, { name: "Everyday" });
  const fixed = await api(url, "POST", `/api/budgets/${budgetId}/groups`, { name: "Fixed" });
  const eatingOut = await api(url, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Eating out", groupId: everyday.id, type: "plain", colour: "peach" });
  const groceries = await api(url, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Groceries", groupId: everyday.id, type: "plain", colour: "green" });
  const rent = await api(url, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Rent", groupId: fixed.id, type: "plain", colour: "sky" });
  const old = await api(url, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Old", groupId: fixed.id, type: "plain" });
  await api(url, "POST", `/api/buckets/${old.id}/archive`);
  return { budgetId, checking, visa, eatingOut, groceries, rent };
}

test("desktop entry: the category picker, the sign control, payee history, a highlighted new row and Undo", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, checking, visa, groceries } = await household(app.url);
  await api(app.url, "POST", `/api/accounts/${checking.id}/transactions`, { date: iso(localDate(3)), payee: "Corner Shop", amount: -2_500, category: { kind: "bucket", bucketId: groceries.id } });
  await page.goto(`${app.url}/budgets/${budgetId}/accounts/${visa.id}`);
  await ready(page);

  const entry = page.locator("form.entry");
  const payee = entry.getByLabel("Payee");
  const category = entry.getByRole("combobox", { name: "Category" });
  const amount = entry.getByLabel(/^Amount/);
  const sign = entry.locator("button.sign");
  assert.equal(await category.inputValue(), "");
  assert.equal(await sign.textContent(), MINUS);

  // The picker: Income and Split first, then each group's active buckets with Available; archived buckets never appear.
  await category.click();
  const list = page.getByRole("listbox", { name: "Categories" });
  await list.waitFor();
  assert.deepEqual((await list.locator(".og, .opt").evaluateAll((nodes) => nodes.map((node) => node.classList.contains("og") ? node.textContent : (node as HTMLElement).innerText))).map(compact),
    ["Income", "Split", "Everyday", "Eating out 0.00", "Groceries " + MINUS + "25.00", "Fixed", "Rent 0.00"]);
  assert.equal(await colorOf(list.locator(".opt", { hasText: "Groceries" }).locator(".ov")), over.light);
  // Typing filters; the arrows and Enter pick without saving the row.
  await category.fill("eat");
  assert.deepEqual((await list.locator(".opt").allInnerTexts()).map(compact), ["Eating out 0.00"]);
  await category.press("Enter");
  assert.equal(await category.inputValue(), "Eating out");
  assert.equal(await list.isHidden(), true);
  assert.equal(await page.locator(".rrow").count(), 0);

  // Typing + or - flips the sign rather than entering it.
  await amount.click();
  await amount.pressSequentially("+12");
  assert.deepEqual([await sign.textContent(), await amount.inputValue()], ["+", "12"]);
  await amount.press("-");
  assert.equal(await sign.textContent(), MINUS);
  await sign.click();
  assert.equal(await sign.textContent(), "+");
  await sign.click();
  await payee.fill("Noodle Bar");
  await amount.press("Enter");

  const rows = page.locator(".rrow");
  await rows.first().waitFor();
  assert.deepEqual((await cells(rows.first())).slice(1), ["Noodle Bar", "Eating out", "", `${MINUS}12.00`, `${MINUS}424.09`]);
  assert.equal(await rows.first().evaluate((node) => node.classList.contains("just-saved")), true);
  assert.equal(compact(await page.locator(".acct-summary").innerText()), `Balance ${MINUS}$424.09`);
  // Ready to assign doesn't move for spending.
  assert.equal(compact(await page.locator("#side-ready").innerText()), "Ready to assign $587.91");
  // Enter readied the next row: the category clears with the rest.
  assert.deepEqual([await payee.inputValue(), await category.inputValue(), await amount.inputValue()], ["", "", ""]);

  // Payee history fills in the last category.
  await payee.fill("corner shop");
  assert.equal(await category.inputValue(), "Groceries");
  await amount.fill("5");
  await amount.press("Enter");
  await rows.nth(1).waitFor();
  // A new row lands at the top of its date.
  assert.deepEqual((await cells(rows.first())).slice(1, 3), ["corner shop", "Groceries"]);

  // Undo in the snackbar deletes the new transaction.
  const snack = page.locator("#snack");
  assert.equal(compact(await snack.locator(".msg").innerText()), "Added corner shop.");
  await snack.getByRole("button", { name: "Undo" }).click();
  await page.locator(".rrow").nth(1).waitFor({ state: "detached" });
  assert.deepEqual((await cells(rows.first())).slice(1, 3), ["Noodle Bar", "Eating out"]);

  // No category is a neutral note, not a save.
  await payee.fill("Mystery");
  await amount.fill("1");
  await amount.press("Enter");
  await page.locator(".page > .note").filter({ hasText: "Choose a category." }).waitFor();
  assert.equal(await rows.count(), 1);

  // Filing to a bucket that the server refuses keeps the draft and says why.
  assert.equal(await noHorizontalScroll(page), true);
  assert.deepEqual(app.pageErrors, []);
  assert.deepEqual(app.foreignRequests, []);
});

test("desktop: clicking a row edits it in place, and Undo restores an edit and re-adds a delete", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, visa, eatingOut, rent } = await household(app.url);
  const dinner = await api(app.url, "POST", `/api/accounts/${visa.id}/transactions`, { date: iso(localDate(2)), payee: "Noodle Bar", memo: "Friday", amount: -12_000, category: { kind: "bucket", bucketId: eatingOut.id } });
  // Rent is archived after its transaction: the transaction keeps it, and its memo can still change.
  await api(app.url, "POST", `/api/accounts/${visa.id}/transactions`, { date: iso(localDate(4)), payee: "Landlord", amount: -100, category: { kind: "bucket", bucketId: rent.id } });
  await api(app.url, "POST", `/api/accounts/${visa.id}/transactions`, { date: iso(localDate(4)), payee: "Landlord", amount: 100, category: { kind: "bucket", bucketId: rent.id } });
  await api(app.url, "POST", `/api/buckets/${rent.id}/archive`);
  await page.goto(`${app.url}/budgets/${budgetId}/accounts/${visa.id}`);
  await ready(page);
  const rows = page.locator(".rrow");
  assert.equal(await rows.count(), 3);

  await rows.first().click();
  const editor = page.locator("form.edit");
  await editor.waitFor();
  assert.equal(await page.locator(".rrow").count(), 2);
  assert.deepEqual([await editor.getByLabel("Payee").inputValue(), await editor.getByRole("combobox", { name: "Category" }).inputValue(),
    await editor.getByLabel("Memo").inputValue(), await editor.getByLabel(/^Amount/).inputValue(), await editor.locator("button.sign").textContent()],
  ["Noodle Bar", "Eating out", "Friday", "120.00", MINUS]);
  await editor.getByLabel(/^Amount/).fill("95.5");
  await editor.getByLabel("Memo").fill("Shared");
  await editor.getByLabel("Memo").press("Enter");
  await editor.waitFor({ state: "detached" });
  assert.deepEqual((await cells(rows.first())).slice(1, 5), ["Noodle Bar", "Eating out", "Shared", `${MINUS}95.50`]);
  assert.equal(compact(await page.locator(".acct-summary").innerText()), `Balance ${MINUS}$507.59`);
  const snack = page.locator("#snack");
  assert.equal(compact(await snack.locator(".msg").innerText()), "Saved Noodle Bar.");
  await snack.getByRole("button", { name: "Undo" }).click();
  await page.locator(".rrow", { hasText: "Friday" }).waitFor();
  assert.deepEqual((await cells(rows.first())).slice(1, 5), ["Noodle Bar", "Eating out", "Friday", `${MINUS}120.00`]);
  const restored = await api(app.url, "GET", `/api/transactions/${dinner.id}`);
  assert.deepEqual([restored.amount, restored.memo], [-12_000, "Friday"]);

  // Escape cancels an edit; the archived bucket keeps its name in the row and its memo can change.
  const landlord = rows.filter({ hasText: "Landlord" }).first();
  assert.equal((await cells(landlord))[2], "Rent");
  await landlord.click();
  await editor.waitFor();
  assert.equal(await editor.getByRole("combobox", { name: "Category" }).inputValue(), "Rent");
  await editor.getByLabel("Memo").fill("Deposit");
  await editor.getByLabel("Memo").press("Escape");
  await editor.waitFor({ state: "detached" });
  assert.equal(await rows.filter({ hasText: "Deposit" }).count(), 0);
  await rows.filter({ hasText: "Landlord" }).first().click();
  await editor.getByLabel("Memo").fill("Deposit");
  await editor.getByRole("button", { name: "Save" }).click();
  await rows.filter({ hasText: "Deposit" }).waitFor();

  // Delete, then Undo re-adds it.
  await rows.first().click();
  await editor.getByRole("button", { name: "Delete" }).click();
  await editor.waitFor({ state: "detached" });
  assert.equal(await rows.count(), 2);
  assert.equal(compact(await snack.locator(".msg").innerText()), "Deleted Noodle Bar.");
  await snack.getByRole("button", { name: "Undo" }).click();
  await rows.nth(2).waitFor();
  assert.deepEqual((await cells(rows.first())).slice(1, 5), ["Noodle Bar", "Eating out", "Friday", `${MINUS}120.00`]);
  assert.deepEqual(app.pageErrors, []);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the Buckets page shows real Available, overspent in red with a left rule (${scheme})`, { timeout: 45_000 }, async (t) => {
    const app = await openApp(t, { colorScheme: scheme });
    const { page } = app;
    const { budgetId, visa, checking, eatingOut, groceries } = await household(app.url);
    await api(app.url, "POST", `/api/accounts/${visa.id}/transactions`, { amount: -12_000, category: { kind: "bucket", bucketId: eatingOut.id } });
    await api(app.url, "POST", `/api/accounts/${checking.id}/transactions`, { amount: 3_000, category: { kind: "bucket", bucketId: eatingOut.id } });
    await api(app.url, "POST", `/api/accounts/${checking.id}/transactions`, { amount: 2_000, category: { kind: "bucket", bucketId: groceries.id } });
    await page.goto(`${app.url}/budgets/${budgetId}/buckets`);
    await ready(page);
    const grid = page.getByRole("table", { name: "Buckets" });
    const eating = grid.getByRole("row", { name: /Eating out/ }).locator(".avail");
    assert.equal(await eating.textContent(), `${MINUS}90.00 overspent`);
    assert.equal(await colorOf(eating), over[scheme]);
    assert.match(await eating.evaluate((node) => getComputedStyle(node).boxShadow), /inset/);
    const fine = grid.getByRole("row", { name: /Groceries/ }).locator(".avail");
    assert.equal(await fine.textContent(), "20.00");
    assert.notEqual(await colorOf(fine), over[scheme]);
    assert.deepEqual(app.pageErrors, []);
  });
}

test("phone: the bottom sheet adds (Save and add another, Save and close) and edits, with Undo and 44px targets", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t, { width: 390, height: 844, touch: true });
  const { page } = app;
  const { budgetId, visa } = await household(app.url);
  await page.goto(`${app.url}/budgets/${budgetId}/accounts/${visa.id}`);
  await ready(page);
  assert.equal(await page.locator("form.entry").isVisible(), false);
  const add = page.getByRole("button", { name: "New transaction" });
  const addBox = (await add.boundingBox())!;
  assert.ok(addBox.height >= 44);
  assert.ok(Math.abs(addBox.y + addBox.height + 12 - 844) <= 2, "The add bar sits on the bottom edge.");
  await add.tap();

  const sheet = page.getByRole("dialog", { name: "New transaction" });
  await sheet.waitFor();
  const box = (await sheet.boundingBox())!;
  assert.ok(Math.abs(box.y + box.height - 844) <= 1, "The sheet sits on the bottom edge.");
  // Amount first, focused, with Out | In beside it.
  const amount = sheet.getByLabel("Amount");
  assert.equal(await page.evaluate(() => document.activeElement?.id), await amount.getAttribute("id"));
  const outIn = sheet.getByRole("radiogroup", { name: "Out or in" });
  assert.equal(await outIn.getByRole("radio", { name: "Out" }).getAttribute("aria-checked"), "true");
  assert.equal(compact(await sheet.locator(".sstat").innerText()), "Visa");
  await amount.fill("12");
  await sheet.getByLabel("Payee").fill("Noodle Bar");
  const category = sheet.getByRole("combobox", { name: "Category" });
  await category.tap();
  const options = sheet.getByRole("listbox", { name: "Categories" });
  await options.waitFor();
  await options.getByRole("option", { name: /Eating out/ }).tap();
  assert.equal(await category.inputValue(), "Eating out");
  await sheet.getByLabel("Memo").fill("Lunch");
  for (const target of [amount, sheet.getByLabel("Payee"), category, sheet.getByLabel("Date"), sheet.getByLabel("Memo"),
    outIn.getByRole("radio", { name: "Out" }), sheet.getByRole("button", { name: "Save and add another" }), sheet.getByRole("button", { name: "Save and close" }),
    sheet.getByRole("button", { name: "Close", exact: true })]) {
    const size = (await target.boundingBox())!;
    assert.ok(size.height >= 44 && size.width >= 44, `${await target.evaluate((node) => node.outerHTML.slice(0, 60))} is ${size.width}x${size.height}`);
  }
  const date = await sheet.getByLabel("Date").inputValue();
  await sheet.getByRole("button", { name: "Save and add another" }).tap();

  // Saved feedback and Undo stay inside the sheet; the date is kept and the fields clear.
  const status = sheet.locator(".sstat");
  await status.filter({ hasText: "Added Noodle Bar." }).waitFor();
  assert.deepEqual([await amount.inputValue(), await sheet.getByLabel("Payee").inputValue(), await category.inputValue(), await sheet.getByLabel("Date").inputValue()], ["", "", "", date]);
  assert.equal(await page.locator("#snack").isVisible(), false);
  const rows = page.locator(".rrow");
  assert.equal(await rows.count(), 1);
  await status.getByRole("button", { name: "Undo" }).tap();
  await status.filter({ hasText: "Undid Noodle Bar." }).waitFor();
  assert.equal(await rows.count(), 0);

  // In, then Save and close: the snackbar offers Undo.
  await outIn.getByRole("radio", { name: "In" }).tap();
  await amount.fill("30");
  await sheet.getByLabel("Payee").fill("Friend");
  await category.tap();
  await options.getByRole("option", { name: /Eating out/ }).tap();
  await sheet.getByRole("button", { name: "Save and close" }).tap();
  await sheet.waitFor({ state: "detached" });
  await rows.first().waitFor();
  assert.equal(compact(await rows.first().locator(".amt").innerText()), "30.00");
  const snack = page.locator("#snack");
  assert.equal(compact(await snack.locator(".msg").innerText()), "Added Friend.");
  const snackBox = (await snack.boundingBox())!;
  assert.ok(snackBox.y + snackBox.height <= addBox.y, "The snackbar never covers the add bar.");
  assert.equal(await noHorizontalScroll(page), true);

  // Tapping a row edits it in the sheet; Save offers Undo, and so does Delete.
  await rows.first().tap();
  const edit = page.getByRole("dialog", { name: "Edit transaction" });
  await edit.waitFor();
  assert.equal(await edit.getByRole("radio", { name: "In" }).getAttribute("aria-checked"), "true");
  await edit.getByLabel("Amount").fill("25");
  await edit.getByRole("button", { name: "Save", exact: true }).tap();
  await edit.waitFor({ state: "detached" });
  await rows.filter({ hasText: "25.00" }).waitFor();
  await snack.getByRole("button", { name: "Undo" }).tap();
  await rows.filter({ hasText: "30.00" }).first().waitFor();
  await rows.first().tap();
  await edit.getByRole("button", { name: "Delete" }).tap();
  await edit.waitFor({ state: "detached" });
  assert.equal(await rows.count(), 0);
  await snack.getByRole("button", { name: "Undo" }).tap();
  await rows.first().waitFor();
  assert.equal(compact(await rows.first().locator(".amt").innerText()), "30.00");
  assert.deepEqual(app.pageErrors, []);
});
