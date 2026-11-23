import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";

const MINUS = "−";
const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const cells = async (row: Locator) => (await row.locator("[role=cell]").allInnerTexts()).map(compact);

async function api(url: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? undefined : response.json();
}

/** Checking at 1,000.00, Visa at −412.09 and Savings at 0, with an Everyday group holding Groceries. */
async function household(url: string) {
  const budgetId = await seedBudget(url, "Household");
  const checking = await api(url, "POST", `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" });
  const savings = await api(url, "POST", `/api/budgets/${budgetId}/accounts`, { name: "Savings", type: "savings", startingBalance: 0, startingDate: "2026-11-01" });
  const visa = await api(url, "POST", `/api/budgets/${budgetId}/accounts`, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });
  const everyday = await api(url, "POST", `/api/budgets/${budgetId}/groups`, { name: "Everyday" });
  const groceries = await api(url, "POST", `/api/budgets/${budgetId}/buckets`, { name: "Groceries", groupId: everyday.id, type: "plain", colour: "green" });
  return { budgetId, checking, savings, visa, groceries };
}

test("desktop: a transfer from the picker previews the other balance, and Recent activity shows it once", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, checking, groceries } = await household(app.url);
  await api(app.url, "POST", `/api/accounts/${checking.id}/transactions`, { payee: "Corner Shop", amount: -2_500, category: { kind: "bucket", bucketId: groceries.id } });
  await page.goto(`${app.url}/budgets/${budgetId}/accounts/${checking.id}`);
  await ready(page);

  const entry = page.locator("form.entry");
  const category = entry.getByRole("combobox", { name: "Category" });
  const amount = entry.getByLabel(/^Amount/);
  await category.click();
  const list = page.getByRole("listbox", { name: "Categories" });
  await list.waitFor();
  // Transfer accounts come last; from Checking, the card is first. This account is never offered.
  assert.deepEqual((await list.locator(".og, .opt").evaluateAll((nodes) => nodes.map((node) => node.classList.contains("og") ? node.textContent : (node as HTMLElement).innerText))).map(compact),
    ["Income", "Split", "Everyday", `Groceries ${MINUS}25.00`, "Transfer", `Visa ${MINUS}412.09`, "Savings 0.00"]);
  await category.fill("vis");
  await category.press("Enter");
  assert.equal(await category.inputValue(), "Transfer · Visa");

  const preview = entry.locator(".xfer-prev");
  await amount.fill("412.09");
  assert.equal(compact(await preview.innerText()), `Visa ${MINUS}412.09 → 0.00`);
  await amount.press("Enter");

  const rows = page.locator(".rrow");
  await rows.filter({ hasText: "To Visa" }).waitFor();
  assert.deepEqual((await cells(rows.first())).slice(2, 5), ["To Visa", "", `${MINUS}412.09`]);
  assert.equal(await preview.isHidden(), true);
  const sideVisa = page.locator("#side-accounts li.row", { hasText: "Visa" });
  assert.equal(compact(await sideVisa.innerText()), "Visa 0.00");

  // The other side shows in Visa's register.
  await sideVisa.getByRole("link").click();
  await ready(page);
  assert.deepEqual((await cells(page.locator(".rrow").first())).slice(2, 6), ["From Checking", "", "412.09", "0.00"]);

  // Recent activity on the Accounts overview: the transfer once, unsigned, with the path in the Account column.
  await page.goto(`${app.url}/budgets/${budgetId}/accounts`);
  await ready(page);
  const recent = page.getByRole("table", { name: "Recent activity" });
  const recentRows = recent.locator(".arow");
  assert.equal(await recentRows.count(), 2);
  assert.deepEqual((await cells(recentRows.first())).slice(1), ["", "Transfer", "Checking → Visa", "412.09"]);
  assert.deepEqual((await cells(recentRows.nth(1))).slice(1), ["Corner Shop", "Groceries", "Checking", `${MINUS}25.00`]);
  assert.equal(await recent.getByRole("link", { name: /View all/ }).count(), 0);

  // And on the Buckets page, without an Account column.
  await page.goto(`${app.url}/budgets/${budgetId}/buckets`);
  await ready(page);
  const bucketRecent = page.getByRole("table", { name: "Recent activity" }).locator(".arow");
  assert.equal(await bucketRecent.count(), 2);
  assert.deepEqual((await cells(bucketRecent.first())).slice(1), ["", "Transfer · Checking → Visa", "412.09"]);

  assert.equal(await noHorizontalScroll(page), true);
  assert.deepEqual(app.pageErrors, []);
  assert.deepEqual(app.foreignRequests, []);
});

test("undoing a transfer's delete restores the other side's own payee and memo", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, checking, savings } = await household(app.url);
  const sent = await api(app.url, "POST", `/api/accounts/${checking.id}/transactions`, { payee: "Rainy day", memo: "November", amount: -5_000, category: { kind: "transfer", accountId: savings.id } });
  const sideOf = async () => ((await api(app.url, "GET", `/api/accounts/${savings.id}/transactions`)).transactions as any[])[0];
  await api(app.url, "PATCH", `/api/transactions/${(await sideOf()).id}`, { payee: "From checking", memo: "Emergency fund" });
  await page.goto(`${app.url}/budgets/${budgetId}/accounts/${checking.id}`);
  await ready(page);

  await page.locator(".rrow", { hasText: "Rainy day" }).click();
  const editor = page.locator("form.edit");
  await editor.getByRole("button", { name: "Delete" }).click();
  await editor.waitFor({ state: "detached" });
  assert.equal(await sideOf(), undefined);
  const snack = page.locator("#snack");
  await snack.getByRole("button", { name: "Undo" }).click();
  await page.locator(".rrow", { hasText: "Rainy day" }).waitFor();

  const back = ((await api(app.url, "GET", `/api/accounts/${checking.id}/transactions`)).transactions as any[])[0];
  assert.deepEqual([back.payee, back.memo, back.amount], ["Rainy day", "November", -5_000]);
  assert.notEqual(back.id, sent.id);
  const other = await sideOf();
  assert.deepEqual([other.payee, other.memo, other.amount, other.category.transferId], ["From checking", "Emergency fund", 5_000, back.category.transferId]);
  assert.deepEqual(app.pageErrors, []);
});

test("phone: Recent activity fits 390px and the sheet's transfer shows its preview", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t, { width: 390, height: 844, touch: true });
  const { page } = app;
  const { budgetId, checking, savings } = await household(app.url);
  await api(app.url, "POST", `/api/accounts/${checking.id}/transactions`, { amount: -5_000, memo: "Rainy day", category: { kind: "transfer", accountId: savings.id } });
  await page.goto(`${app.url}/budgets/${budgetId}/accounts`);
  await ready(page);
  const row = page.getByRole("table", { name: "Recent activity" }).locator(".arow");
  assert.equal(await row.count(), 1);
  assert.match(compact(await row.innerText()), /Transfer.*Checking → Savings.*50\.00/);
  assert.equal(await noHorizontalScroll(page), true);

  await page.goto(`${app.url}/budgets/${budgetId}/accounts/${checking.id}`);
  await ready(page);
  await page.locator(".rrow").first().click();
  const sheet = page.locator("dialog.tx-sheet");
  await sheet.waitFor();
  assert.equal(await sheet.getByRole("combobox", { name: "Category" }).inputValue(), "Transfer · Savings");
  // Editing keeps the other side's current figure as the starting point.
  assert.equal(compact(await sheet.locator(".xfer-prev").innerText()), "Savings 0.00 → 50.00");
  await sheet.getByLabel("Amount").fill("60");
  assert.equal(compact(await sheet.locator(".xfer-prev").innerText()), "Savings 0.00 → 60.00");
  assert.equal(await noHorizontalScroll(page), true);
  assert.deepEqual(app.pageErrors, []);
});
