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

/**
 * Checking at 9,000.00, with Rent (recurring 1,650, all assigned this month) beside the goals. Vacation (3,000 by
 * nine months on: ten months, 300 a month) has 100 this month. Laptop (1,800 over six months: 300 a month) has all
 * 300. Bike (600) was saved in full last month. Camera (400) is due next month. House deposit (25,000 over twenty
 * months: 1,250 a month) has 1,000, the widest figures.
 */
async function goals(url: string) {
  const budgetId = await seedBudget(url, "Household");
  await send(url, `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 900_000, startingDate: `${previous.key}-01` });
  const rent = await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Rent", newGroupName: "Fixed", type: "recurring", amount: 165_000 });
  const goal = (name: string, amount: number, months: number, groupId?: string) =>
    send(url, `/api/budgets/${budgetId}/buckets`, { name, ...(groupId ? { groupId } : { newGroupName: "Goals" }), type: "goal", amount, goalMonth: monthOf(months).key });
  const vacation = await goal("Vacation", 300_000, 9);
  const laptop = await goal("Laptop", 180_000, 5, vacation.groupId);
  const bike = await goal("Bike", 60_000, 4, vacation.groupId);
  await goal("Camera", 40_000, 1, vacation.groupId);
  const house = await goal("House deposit", 2_500_000, 19, vacation.groupId);
  const assign = (id: string, month: string, amount: number) => send(url, `/api/buckets/${id}/assign`, { month, amount }, 200);
  await assign(rent.id, current.key, 165_000);
  await assign(vacation.id, current.key, 10_000);
  await assign(laptop.id, current.key, 30_000);
  await assign(bike.id, previous.key, 60_000);
  await assign(house.id, current.key, 100_000);
  return { budgetId };
}

const shareOf = (page: Page, name: string) => rowOf(page, name).locator(".goal-share");
const shareText = async (page: Page, name: string) => compact(await shareOf(page, name).innerText());

/** The share's line: below everything else in the target, one line high, not cut off, and inside its row. */
async function assertShareLine(page: Page, name: string): Promise<void> {
  const layout = await shareOf(page, name).evaluate((share) => {
    const box = share.getBoundingClientRect();
    const row = share.closest(".brow")!.getBoundingClientRect();
    const above = [...share.parentElement!.children].filter((other) => other !== share && getComputedStyle(other).display !== "none")
      .map((other) => other.getBoundingClientRect().bottom);
    return {
      lineHeight: parseFloat(getComputedStyle(share).lineHeight) || parseFloat(getComputedStyle(share).fontSize) * 1.5,
      height: box.height, top: box.top, bottom: box.bottom, right: box.right, aboveBottom: Math.max(...above),
      rowBottom: row.bottom, rowRight: row.right, clipped: share.scrollWidth > share.clientWidth,
    };
  });
  assert.ok(layout.top >= layout.aboveBottom - 0.5, `${name}'s share sits on its own line below the goal (${layout.top} vs ${layout.aboveBottom})`);
  assert.ok(layout.height < layout.lineHeight * 1.5, `${name}'s share is one line (${layout.height}px)`);
  assert.equal(layout.clipped, false, `${name}'s share is not cut off`);
  assert.ok(layout.bottom <= layout.rowBottom && layout.right <= layout.rowRight, `${name}'s share stays inside its row`);
}

test("a goal row shows the month's share of its goal in a recurring row's words, recomputed in each month", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t, { height: 800 });
  const { page } = app;
  const { budgetId } = await goals(app.url);
  await page.goto(`${app.url}/budgets/${budgetId}/buckets`);
  await ready(page);

  // Short of the share, this month's assigned leads in bold; exactly met, only the share. A reached goal has none.
  assert.equal(await shareText(page, "Vacation"), "$100.00 of $300.00 a month");
  assert.equal(await shareOf(page, "Vacation").locator(".fund").textContent(), "$100.00");
  assert.equal(await shareText(page, "Laptop"), "$300.00 a month");
  assert.equal(await shareOf(page, "Laptop").locator(".fund").count(), 0);
  assert.equal(await shareText(page, "Camera"), "$0.00 of $200.00 a month");
  assert.equal(await shareText(page, "House deposit"), "$1,000.00 of $1,250.00 a month");
  assert.equal(await shareOf(page, "Bike").count(), 0);
  assert.equal(await barLabel(page, "Bike"), "100% saved toward a $600.00 goal");
  assert.equal(compact(await rowOf(page, "Vacation").locator(".gmeta").innerText()), `of $3,000.00 · ${monthOf(9).label.replace(/^(\w{3})\w*/, "$1")}`);
  assert.equal(await cell(page, "Rent", "det"), "$1,650.00 a month");
  for (const name of ["Vacation", "Laptop", "Camera", "House deposit"]) await assertShareLine(page, name);

  // Next month the share is worked out again from what carried in: 2,900 over nine months is 322.22…, rounded up.
  await page.locator(".month-head").getByRole("button", { name: "Next month" }).click();
  await ready(page);
  assert.equal(compact(await page.locator(".month-head .month-label").innerText()), monthOf(1).label);
  assert.equal(await shareText(page, "Vacation"), "$0.00 of $322.23 a month");
  assert.equal(await shareText(page, "Laptop"), "$0.00 of $300.00 a month");
  assert.equal(await shareText(page, "Camera"), "$0.00 of $400.00 a month");

  // Overdue, Camera still wants all of what's left in one month.
  await page.goto(`${app.url}/budgets/${budgetId}/buckets?month=${monthOf(3).key}`);
  await ready(page);
  assert.equal(await shareText(page, "Camera"), "$0.00 of $400.00 a month");
  assert.deepEqual(app.pageErrors, []);
});

test("on a phone a goal's share is its own line under its date, and nothing wraps or scrolls sideways", { timeout: 60_000 }, async (t) => {
  for (const scheme of ["light", "dark"] as const) {
    const app = await openApp(t, { colorScheme: scheme, width: 390, height: 844, touch: true });
    const { page } = app;
    const { budgetId } = await goals(app.url);
    await page.goto(`${app.url}/budgets/${budgetId}/buckets`);
    await ready(page);
    const phoneRow = (name: string) => page.locator(".brow", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
    const share = (name: string) => phoneRow(name).locator(".goal-share");
    assert.equal(compact(await share("Vacation").innerText()), "$100.00 of $300.00 a month");
    assert.equal(compact(await share("House deposit").innerText()), "$1,000.00 of $1,250.00 a month");
    assert.equal(await share("Bike").count(), 0);
    for (const name of ["Vacation", "Laptop", "Camera", "House deposit"]) {
      const [shareTop, dateBottom] = await Promise.all([
        share(name).evaluate((node) => node.getBoundingClientRect().top),
        phoneRow(name).locator(".goal-date").evaluate((node) => node.getBoundingClientRect().bottom),
      ]);
      assert.ok(shareTop >= dateBottom - 0.5, `${name}'s share is under its date (${shareTop} vs ${dateBottom})`);
      const fits = await share(name).evaluate((node) => {
        const box = node.getBoundingClientRect();
        const row = node.closest(".brow")!.getBoundingClientRect();
        return { oneLine: box.height < parseFloat(getComputedStyle(node).fontSize) * 2, clipped: node.scrollWidth > node.clientWidth, inside: box.bottom <= row.bottom && box.right <= row.right };
      });
      assert.deepEqual(fits, { oneLine: true, clipped: false, inside: true }, name);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "No sideways scroll");
    assert.deepEqual(app.pageErrors, []);
  }
});
