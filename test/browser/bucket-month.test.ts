import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";

const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();

// The browser shares the test machine's zone with the server, so "this month" agrees on both.
const now = new Date();
const monthOf = (offset: number) => {
  const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return { key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`, label: date.toLocaleDateString("en-US", { month: "long", year: "numeric" }) };
};
const current = monthOf(0);
const previous = monthOf(-1);

async function send(url: string, path: string, body: unknown, status = 201): Promise<{ id: string; groupId?: string }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()) as { id: string; groupId?: string };
}

/**
 * Checking at 5,000.00. Last month: Groceries (recurring 600) got 600 and spent 640, Vacation (goal 3,000) got 300.
 * This month: Groceries gets 300 and Rent (recurring 1,650) gets all 1,650.
 */
async function household(url: string) {
  const budgetId = await seedBudget(url, "Household");
  const checking = await send(url, `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 500_000, startingDate: `${previous.key}-01` });
  const rent = await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Rent", newGroupName: "Fixed", type: "recurring", amount: 165_000 });
  const groceries = await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Groceries", newGroupName: "Everyday", type: "recurring", amount: 60_000 });
  const vacation = await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Vacation", groupId: groceries.groupId, type: "goal", amount: 300_000, goalMonth: monthOf(10).key });
  const assign = (id: string, month: string, amount: number) => send(url, `/api/buckets/${id}/assign`, { month, amount }, 200);
  await assign(groceries.id, previous.key, 60_000);
  await assign(vacation.id, previous.key, 30_000);
  await send(url, `/api/accounts/${checking.id}/transactions`, { date: `${previous.key}-12`, payee: "Market", amount: -64_000, category: { kind: "bucket", bucketId: groceries.id } });
  await assign(groceries.id, current.key, 30_000);
  await assign(rent.id, current.key, 165_000);
  return { budgetId };
}

const rowOf = (page: Page, name: string) => page.locator(".brow", { has: page.getByRole("button", { name: `Edit ${name}` }) });
const cell = async (page: Page, name: string, column: string) => compact(await rowOf(page, name).locator(`.c.${column}`).innerText());
const groupCell = async (page: Page, name: string, column: string) => compact(await page.locator(".bgroup", { hasText: name }).locator(`.c.${column}`).innerText());
const vesselLabel = (page: Page, name: string) => rowOf(page, name).locator(".vessel").getAttribute("aria-label");
const barLabel = (page: Page, name: string) => rowOf(page, name).locator(".bar").getAttribute("aria-label");

test("the Buckets page shows a month's Spent, Available, vessels and goal bars, and month navigation updates them", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await household(app.url);
  await page.goto(`${app.url}/budgets/${budgetId}/buckets`);
  await ready(page);

  const table = page.getByRole("table", { name: "Buckets" });
  assert.deepEqual((await table.getByRole("columnheader").allInnerTexts()).map(compact).filter(Boolean), ["Bucket", "Target or goal", "Spent", "Add / take", "Available"]);

  // This month: Groceries carries in −40.00 and gets 300.00, so it holds 260.00; Rent's vessel is full.
  assert.equal(compact(await page.locator(".month-head .month-label").innerText()), current.label);
  assert.equal(await cell(page, "Groceries", "spent"), "0.00");
  assert.equal(await cell(page, "Groceries", "avail"), "260.00");
  assert.equal(await vesselLabel(page, "Groceries"), "50% of this month’s target assigned");
  assert.match(await cell(page, "Groceries", "det"), /\$300\.00 of \$600\.00 a month/);
  assert.equal(await vesselLabel(page, "Rent"), "Monthly target met");
  assert.equal(await cell(page, "Rent", "det"), "$1,650.00 a month");
  assert.equal(await barLabel(page, "Vacation"), "10% saved toward a $3,000.00 goal");
  assert.equal(await groupCell(page, "Everyday", "spent"), "0.00");
  assert.equal(await groupCell(page, "Everyday", "avail"), "560.00");

  // Last month: Groceries was overspent by 40.00, Rent was empty, and Vacation already held 300.00.
  await page.locator(".month-head").getByRole("button", { name: "Previous month" }).click();
  await ready(page);
  assert.equal(compact(await page.locator(".month-head .month-label").innerText()), previous.label);
  assert.equal(new URL(page.url()).searchParams.get("month"), previous.key);
  assert.equal(await cell(page, "Groceries", "spent"), "640.00");
  assert.equal(await cell(page, "Groceries", "avail"), "−40.00 overspent");
  assert.ok(await rowOf(page, "Groceries").evaluate((row) => row.classList.contains("is-over")));
  assert.equal(await vesselLabel(page, "Groceries"), "Monthly target met");
  assert.equal(await vesselLabel(page, "Rent"), "0% of this month’s target assigned");
  assert.equal(await cell(page, "Rent", "avail"), "0.00");
  assert.equal(await barLabel(page, "Vacation"), "10% saved toward a $3,000.00 goal");
  assert.equal(await groupCell(page, "Everyday", "spent"), "640.00");
  assert.equal(await groupCell(page, "Everyday", "avail"), "260.00");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Previous month");

  // Next month: nothing assigned or spent yet, so every vessel is empty and balances carry in.
  await page.goto(`${app.url}/budgets/${budgetId}/buckets?month=${monthOf(1).key}`);
  await ready(page);
  assert.equal(await vesselLabel(page, "Rent"), "0% of this month’s target assigned");
  assert.equal(await cell(page, "Rent", "avail"), "1,650.00");
  assert.equal(await cell(page, "Groceries", "avail"), "260.00");
  assert.equal(await cell(page, "Groceries", "spent"), "0.00");

  // The chosen month is kept when moving to Accounts.
  await page.getByRole("link", { name: "Accounts" }).first().click();
  await ready(page);
  assert.equal(new URL(page.url()).searchParams.get("month"), monthOf(1).key);
  assert.deepEqual(app.pageErrors, []);
});
