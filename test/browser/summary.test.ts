import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { noHorizontalScroll, openApp, ready, seedBudget } from "./harness.js";

const MINUS = "−";
const violet = { light: "rgb(90, 59, 194)", dark: "rgb(183, 163, 255)" }; // --unassigned
const over = { light: "rgb(179, 36, 59)", dark: "rgb(255, 150, 164)" }; // --over

const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
const colorOf = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).color);

// The browser shares the test machine's zone with the server, so "this month" agrees on both.
const now = new Date();
const monthOf = (offset: number) => {
  const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const current = monthOf(0);
const previous = monthOf(-1);

async function send(url: string, path: string, body: unknown, status = 201, method = "POST"): Promise<{ id: string; groupId?: string }> {
  const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()) as { id: string; groupId?: string };
}

/**
 * Checking at 5,000.00 from last month. This month: 1,000.00 income, Rent gets 1,650.00, Groceries spends 40.00
 * and is paid back 30.00. Ready to assign is 4,350.00; the strip reads Income 1,030.00, Assigned 1,680.00, Spent 40.00.
 */
async function household(url: string) {
  const budgetId = await seedBudget(url, "Household");
  const checking = await send(url, `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 500_000, startingDate: `${previous}-01` });
  const rent = await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Rent", newGroupName: "Fixed", type: "recurring", amount: 165_000 });
  const groceries = await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Groceries", newGroupName: "Everyday", type: "recurring", amount: 60_000 });
  const tx = (amount: number, category: unknown) => send(url, `/api/accounts/${checking.id}/transactions`, { date: `${current}-01`, amount, category });
  await tx(100_000, { kind: "income" });
  await send(url, `/api/buckets/${rent.id}/assign`, { month: current, amount: 165_000 }, 200);
  await tx(-4_000, { kind: "bucket", bucketId: groceries.id });
  await tx(3_000, { kind: "bucket", bucketId: groceries.id });
  const overdraw = () => send(url, `/api/accounts/${checking.id}`, { startingBalance: -100_000 }, 200, "PATCH");
  return { budgetId, overdraw };
}

const strip = (page: Page) => page.getByRole("region", { name: "Month summary" });
const stat = async (page: Page, label: string) => compact(await strip(page).locator(".stat", { hasText: label }).locator(".figure").innerText());
const readyFigure = (page: Page) => strip(page).locator(".ready-figure");

test("the Buckets page's summary strip shows Ready to assign, and Income, Assigned and Spent for the month", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, overdraw } = await household(app.url);
  await page.goto(`${app.url}/budgets/${budgetId}/buckets`);
  await ready(page);

  assert.equal(compact(await readyFigure(page).innerText()), "$4,350.00");
  assert.equal(compact(await readyFigure(page).locator(".cents").innerText()), ".00");
  assert.equal(await colorOf(readyFigure(page)), violet.light);
  // The reimbursement counts on both sides; Spent stays gross.
  assert.deepEqual([await stat(page, "Income"), await stat(page, "Assigned"), await stat(page, "Spent")], ["$1,030.00", "$1,680.00", "$40.00"]);
  // The sidebar's stopgap is gone.
  assert.equal(await page.locator("#side-ready").count(), 0);

  // Last month: nothing moved, and Ready to assign is the same pool.
  await page.locator(".month-head").getByRole("button", { name: "Previous month" }).click();
  await ready(page);
  assert.equal(compact(await readyFigure(page).innerText()), "$4,350.00");
  assert.deepEqual([await stat(page, "Income"), await stat(page, "Assigned"), await stat(page, "Spent")], ["$0.00", "$0.00", "$0.00"]);

  // Below zero: the overspent red with a true minus.
  await overdraw();
  await page.reload();
  await ready(page);
  assert.equal(compact(await readyFigure(page).innerText()), `${MINUS}$1,650.00`);
  assert.equal(await colorOf(readyFigure(page)), over.light);
  assert.deepEqual(app.pageErrors, []);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the summary strip at 390px in the ${scheme} theme sits in the first screen`, { timeout: 45_000 }, async (t) => {
    const app = await openApp(t, { colorScheme: scheme, width: 390, height: 844 });
    const { page } = app;
    const { budgetId, overdraw } = await household(app.url);
    await page.goto(`${app.url}/budgets/${budgetId}/buckets`);
    await ready(page);
    const box = (await strip(page).boundingBox())!;
    assert.ok(box.y >= 0 && box.y + box.height <= 844, `strip at ${box.y}+${box.height}`);
    assert.ok(box.width <= 390 - 32 + 1);
    assert.equal(await colorOf(readyFigure(page)), violet[scheme]);
    assert.deepEqual([await stat(page, "Income"), await stat(page, "Assigned"), await stat(page, "Spent")], ["$1,030.00", "$1,680.00", "$40.00"]);
    assert.equal(await noHorizontalScroll(page), true);
    await overdraw();
    await page.reload();
    await ready(page);
    assert.equal(compact(await readyFigure(page).innerText()), `${MINUS}$1,650.00`);
    assert.equal(await colorOf(readyFigure(page)), over[scheme]);
    assert.equal(await noHorizontalScroll(page), true);
    assert.deepEqual(app.pageErrors, []);
  });
}
