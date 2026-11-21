import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";

const MINUS = "−";
const violet = { light: "rgb(90, 59, 194)", dark: "rgb(183, 163, 255)" }; // --unassigned
const over = { light: "rgb(179, 36, 59)", dark: "rgb(255, 150, 164)" }; // --over

const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
const colorOf = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).color);
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** A date in the browser's zone, which the test machine shares with the server, `daysAgo` before today. */
function localDate(daysAgo = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
}
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const today = () => iso(localDate());
// Six days back stays inside the budget's 12-month window and sorts before today.
const earlier = iso(localDate(6));
const earlierLabel = localDate(6).toLocaleDateString("en-US", { month: "short", day: "numeric" });

async function post(url: string, path: string, body: unknown): Promise<{ id: string }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as { id: string };
}

async function household(url: string) {
  const budgetId = await seedBudget(url, "Household");
  const checking = await post(url, `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: "2026-11-01" });
  const visa = await post(url, `/api/budgets/${budgetId}/accounts`, { name: "Visa", type: "credit-card", startingBalance: -41_209, startingDate: "2026-11-01" });
  return { budgetId, checking, visa };
}

test("income entered in the register updates the register, the account balance and Ready to assign", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, checking } = await household(app.url);
  await page.goto(`${app.url}/budgets/${budgetId}/accounts`);
  await ready(page);

  // Ready to assign sits above Accounts in the sidebar, violet: starting balances count, the card's debt reduces it.
  const readyFigure = page.locator("#side-ready .figure");
  assert.equal(compact(await page.locator("#side-ready").innerText()), "Ready to assign $587.91");
  assert.equal(await colorOf(readyFigure), violet.light);
  const sideTop = async (selector: string) => (await page.locator(selector).boundingBox())!.y;
  assert.ok(await sideTop("#side-ready") < await sideTop("#side-accounts"));

  // The sidebar and the overview link to each account's register.
  await page.locator("#side-list").getByRole("link", { name: "Checking" }).click();
  await ready(page);
  assert.equal(new URL(page.url()).pathname, `/budgets/${budgetId}/accounts/${checking.id}`);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Checking");
  assert.equal(await page.locator("#nav-accounts").getAttribute("aria-current"), "page");
  assert.equal(await page.title(), "Checking · Household · Bucketeer");
  assert.equal(compact(await page.locator(".acct-summary").innerText()), "Balance $1,000.00");

  const register = page.getByRole("table", { name: "Checking register" });
  assert.deepEqual((await register.getByRole("columnheader").allInnerTexts()).map(compact), ["Date", "Payee", "Category", "Memo", "Amount", "Balance"]);
  assert.equal(await register.locator(".rrow").count(), 0);
  assert.equal(compact(await register.locator(".reg-end").innerText()), "Starting balance 1,000.00");

  // The entry row is always ready: date defaults to today and the category is Income.
  const entry = page.locator("form.entry");
  const date = entry.getByLabel("Date");
  const payee = entry.getByLabel("Payee");
  const memo = entry.getByLabel("Memo");
  const amount = entry.getByLabel("Amount");
  assert.equal(await date.inputValue(), today());
  assert.equal(await entry.getByLabel("Category").inputValue(), "Income");

  await date.fill(earlier);
  await payee.fill("Acme Payroll");
  await memo.fill("November");
  await amount.fill("2,000");
  await amount.press("Enter");
  const rows = register.locator(".rrow");
  await rows.first().waitFor();
  const cells = async (row: Locator) => (await row.locator("[role=cell]").allInnerTexts()).map(compact);
  assert.deepEqual(await cells(rows.first()), [earlierLabel, "Acme Payroll", "Income", "November", "2,000.00", "3,000.00"]);
  // Enter saved and readied the next row: same date, cleared fields, focus back at the start.
  assert.deepEqual([await date.inputValue(), await payee.inputValue(), await memo.inputValue(), await amount.inputValue()], [earlier, "", "", ""]);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Payee");
  assert.equal(compact(await page.locator(".acct-summary").innerText()), "Balance $3,000.00");
  assert.equal(compact(await page.locator("#side-list li.row").first().innerText()), "Checking 3,000.00");
  assert.equal(compact(await page.locator("#side-ready").innerText()), "Ready to assign $2,587.91");

  // A second entry lands newest first with its running balance; typing in Payee then Enter also saves.
  await amount.fill("50");
  await date.fill(today());
  await payee.fill("Refund");
  await payee.press("Enter");
  await rows.nth(1).waitFor();
  assert.deepEqual((await cells(rows.first())).slice(1), ["Refund", "Income", "", "50.00", "3,050.00"]);
  assert.deepEqual((await cells(rows.nth(1))).slice(4), ["2,000.00", "3,000.00"]);

  // Problems keep the draft and use neutral ink; Escape cancels the draft.
  await payee.fill("Mystery");
  await amount.fill("-5");
  await amount.press("Enter");
  const note = page.locator(".page > .note");
  await note.filter({ hasText: "Income must be more than 0.00." }).waitFor();
  assert.notEqual(await colorOf(note), over.light);
  assert.equal(await payee.inputValue(), "Mystery");
  assert.equal(await rows.count(), 2);
  await amount.fill("");
  await amount.press("Enter");
  await note.filter({ hasText: "Enter an amount" }).waitFor();
  await payee.press("Escape");
  assert.deepEqual([await payee.inputValue(), await amount.inputValue(), await date.inputValue()], ["", "", today()]);
  assert.equal(compact(await note.innerText()), "");

  // Ready to assign below zero is the overspent red with a true minus.
  const response = await fetch(`${app.url}/api/accounts/${checking.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ startingBalance: -300_000 }) });
  assert.equal(response.status, 200);
  await page.reload();
  await ready(page);
  assert.equal(compact(await page.locator("#side-ready").innerText()), `Ready to assign ${MINUS}$1,362.09`);
  assert.equal(await colorOf(readyFigure), over.light);
  assert.deepEqual(app.pageErrors, []);
  assert.deepEqual(app.foreignRequests, []);
});

test("the overview's account names open their registers, and an unknown account says so", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, visa } = await household(app.url);
  await page.goto(`${app.url}/budgets/${budgetId}/accounts`);
  await ready(page);
  await page.getByRole("table", { name: "Accounts" }).getByRole("link", { name: "Visa" }).click();
  await ready(page);
  assert.equal(new URL(page.url()).pathname, `/budgets/${budgetId}/accounts/${visa.id}`);
  // A card's debt is neutral ink, never red.
  assert.equal(compact(await page.locator(".acct-summary").innerText()), `Balance ${MINUS}$412.09`);
  await page.goBack();
  await ready(page);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Accounts");
  await page.goto(`${app.url}/budgets/${budgetId}/accounts/missing`);
  await ready(page);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Account not found");
  assert.deepEqual(app.pageErrors, []);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the register at 390px in the ${scheme} theme: no horizontal scroll, two-line rows, Ready to assign shown`, { timeout: 45_000 }, async (t) => {
    const app = await openApp(t, { colorScheme: scheme, width: 390, height: 844 });
    const { page } = app;
    const { budgetId, checking } = await household(app.url);
    await post(app.url, `/api/accounts/${checking.id}/transactions`, {
      date: earlier, payee: "A payee with a very long name that goes on and on and on and on", memo: "A memo that is also rather long for a phone", amount: 99_999_999_999, category: { kind: "income" },
    });
    await page.goto(`${app.url}/budgets/${budgetId}/accounts/${checking.id}`);
    await ready(page);
    assert.equal(await noHorizontalScroll(page), true);
    const row = page.locator(".rrow").first();
    assert.equal(await row.isVisible(), true);
    assert.ok((await row.boundingBox())!.width <= 390 - 32 + 1);
    assert.equal(compact(await row.locator(".amt").innerText()), "999,999,999.99");
    assert.equal(await colorOf(page.locator("#side-ready .figure")), violet[scheme]);
    assert.equal(await page.locator("#side-ready").isVisible(), true);
    if (scheme === "dark") {
      assert.equal(await page.locator(".reg").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(22, 33, 42)");
    }
    assert.deepEqual(app.pageErrors, []);
  });
}

test("in the dark theme on desktop the entry row saves income and the register reads well", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t, { colorScheme: "dark" });
  const { page } = app;
  const { budgetId, checking } = await household(app.url);
  await page.goto(`${app.url}/budgets/${budgetId}/accounts/${checking.id}`);
  await ready(page);
  const entry = page.locator("form.entry");
  await entry.getByLabel("Payee").fill("Acme");
  await entry.getByLabel("Amount").fill("10");
  await entry.getByLabel("Amount").press("Enter");
  await page.locator(".rrow").first().waitFor();
  assert.equal(compact(await page.locator("#side-ready").innerText()), "Ready to assign $597.91");
  assert.equal(await colorOf(page.locator("#side-ready .figure")), violet.dark);
  assert.equal(await page.locator(".reg").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(22, 33, 42)");
  assert.equal(await noHorizontalScroll(page), true);
  assert.deepEqual(app.pageErrors, []);
});
