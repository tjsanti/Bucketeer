import assert from "node:assert/strict";
import { test } from "node:test";
import { noHorizontalScroll, openApp, ready, seedBudget } from "./harness.js";

const accountsPath = /\/budgets\/([^/]+)\/accounts$/;

test("first run creates a budget, and the picker renames, adds and switches budgets", { timeout: 45_000 }, async (t) => {
  const { url, page, pageErrors, foreignRequests } = await openApp(t);
  let failCreate = true;
  await page.route("**/api/budgets", async (route) => {
    if (failCreate && route.request().method() === "POST") {
      await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Saving is temporarily unavailable." } } });
    } else {
      await route.continue();
    }
  });
  const picker = page.locator("#budget-button");
  const dialog = page.locator("dialog");

  await page.goto(url);
  await ready(page);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Start a budget");
  assert.equal(await picker.isVisible(), false, "No budgets yet, so nothing to pick.");
  assert.equal(await page.locator("#side-accounts").isVisible(), false);

  // A failed create keeps the typed name and says so.
  await page.getByLabel("Budget name").fill("Household");
  await page.getByRole("button", { name: "Create budget" }).click();
  await page.getByRole("alert").filter({ hasText: "Saving is temporarily unavailable." }).waitFor();
  assert.equal(await page.getByLabel("Budget name").inputValue(), "Household");
  assert.equal(await page.getByLabel("Budget name").isEnabled(), true);

  failCreate = false;
  await page.getByRole("button", { name: "Create budget" }).click();
  await page.waitForURL(accountsPath);
  await ready(page);
  const firstId = accountsPath.exec(new URL(page.url()).pathname)?.[1];
  assert.ok(firstId);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Accounts");
  assert.equal((await picker.innerText()).replace(/\s+/g, " "), "Budget Household");
  assert.equal(await page.evaluate(() => document.title), "Accounts · Household · Bucketeer");

  // The picker is a disclosure: aria-expanded, Escape closes and returns focus, arrows move.
  assert.equal(await picker.getAttribute("aria-expanded"), "false");
  await picker.click();
  assert.equal(await picker.getAttribute("aria-expanded"), "true");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Household");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "New budget");
  await page.keyboard.press("Escape");
  assert.equal(await picker.getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "budget-button");

  // A rejected rename keeps the user's input and does not claim success.
  await page.route("**/api/budgets/*", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Renaming is temporarily unavailable." } } });
    } else {
      await route.continue();
    }
  });
  await picker.click();
  await page.getByRole("button", { name: "Rename budget" }).click();
  assert.equal(await dialog.getByLabel("Name").inputValue(), "Household");
  assert.equal(await page.evaluate(() => document.activeElement?.id !== "budget-button"), true, "Focus is in the dialog.");
  await dialog.getByLabel("Name").fill("Family & <budget>");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.getByRole("alert").filter({ hasText: "Renaming is temporarily unavailable." }).waitFor();
  assert.equal(await dialog.getByLabel("Name").inputValue(), "Family & <budget>");
  assert.equal((await (await fetch(`${url}/api/budgets/${firstId}`)).json() as { name: string }).name, "Household");

  await page.unroute("**/api/budgets/*");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal((await picker.innerText()).replace(/\s+/g, " "), "Budget Family & <budget>");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "budget-button", "Focus returns to the opener.");
  assert.equal(accountsPath.exec(new URL(page.url()).pathname)?.[1], firstId);

  // A second budget opens on its own Accounts page and the picker lists both.
  await picker.click();
  await page.getByRole("button", { name: "New budget" }).click();
  await dialog.getByLabel("Name").fill("Work");
  await dialog.getByRole("button", { name: "Create budget" }).click();
  await dialog.waitFor({ state: "detached" });
  const secondId = accountsPath.exec(new URL(page.url()).pathname)?.[1];
  assert.ok(secondId && secondId !== firstId);
  assert.equal((await picker.innerText()).replace(/\s+/g, " "), "Budget Work");
  await picker.click();
  assert.equal(await page.locator("#budget-list button").count(), 2);
  assert.equal(await page.locator('#budget-list button[aria-current="true"]').textContent(), "Work");
  await page.getByRole("button", { name: "Family & <budget>" }).click();
  await page.waitForURL((address) => address.pathname === `/budgets/${firstId}/accounts`);
  await ready(page);
  assert.equal((await picker.innerText()).replace(/\s+/g, " "), "Budget Family & <budget>");

  // Reload keeps the route; "/" returns to the last-used budget.
  await page.reload();
  await ready(page);
  assert.equal(new URL(page.url()).pathname, `/budgets/${firstId}/accounts`);
  await page.goto(url);
  await page.waitForURL((address) => address.pathname === `/budgets/${firstId}/accounts`);
  await ready(page);
  await page.goBack();
  await ready(page);

  // Back and forward follow the history.
  await picker.click();
  await page.getByRole("button", { name: "Work" }).click();
  await page.waitForURL((address) => address.pathname === `/budgets/${secondId}/accounts`);
  await ready(page);
  await page.goBack();
  await page.waitForURL((address) => address.pathname === `/budgets/${firstId}/accounts`);
  await ready(page);
  assert.equal((await picker.innerText()).replace(/\s+/g, " "), "Budget Family & <budget>");

  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await noHorizontalScroll(page), true);
  assert.deepEqual(foreignRequests, []);
  assert.deepEqual(pageErrors, []);
});

test("an unknown budget shows an error with the picker still usable", { timeout: 30_000 }, async (t) => {
  const { url, page, pageErrors } = await openApp(t);
  const id = await seedBudget(url, "Household");
  await page.goto(`${url}/budgets/missing/accounts`);
  await ready(page);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Budget not found");
  assert.match(await page.getByRole("alert").innerText(), /does not exist/);
  assert.equal(await page.locator("#side-accounts").isVisible(), false);
  const picker = page.locator("#budget-button");
  await picker.click();
  await page.getByRole("button", { name: "Household" }).click();
  await page.waitForURL((address) => address.pathname === `/budgets/${id}/accounts`);
  await ready(page);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Accounts");
  assert.deepEqual(pageErrors, []);
});

test("a failed load shows an error and can try again", { timeout: 30_000 }, async (t) => {
  const { url, page, pageErrors } = await openApp(t);
  let fail = true;
  await page.route("**/api/budgets", async (route) => {
    if (fail) await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Budgets are temporarily unavailable." } } });
    else await route.continue();
  });
  await page.goto(url);
  await ready(page);
  assert.equal(await page.getByRole("alert").innerText(), "Budgets are temporarily unavailable.");
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("heading", { level: 1, name: "Start a budget" }).waitFor();
  assert.deepEqual(pageErrors, []);
});
