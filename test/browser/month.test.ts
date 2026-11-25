import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { noHorizontalScroll, openApp, ready, seedBudget } from "./harness.js";

const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();

// The browser shares the test machine's zone with the server, so "this month" agrees on both.
const now = new Date();
const monthOf = (offset: number) => {
  const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return { key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`, label: date.toLocaleDateString("en-US", { month: "long", year: "numeric" }), date };
};
const current = monthOf(0);
const previous = monthOf(-1);
const lastDayOfPrevious = `${previous.key}-${String(new Date(now.getFullYear(), now.getMonth(), 0).getDate()).padStart(2, "0")}`;
const today = `${current.key}-${String(now.getDate()).padStart(2, "0")}`;

async function post(url: string, path: string, body: unknown): Promise<{ id: string }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as { id: string };
}

/** Checking at 1,000.00 with 200.00 of income last month and 50.00 today. */
async function household(url: string) {
  const budgetId = await seedBudget(url, "Household");
  const checking = await post(url, `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 100_000, startingDate: `${current.key}-01` });
  await post(url, `/api/accounts/${checking.id}/transactions`, { date: `${previous.key}-15`, payee: "Acme Payroll", amount: 20_000, category: { kind: "income" } });
  await post(url, `/api/accounts/${checking.id}/transactions`, { date: today, payee: "Refund", amount: 5_000, category: { kind: "income" } });
  return { budgetId, checking };
}

const header = (page: Page) => page.locator(".month-head");
const label = (page: Page) => header(page).locator(".month-label");
const search = (page: Page) => new URL(page.url()).searchParams.get("month");

test("the overview and an account page browse months, keep the month in the URL and remember it between pages", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, checking } = await household(app.url);
  await page.goto(`${app.url}/budgets/${budgetId}/accounts`);
  await ready(page);

  // The current month by default, with balances as of today.
  assert.equal(compact(await label(page).innerText()), current.label);
  const overviewBalance = () => page.getByRole("table", { name: "Accounts" }).locator("tbody .bal").first().innerText();
  assert.equal(await overviewBalance(), "1,250.00");

  // The previous month: the balance at its end leaves out this month's 50.00, and the URL says so.
  await header(page).getByRole("button", { name: "Previous month" }).click();
  await ready(page);
  assert.equal(compact(await label(page).innerText()), previous.label);
  assert.equal(search(page), previous.key);
  assert.equal(await overviewBalance(), "1,200.00");
  // Focus stays on the arrow, so it can be pressed again.
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Previous month");

  // Reloading keeps the month.
  await page.reload();
  await ready(page);
  assert.equal(compact(await label(page).innerText()), previous.label);

  // Moving to an account keeps the month: only its rows, with running balances counting earlier ones.
  await page.getByRole("table", { name: "Accounts" }).getByRole("link", { name: "Checking" }).click();
  await ready(page);
  assert.equal(new URL(page.url()).pathname, `/budgets/${budgetId}/accounts/${checking.id}`);
  assert.equal(search(page), previous.key);
  assert.equal(compact(await label(page).innerText()), previous.label);
  const rows = page.locator(".rrow");
  assert.equal(await rows.count(), 1);
  assert.equal(compact(await rows.first().locator(".c.payee .pn").innerText()), "Acme Payroll");
  assert.equal(compact(await rows.first().locator(".c.bal").innerText()), "1,200.00");
  assert.match(compact(await page.locator(".acct-summary").innerText()), /\$1,200\.00$/);
  // A past month's entry row starts on its last day.
  assert.equal(await page.locator("form.entry").getByLabel("Date").inputValue(), lastDayOfPrevious);

  // Next month brings back this month's rows and today's balance; the entry row starts today.
  await header(page).getByRole("button", { name: "Next month" }).click();
  await ready(page);
  assert.equal(compact(await label(page).innerText()), current.label);
  assert.equal(await rows.count(), 1);
  assert.equal(compact(await rows.first().locator(".c.bal").innerText()), "1,250.00");
  assert.equal(compact(await page.locator(".acct-summary").innerText()), "Balance $1,250.00");
  assert.equal(await page.locator("form.entry").getByLabel("Date").inputValue(), today);

  // Back and forward move through the months too.
  await page.goBack();
  await ready(page);
  assert.equal(compact(await label(page).innerText()), previous.label);
  assert.deepEqual(app.pageErrors, []);
});

test("the arrows and the picker stop at the ends of the month range", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await household(app.url);
  const first = monthOf(-12);
  const last = monthOf(12);

  await page.goto(`${app.url}/budgets/${budgetId}/accounts?month=${first.key}`);
  await ready(page);
  assert.equal(compact(await label(page).innerText()), first.label);
  assert.equal(await header(page).getByRole("button", { name: "Previous month" }).isDisabled(), true);
  assert.equal(await header(page).getByRole("button", { name: "Next month" }).isDisabled(), false);

  await page.goto(`${app.url}/budgets/${budgetId}/accounts?month=${last.key}`);
  await ready(page);
  assert.equal(compact(await label(page).innerText()), last.label);
  assert.equal(await header(page).getByRole("button", { name: "Next month" }).isDisabled(), true);

  // The picker: years step within the range and months outside it are disabled.
  await label(page).click();
  const picker = page.getByRole("dialog", { name: "Choose month" });
  await picker.waitFor();
  assert.equal(await picker.getByRole("button", { name: "Next year" }).isDisabled(), true);
  const afterLast = monthOf(13);
  if (afterLast.date.getFullYear() === last.date.getFullYear()) {
    assert.equal(await picker.getByRole("button", { name: afterLast.label }).isDisabled(), true);
  }
  assert.equal(await picker.getByRole("button", { name: last.label }).getAttribute("aria-current"), "true");
  // Two years back reaches the first year, where the months before the range are disabled.
  await picker.getByRole("button", { name: "Previous year" }).click();
  await picker.getByRole("button", { name: "Previous year" }).click();
  assert.equal(await picker.getByRole("button", { name: "Previous year" }).isDisabled(), true);
  const beforeFirst = monthOf(-13);
  if (beforeFirst.date.getFullYear() === first.date.getFullYear()) {
    assert.equal(await picker.getByRole("button", { name: beforeFirst.label }).isDisabled(), true);
  }
  await picker.getByRole("button", { name: first.label }).click();
  await ready(page);
  assert.equal(search(page), first.key);
  assert.equal(compact(await label(page).innerText()), first.label);
  assert.equal(await picker.count(), 0);

  // Escape closes the picker and returns focus to the label.
  await label(page).click();
  await picker.waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await picker.count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("month-label")), true);

  // A month outside the range falls back to the current month.
  await page.goto(`${app.url}/budgets/${budgetId}/accounts?month=${monthOf(13).key}`);
  await ready(page);
  assert.equal(compact(await label(page).innerText()), current.label);
  assert.equal(search(page), null);
  assert.deepEqual(app.pageErrors, []);
});

for (const scheme of ["light", "dark"] as const) {
  test(`months at 390px in the ${scheme} theme: the header fits and navigates on the overview and an account`, { timeout: 60_000 }, async (t) => {
    const app = await openApp(t, { colorScheme: scheme, width: 390, height: 844 });
    const { page } = app;
    const { budgetId, checking } = await household(app.url);
    for (const path of [`/budgets/${budgetId}/accounts`, `/budgets/${budgetId}/accounts/${checking.id}`]) {
      await page.goto(`${app.url}${path}`);
      await ready(page);
      assert.equal(await header(page).isVisible(), true);
      assert.equal(await noHorizontalScroll(page), true);
      await header(page).getByRole("button", { name: "Previous month" }).click();
      await ready(page);
      assert.equal(compact(await label(page).innerText()), previous.label);
      await label(page).click();
      const picker = page.getByRole("dialog", { name: "Choose month" });
      await picker.waitFor();
      const box = (await picker.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
      assert.equal(await noHorizontalScroll(page), true);
      await picker.getByRole("button", { name: current.label }).click();
      await ready(page);
      assert.equal(compact(await label(page).innerText()), current.label);
    }
    assert.deepEqual(app.pageErrors, []);
  });
}
