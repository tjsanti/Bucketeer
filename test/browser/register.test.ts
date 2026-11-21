import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";

const MINUS = "−";
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
// Up to six days back stays inside this month, which the register shows, and sorts no later than today.
const back = Math.min(6, new Date().getDate() - 1);
const earlier = iso(localDate(back));
const earlierLabel = localDate(back).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toLocaleDateString("en-US", { month: "short", day: "numeric" });

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

test("income entered in the register updates the register and the account balance", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, checking } = await household(app.url);
  await page.goto(`${app.url}/budgets/${budgetId}/accounts`);
  await ready(page);

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
  assert.equal(compact(await register.locator(".reg-end").innerText()), `Balance before ${monthStart} 1,000.00`);

  // The entry row is always ready: date defaults to today; Income is picked from the category list.
  const entry = page.locator("form.entry");
  const date = entry.getByLabel("Date");
  const payee = entry.getByLabel("Payee");
  const memo = entry.getByLabel("Memo");
  const amount = entry.getByLabel("Amount");
  const category = entry.getByRole("combobox", { name: "Category" });
  assert.equal(await date.inputValue(), today());
  assert.equal(await category.inputValue(), "");
  assert.equal(await amount.getAttribute("aria-label"), "Amount, money out");
  const pickIncome = async () => {
    await category.fill("Inc");
    await category.press("Enter");
  };
  await pickIncome();
  assert.equal(await entry.locator("button.sign").textContent(), "+");
  assert.equal(await amount.getAttribute("aria-label"), "Amount, money in");

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

  // A second entry lands newest first with its running balance; typing in Payee then Enter also saves.
  await pickIncome();
  await amount.fill("50");
  await date.fill(today());
  await payee.fill("Refund");
  await payee.press("Enter");
  await rows.nth(1).waitFor();
  assert.deepEqual((await cells(rows.first())).slice(1), ["Refund", "Income", "", "50.00", "3,050.00"]);
  assert.deepEqual((await cells(rows.nth(1))).slice(4), ["2,000.00", "3,000.00"]);

  // Problems keep the draft and use neutral ink; Escape cancels the draft.
  await payee.fill("Mystery");
  await pickIncome();
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
  test(`the register at 390px in the ${scheme} theme: no horizontal scroll, two-line rows`, { timeout: 45_000 }, async (t) => {
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
  await entry.getByRole("combobox", { name: "Category" }).fill("Income");
  await entry.getByRole("combobox", { name: "Category" }).press("Enter");
  await entry.getByLabel("Payee").fill("Acme");
  await entry.getByLabel("Amount").fill("10");
  await entry.getByLabel("Amount").press("Enter");
  await page.locator(".rrow").first().waitFor();
  assert.equal(await page.locator(".reg").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(22, 33, 42)");
  assert.equal(await noHorizontalScroll(page), true);
  assert.deepEqual(app.pageErrors, []);
});

test("a new transaction's date defaults to the server's today, not the browser's", { timeout: 60_000 }, async (t) => {
  // Kiritimati (UTC+14) is always a day or more ahead of Pago Pago (UTC−11).
  const serverZone = "Pacific/Pago_Pago";
  const app = await openApp(t, { serverTimeZone: serverZone, browserTimeZone: "Pacific/Kiritimati" });
  const { page } = app;
  const { budgetId, checking } = await household(app.url);
  const serverToday = new Intl.DateTimeFormat("en-CA", { timeZone: serverZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  await page.goto(`${app.url}/budgets/${budgetId}/accounts/${checking.id}`);
  await ready(page);

  const entry = page.locator("form.entry");
  assert.equal(await entry.getByLabel("Date").inputValue(), serverToday);
  await entry.getByRole("combobox", { name: "Category" }).fill("Inc");
  await entry.getByRole("combobox", { name: "Category" }).press("Enter");
  await entry.getByLabel("Amount").fill("20");
  await entry.getByLabel("Amount").press("Enter");
  await page.locator("#snack-msg", { hasText: "Added" }).waitFor();
  assert.equal(await entry.locator(".note, [role=alert]").filter({ hasText: "future" }).count(), 0);
  assert.deepEqual(app.pageErrors, []);
});
