import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";

const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// The browser shares the test machine's zone with the server, so "this month" agrees on both.
const now = new Date();
const monthOf = (offset: number) => {
  const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const current = monthOf(0);
const previous = monthOf(-1);
const currentName = now.toLocaleDateString("en-US", { month: "long" });

async function send(url: string, path: string, body: unknown, status = 201, method = "POST"): Promise<{ id: string; groupId: string }> {
  const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()) as { id: string; groupId: string };
}

/**
 * Checking at 5,000.00. Rent (recurring 1,650.00) above Fuel (recurring 160.00) above Clothing (plain): rain
 * gives Rent 1,650.00 and Fuel 160.00, 1,810.00 in all, leaving 3,190.00 ready to assign.
 */
async function household(url: string, startingBalance = 500_000) {
  const budgetId = await seedBudget(url, "Household");
  const checking = await send(url, `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance, startingDate: `${previous}-01` });
  const rent = await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Rent", newGroupName: "Fixed", type: "recurring", amount: 165_000 });
  const fuel = await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Fuel", newGroupName: "Everyday", type: "recurring", amount: 16_000 });
  await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Clothing", groupId: fuel.groupId, type: "plain" });
  const spend = (bucketId: string, amount: number) => send(url, `/api/accounts/${checking.id}/transactions`, { date: `${current}-01`, amount: -amount, category: { kind: "bucket", bucketId } });
  return { budgetId, rent, fuel, spend };
}

const strip = (page: Page) => page.getByRole("region", { name: "Month summary" });
const rainButton = (page: Page) => strip(page).getByRole("button", { name: "Make it rain" });
const preview = (page: Page) => page.getByRole("dialog", { name: "Make it rain" });
const readyFigure = async (page: Page) => compact(await strip(page).locator(".ready-figure").innerText());
const available = async (page: Page, name: string) => compact(await page.locator(".brow", { hasText: name }).locator(".avail").innerText());
const snack = (page: Page) => page.locator("#snack");
const rows = async (list: Locator) => (await list.locator("li").allInnerTexts()).map(compact);

async function openBuckets(page: Page, url: string, budgetId: string, month?: string) {
  await page.goto(`${url}/budgets/${budgetId}/buckets${month ? `?month=${month}` : ""}`);
  await ready(page);
}

test("Make it rain previews the dry run, applies exactly it, and Undo reverses it", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page, url } = app;
  const { budgetId } = await household(url);
  await openBuckets(page, url, budgetId);

  await rainButton(page).click();
  const sheet = preview(page);
  await sheet.waitFor();
  // Bucket order, each with its amount; Clothing (plain) needs nothing and is absent.
  assert.deepEqual(await rows(sheet.locator(".rain-fills")), ["Rent $1,650.00", "Fuel $160.00"]);
  assert.equal(compact(await sheet.locator(".rain-total").innerText()), "Total $1,810.00");
  assert.equal(compact(await sheet.locator(".rain-ready").innerText()), "Ready to assign $5,000.00 → $3,190.00");
  const dry = (await (await fetch(`${url}/api/budgets/${budgetId}/months/${current}/rain`)).json()) as { total: number };
  assert.equal(dry.total, 181_000);

  await sheet.getByRole("button", { name: "Rain $1,810.00" }).click();
  await sheet.waitFor({ state: "detached" });
  await snack(page).locator("#snack-msg", { hasText: "Rained" }).waitFor();
  assert.equal(compact(await snack(page).locator("#snack-msg").innerText()), "Rained $1,810.00 into 2 buckets.");
  assert.equal(await readyFigure(page), "$3,190.00");
  assert.equal(await available(page, "Rent"), "1,650.00");
  assert.equal(await available(page, "Fuel"), "160.00");
  // Under reduced motion there's no flourish.
  assert.equal(await page.locator(".rain-layer i").count(), 0);

  await snack(page).getByRole("button", { name: "Undo" }).click();
  await page.waitForFunction(() => document.querySelector(".ready-figure")?.textContent?.includes("5,000"));
  assert.equal(await available(page, "Rent"), "0.00");
  assert.deepEqual(app.pageErrors, []);
});

test("a refused Undo shows the API's message", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page, url } = app;
  const { budgetId, fuel, spend } = await household(url);
  await openBuckets(page, url, budgetId);
  await rainButton(page).click();
  await preview(page).getByRole("button", { name: "Rain $1,810.00" }).click();
  await snack(page).locator("#snack-msg", { hasText: "Rained" }).waitFor();
  await spend(fuel.id, 5_000);
  await snack(page).getByRole("button", { name: "Undo" }).click();
  const note = page.locator(".page > .note");
  await note.locator("span", { hasText: "Money has moved out of Fuel" }).waitFor();
  assert.equal(compact(await note.innerText()), "Money has moved out of Fuel since it rained, so this rain can't be undone.");
  assert.deepEqual(app.pageErrors, []);
});

test("when the plan changes behind an open preview, confirming rains nothing and shows the new plan", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page, url } = app;
  const { budgetId, fuel } = await household(url);
  await openBuckets(page, url, budgetId);
  await rainButton(page).click();
  const sheet = preview(page);
  await sheet.waitFor();
  // Someone else assigns 60.00 to Fuel, so rain would now give it 100.00.
  await send(url, `/api/buckets/${fuel.id}/assign`, { month: current, amount: 6_000 }, 200);

  await sheet.getByRole("button", { name: "Rain $1,810.00" }).click();
  await sheet.locator(".snote", { hasText: "changed" }).waitFor();
  assert.equal(compact(await sheet.locator(".snote").innerText()), "The buckets have changed since this preview. Check the new amounts and rain again.");
  assert.deepEqual(await rows(sheet.locator(".rain-fills")), ["Rent $1,650.00", "Fuel $100.00"]);
  assert.equal(compact(await sheet.locator(".rain-ready").innerText()), "Ready to assign $4,940.00 → $3,190.00");
  const dry = (await (await fetch(`${url}/api/budgets/${budgetId}/ready-to-assign`)).json()) as { readyToAssign: number };
  assert.equal(dry.readyToAssign, 494_000);

  await sheet.getByRole("button", { name: "Rain $1,750.00" }).click();
  await sheet.waitFor({ state: "detached" });
  await snack(page).locator("#snack-msg", { hasText: "Rained" }).waitFor();
  assert.equal(await readyFigure(page), "$3,190.00");
  assert.deepEqual(app.pageErrors, []);
});

test("with nothing to fill, the preview says why", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page, url } = app;
  const { budgetId } = await household(url);
  await openBuckets(page, url, budgetId);
  await rainButton(page).click();
  await preview(page).getByRole("button", { name: "Rain $1,810.00" }).click();
  await snack(page).locator("#snack-msg", { hasText: "Rained" }).waitFor();

  // Every target met.
  assert.equal(await rainButton(page).isEnabled(), true);
  await rainButton(page).click();
  await preview(page).waitFor();
  assert.equal(compact(await preview(page).locator(".rain-empty").innerText()), `Every bucket has what it needs for ${currentName}.`);
  assert.equal(await preview(page).getByRole("button", { name: /^Rain / }).count(), 0);
  await preview(page).getByRole("button", { name: "Done" }).click();
  await preview(page).waitFor({ state: "detached" });

  // Nothing ready to assign, in a budget whose buckets all still need money.
  const broke = await household(url, 0);
  await openBuckets(page, url, broke.budgetId);
  await rainButton(page).click();
  await preview(page).waitFor();
  assert.equal(compact(await preview(page).locator(".rain-empty").innerText()), "Nothing ready to assign.");
  assert.deepEqual(app.pageErrors, []);
});

test("Make it rain is absent for past months and present for this and later months", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page, url } = app;
  const { budgetId } = await household(url);
  await openBuckets(page, url, budgetId, previous);
  assert.equal(await rainButton(page).count(), 0);
  await openBuckets(page, url, budgetId, monthOf(1));
  assert.equal(await rainButton(page).count(), 1);
  await openBuckets(page, url, budgetId);
  assert.equal(await rainButton(page).count(), 1);
  assert.deepEqual(app.pageErrors, []);
});

test("without reduced motion a brief rain flourish follows the confirmed rain, and a click skips it", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t, { reducedMotion: "no-preference" });
  const { page, url } = app;
  const { budgetId } = await household(url);
  await openBuckets(page, url, budgetId);
  await rainButton(page).click();
  await preview(page).getByRole("button", { name: "Rain $1,810.00" }).click();
  await page.locator(".rain-layer i").first().waitFor();
  // It plays after the result has drawn.
  assert.equal(await readyFigure(page), "$3,190.00");
  // Gone on its own in under a second.
  await page.locator(".rain-layer i").first().waitFor({ state: "detached", timeout: 1_000 });

  // Skippable: a second rain into next month, and a click clears it at once.
  await openBuckets(page, url, budgetId, monthOf(1));
  await rainButton(page).click();
  await preview(page).getByRole("button", { name: /^Rain \$/ }).click();
  await page.locator(".rain-layer i").first().waitFor();
  await page.mouse.click(5, 5);
  assert.equal(await page.locator(".rain-layer i").count(), 0);
  assert.deepEqual(app.pageErrors, []);
});

for (const scheme of ["light", "dark"] as const) {
  test(`Make it rain at 390px in the ${scheme} theme is in the first screen`, { timeout: 45_000 }, async (t) => {
    const app = await openApp(t, { colorScheme: scheme, width: 390, height: 844 });
    const { page, url } = app;
    const { budgetId } = await household(url);
    await openBuckets(page, url, budgetId);
    const box = (await rainButton(page).boundingBox())!;
    assert.ok(box.y >= 0 && box.y + box.height <= 844, `button at ${box.y}+${box.height}`);
    assert.ok(box.height >= 44, `button height ${box.height}`);
    await rainButton(page).click();
    await preview(page).waitFor();
    assert.equal(await noHorizontalScroll(page), true);
    const sheet = (await preview(page).boundingBox())!;
    assert.ok(sheet.x >= 0 && sheet.x + sheet.width <= 390 + 1);
    await preview(page).getByRole("button", { name: "Rain $1,810.00" }).click();
    await snack(page).locator("#snack-msg", { hasText: "Rained" }).waitFor();
    assert.equal(await noHorizontalScroll(page), true);
    assert.deepEqual(app.pageErrors, []);
  });
}
