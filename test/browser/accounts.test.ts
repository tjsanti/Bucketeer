import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";
import type { App } from "./harness.js";

const MINUS = "−";
const ink = "rgb(21, 48, 60)"; // --text, light
const over = "rgb(179, 36, 59)"; // --over, light

const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();

async function seedAccount(url: string, budgetId: string, input: { name: string; type: string; startingBalance: number }): Promise<{ id: string }> {
  const response = await fetch(`${url}/api/budgets/${budgetId}/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ startingDate: "2026-11-01", ...input }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: string };
}

async function openAccounts(app: App, budgetName = "Household"): Promise<string> {
  const id = await seedBudget(app.url, budgetName);
  await app.page.goto(`${app.url}/budgets/${id}/accounts`);
  await ready(app.page);
  return id;
}

async function addAccount(page: Page, input: { name: string; type?: string; amount?: string }): Promise<void> {
  await page.getByRole("button", { name: "Add account" }).click();
  const dialog = page.locator("dialog");
  await dialog.getByLabel("Name").fill(input.name);
  if (input.type) await dialog.getByRole("radio", { name: input.type }).click();
  if (input.amount !== undefined) await dialog.getByLabel(input.type === "Credit card" ? "Amount owed" : "Starting balance").fill(input.amount);
  await dialog.getByRole("button", { name: "Add account" }).click();
  await dialog.waitFor({ state: "detached" });
}

const colorOf = (locator: Locator) => locator.evaluate((node) => getComputedStyle(node).color);

test("accounts can be added, edited, closed, undone and reopened", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const budgetId = await openAccounts(app);
  const table = page.getByRole("table", { name: "Accounts" });
  const sidebar = page.locator("#side-list");
  const dialog = page.locator("dialog");
  const snack = page.locator("#snack");
  const patches: string[] = [];
  page.on("request", (request) => { if (request.method() === "PATCH") patches.push(request.postData() ?? ""); });

  // Nothing yet: a quiet line, one Add button, no sidebar list, no closed section, only Accounts in the nav.
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Accounts");
  assert.equal(await page.locator(".empty").textContent(), "No accounts yet.");
  assert.equal(await page.locator("#side-accounts").isVisible(), false);
  assert.equal(await page.locator("details.closed").count(), 0);
  assert.deepEqual(await page.locator("#nav a").allTextContents(), ["Accounts"]);
  assert.equal(await page.locator("#nav-accounts").getAttribute("aria-current"), "page");

  await addAccount(page, { name: "Checking", type: "Checking", amount: "1,000.00" });
  await addAccount(page, { name: "Credit card", type: "Credit card", amount: "412.09" });
  await addAccount(page, { name: "Cash", type: "Cash", amount: "0" });

  // Server side: the card's debt is stored negative; the other two as typed.
  const stored = (await (await fetch(`${app.url}/api/budgets/${budgetId}/accounts`)).json()) as { name: string; type: string; startingBalance: number }[];
  assert.deepEqual(stored.map((account) => [account.name, account.type, account.startingBalance]), [["Checking", "checking", 100000], ["Credit card", "credit-card", -41209], ["Cash", "cash", 0]]);

  // Sidebar and table agree; negatives use U+2212; Total has a $.
  assert.deepEqual((await sidebar.locator("li.row").allInnerTexts()).map(compact), ["Checking 1,000.00", `Credit card ${MINUS}412.09`, "Cash 0.00"]);
  assert.equal(compact(await sidebar.locator("li.total").innerText()), "Total $587.91");
  assert.deepEqual(await table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => [row.querySelector("th")?.textContent, row.querySelector("td.bal")?.textContent])), [["Checking", "1,000.00"], ["Credit card", `${MINUS}412.09`], ["Cash", "0.00"]]);
  assert.equal(await table.locator("tfoot td.bal").textContent(), "$587.91");
  assert.deepEqual(await table.locator("thead th").allInnerTexts(), ["Account", "Balance", "Edit"]);

  // A card's negative balance is neutral ink, never the overspent red.
  const cardBalance = table.locator("tr", { hasText: "Credit card" }).locator("td.bal");
  assert.equal(await colorOf(cardBalance), await colorOf(table.locator("tr", { hasText: "Checking" }).locator("td.bal")));
  assert.equal(await colorOf(cardBalance), ink);
  assert.notEqual(await colorOf(cardBalance), over);
  assert.equal(await colorOf(sidebar.locator("li.row", { hasText: "Credit card" }).locator("span").last()), ink);
  assert.equal(await cardBalance.evaluate((node) => getComputedStyle(node).fontWeight), "700");

  // Edit: the card shows what is owed as a positive amount, and the type is fixed.
  await page.getByRole("button", { name: "Edit Credit card" }).click();
  assert.equal(await dialog.getByRole("heading").textContent(), "Edit Credit card");
  assert.equal(await dialog.getByLabel("Amount owed").inputValue(), "412.09");
  assert.equal(await dialog.getByRole("radio", { name: "Credit card" }).getAttribute("aria-checked"), "true");
  for (const option of ["Checking", "Savings", "Credit card", "Cash"]) assert.equal(await dialog.getByRole("radio", { name: option }).isDisabled(), true, option);
  const close = dialog.getByRole("button", { name: "Close Credit card" });
  assert.equal(await close.isDisabled(), true);
  const why = dialog.getByText("Balance must be 0.00");
  assert.equal(await close.getAttribute("aria-describedby"), await why.getAttribute("id"));
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Edit Credit card", "Focus returns to the opener.");

  // Edit a name: only the changed field is sent. Clicking the row opens Edit too.
  await table.getByRole("cell", { name: "Checking" }).click();
  await dialog.getByLabel("Name").fill("Main checking");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(patches.map((body) => JSON.parse(body)), [{ name: "Main checking" }]);
  assert.equal(await table.getByRole("row", { name: /Main checking/ }).count(), 1);
  assert.equal(compact(await sidebar.locator("li.row").first().innerText()), "Main checking 1,000.00");

  // Edit the starting balance and date: totals follow the server.
  await page.getByRole("button", { name: "Edit Main checking" }).click();
  assert.equal(await dialog.getByLabel("Starting balance").inputValue(), "1,000.00");
  await dialog.getByLabel("Starting balance").fill("1,200.00");
  await dialog.getByLabel("Balance on").fill("2026-10-15");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(patches.map((body) => JSON.parse(body)).at(-1), { startingBalance: 120000, startingDate: "2026-10-15" });
  assert.equal(await table.locator("tfoot td.bal").textContent(), "$787.91");
  assert.equal(compact(await sidebar.locator("li.total").innerText()), "Total $787.91");

  // Close is disabled for a non-zero balance and enabled at zero; closing moves the account and offers Undo.
  await page.getByRole("button", { name: "Edit Main checking" }).click();
  assert.equal(await dialog.getByRole("button", { name: "Close Main checking" }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Edit Cash" }).click();
  await dialog.getByRole("button", { name: "Close Cash" }).click();
  await dialog.waitFor({ state: "detached" });
  await snack.waitFor();
  assert.equal(await page.locator("#snack-msg").textContent(), "Closed Cash.");
  assert.equal(await page.locator("#announce").textContent(), "Closed Cash.");
  assert.equal(await table.getByRole("row", { name: /^Cash/ }).count(), 0);
  assert.equal(await sidebar.locator("li.row").count(), 2);
  assert.equal(compact(await page.locator("details.closed summary").innerText()), "Closed accounts · 1");
  await page.locator("details.closed summary").click();
  assert.match(compact(await page.locator("details.closed li").innerText()), /^Cash Closed [A-Z][a-z]{2} \d{1,2}, \d{4} · 0\.00 Reopen$/);

  await page.locator("#snack-undo").click();
  await table.getByRole("row", { name: /^Cash/ }).waitFor();
  assert.equal(await snack.isVisible(), false);
  assert.equal(await page.locator("details.closed").count(), 0);
  assert.equal(await sidebar.locator("li.row").count(), 3);

  // Close again, let the snackbar go, and reopen from the closed list.
  await page.getByRole("button", { name: "Edit Cash" }).click();
  await dialog.getByRole("button", { name: "Close Cash" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator("#snack-x").click();
  assert.equal(await snack.isVisible(), false);
  await page.locator("details.closed summary").click();
  await page.getByRole("button", { name: "Reopen Cash" }).click();
  await table.getByRole("row", { name: /^Cash/ }).waitFor();
  assert.equal(await page.locator("details.closed").count(), 0);

  assert.deepEqual(app.foreignRequests, []);
  assert.deepEqual(app.pageErrors, []);
});

test("the snackbar hides itself after a few seconds", { timeout: 30_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const budgetId = await openAccounts(app);
  await seedAccount(app.url, budgetId, { name: "Wallet", type: "cash", startingBalance: 0 });
  await page.reload();
  await ready(page);
  await page.getByRole("button", { name: "Edit Wallet" }).click();
  await page.locator("dialog").getByRole("button", { name: "Close Wallet" }).click();
  await page.locator("#snack").waitFor();
  await page.locator("#snack").waitFor({ state: "hidden", timeout: 9_000 });
  assert.equal(await page.locator("details.closed").count(), 1);
  assert.deepEqual(app.pageErrors, []);
});

test("the dialog shows problems in neutral ink and keeps the user's input", { timeout: 45_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  await openAccounts(app);
  await addAccount(page, { name: "Main checking", type: "Checking", amount: "10" });
  const dialog = page.locator("dialog");

  // A duplicate name comes back from the server.
  await page.getByRole("button", { name: "Add account" }).click();
  await dialog.getByLabel("Name").fill("main CHECKING");
  await dialog.getByLabel("Starting balance").fill("5");
  await dialog.getByRole("button", { name: "Add account" }).click();
  const alert = dialog.getByRole("alert");
  await alert.filter({ hasText: /already/i }).waitFor();
  assert.equal(await dialog.getByLabel("Name").inputValue(), "main CHECKING");
  assert.equal(await dialog.getByLabel("Starting balance").inputValue(), "5");
  assert.equal(await dialog.getByLabel("Name").isEnabled(), true);
  assert.equal(await alert.locator("svg").count(), 1, "An alert icon, not colour alone.");
  assert.equal(await colorOf(alert), ink);
  assert.equal(await alert.evaluate((node) => getComputedStyle(node).borderTopColor), "rgb(118, 139, 147)");
  assert.notEqual(await alert.evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(252, 232, 236)");

  // Typing clears the note; a bad amount is caught in the browser and kept.
  await dialog.getByLabel("Name").fill("Savings");
  assert.equal(compact(await alert.textContent()), "");
  await dialog.getByLabel("Starting balance").fill("12.345");
  await dialog.getByLabel("Starting balance").press("Enter");
  await alert.filter({ hasText: "Enter an amount like 1,234.56" }).waitFor();
  assert.equal(await dialog.getByLabel("Starting balance").inputValue(), "12.345");
  assert.equal(await dialog.getByLabel("Name").inputValue(), "Savings");

  // A cleared date is refused before anything is sent.
  await dialog.getByLabel("Starting balance").fill("12.34");
  await dialog.getByLabel("Balance on").fill("");
  await dialog.getByRole("button", { name: "Add account" }).click();
  await alert.filter({ hasText: "Choose the date" }).waitFor();

  // A typed negative on a card means money in credit; the label tracks the type.
  await dialog.getByLabel("Balance on").fill("2026-11-01");
  await dialog.getByRole("radio", { name: "Credit card" }).click();
  assert.equal(await dialog.getByLabel("Amount owed").inputValue(), "12.34");
  await dialog.getByLabel("Amount owed").fill("-30");
  await dialog.getByLabel("Name").fill("Store card");
  await dialog.getByRole("button", { name: "Add account" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(compact(await page.locator("#side-list li.row").last().innerText()), "Store card 30.00");

  // A server failure on Edit keeps the dialog open with the server's words.
  await page.route("**/api/accounts/*", async (route) => {
    if (route.request().method() === "PATCH") await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Saving is temporarily unavailable." } } });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Edit Store card" }).click();
  assert.equal(await dialog.getByLabel("Starting balance").isVisible(), false, "A card says Amount owed.");
  assert.equal(await dialog.getByLabel("Amount owed").inputValue(), `${MINUS}30.00`);
  await dialog.getByLabel("Name").fill("Store card 2");
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.getByRole("alert").filter({ hasText: "Saving is temporarily unavailable." }).waitFor();
  assert.equal(await dialog.getByLabel("Name").inputValue(), "Store card 2");
  assert.deepEqual(app.pageErrors, []);
});

test("a change that saved is not lost when the list cannot refresh", { timeout: 30_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const budgetId = await openAccounts(app);
  let failList = false;
  await page.route("**/api/budgets/*/accounts", async (route) => {
    if (failList && route.request().method() === "GET") await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Down." } } });
    else await route.continue();
  });
  failList = true;
  await addAccount(page, { name: "Checking", type: "Checking", amount: "5" });
  assert.match(await page.locator(".page > .note").innerText(), /saved, but the accounts could not refresh/);
  const stored = (await (await fetch(`${app.url}/api/budgets/${budgetId}/accounts`)).json()) as unknown[];
  assert.equal(stored.length, 1);
  failList = false;
  await page.reload();
  await ready(page);
  assert.equal(await page.locator("tbody tr").count(), 1);
  assert.deepEqual(app.pageErrors, []);
});

test("the dialogs work from the keyboard", { timeout: 30_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  await openAccounts(app);
  const dialog = page.locator("dialog");
  const add = page.getByRole("button", { name: "Add account" });

  await add.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id !== undefined && (document.activeElement as HTMLInputElement).labels?.[0]?.textContent), "Name");
  // Type: a radiogroup with a roving tabindex; arrows move and select.
  const group = dialog.getByRole("radiogroup", { name: "Type" });
  assert.equal(await group.getByRole("radio").count(), 4);
  assert.deepEqual(await group.getByRole("radio").evaluateAll((radios) => radios.map((radio) => radio.tabIndex)), [0, -1, -1, -1]);
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal(await dialog.getByRole("radio", { name: "Credit card" }).getAttribute("aria-checked"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Credit card");
  assert.deepEqual(await group.getByRole("radio").evaluateAll((radios) => radios.map((radio) => radio.tabIndex)), [-1, -1, 0, -1]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal(await dialog.getByRole("radio", { name: "Checking" }).getAttribute("aria-checked"), "true", "Arrows wrap around.");
  await page.keyboard.press("End");
  assert.equal(await dialog.getByRole("radio", { name: "Cash" }).getAttribute("aria-checked"), "true");

  // Escape cancels and returns focus to the Add button; nothing was created.
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Add account");
  assert.equal(await page.locator(".empty").count(), 1);

  // Enter in a field submits.
  await add.click();
  await dialog.getByLabel("Name").fill("Wallet");
  await dialog.getByLabel("Name").press("Enter");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.locator("tbody tr").count(), 1);

  // Keyboard users reach Edit through the row's button, and Escape returns there.
  await page.getByRole("button", { name: "Edit Wallet" }).focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel("Name").inputValue(), "Wallet");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Edit Wallet");
  assert.deepEqual(app.pageErrors, []);
});

test("the dark theme renders the page and its dialogs", { timeout: 30_000 }, async (t) => {
  const app = await openApp(t, { colorScheme: "dark" });
  const { page } = app;
  const budgetId = await openAccounts(app);
  await seedAccount(app.url, budgetId, { name: "Checking", type: "checking", startingBalance: 246335 });
  await seedAccount(app.url, budgetId, { name: "Visa", type: "credit-card", startingBalance: -41209 });
  await page.reload();
  await ready(page);
  const background = (selector: string) => page.locator(selector).evaluate((node) => getComputedStyle(node).backgroundColor);
  assert.equal(await background("body"), "rgb(15, 23, 30)");
  assert.equal(await background(".side"), "rgb(11, 18, 24)");
  assert.equal(await background(".otable"), "rgb(22, 33, 42)");
  assert.equal(await page.locator("tbody td.bal").first().evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(27, 40, 51)");
  const cardBalance = page.locator("tr", { hasText: "Visa" }).locator("td.bal");
  assert.equal(await colorOf(cardBalance), "rgb(227, 236, 240)", "Dark ink, not the overspent red.");
  await page.getByRole("button", { name: "Edit Visa" }).click();
  assert.equal(await page.locator("dialog").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(22, 33, 42)");
  assert.equal(await page.locator("dialog").evaluate((node) => getComputedStyle(node, "::backdrop").backgroundColor), "rgba(0, 0, 0, 0.55)");
  assert.equal(await page.locator("dialog").evaluate((node) => getComputedStyle(node).colorScheme), "dark");
  assert.deepEqual(app.foreignRequests, []);
  assert.deepEqual(app.pageErrors, []);
});

for (const width of [390, 375]) {
  test(`at ${width}px nothing overflows, targets are touchable and dialogs are bottom sheets`, { timeout: 45_000 }, async (t) => {
    const app = await openApp(t, { width, height: 780 });
    const { page } = app;
    const budgetId = await openAccounts(app);
    await seedAccount(app.url, budgetId, { name: "Checking", type: "checking", startingBalance: 246335 });
    await seedAccount(app.url, budgetId, { name: "Credit card", type: "credit-card", startingBalance: -41209 });
    await seedAccount(app.url, budgetId, { name: "An account with a very long name that goes on and on and on", type: "savings", startingBalance: 99999999999 });
    const old = await seedAccount(app.url, budgetId, { name: "Old savings", type: "savings", startingBalance: 0 });
    await fetch(`${app.url}/api/accounts/${old.id}/close`, { method: "POST" });
    await page.reload();
    await ready(page);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.equal(await noOverflow(), true);
    await page.locator("details.closed summary").click();
    assert.equal(await noOverflow(), true);

    // The sidebar becomes a top bar: brand, picker, theme toggle, then a tab row; the account list is on the page.
    assert.equal(await page.locator("#side-accounts").isVisible(), false);
    const box = async (locator: Locator) => (await locator.boundingBox())!;
    const top = await box(page.locator(".side"));
    assert.ok(top.y === 0 && top.width === width);
    for (const locator of [page.locator("#budget-button"), page.locator("#theme-toggle"), page.locator("#nav-accounts"), page.getByRole("button", { name: "Add account" }), page.getByRole("button", { name: "Edit Checking" }), page.getByRole("button", { name: "Reopen Old savings" }), page.locator("details.closed summary")]) {
      const size = await box(locator);
      assert.ok(size.height >= 44 && size.width >= 44, `${await locator.textContent()} is ${size.width}x${size.height}`);
    }
    const bar = await box(page.locator(".wordmark"));
    assert.ok((await box(page.locator("#theme-toggle")).then((b) => b.x)) > bar.x + bar.width - 1, "Brand and toggle share the top row.");

    // Rows are tappable and show the balance prominently; the total follows.
    await page.getByRole("cell", { name: "Checking" }).click();
    const dialog = page.locator("dialog");
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    // Add dialog: a bottom sheet that fits, with 16px fields.
    await page.getByRole("button", { name: "Add account" }).click();
    const sheet = await box(dialog);
    assert.equal(sheet.x, 0);
    assert.equal(sheet.width, width);
    assert.equal(Math.round(sheet.y + sheet.height), 780, "Anchored to the bottom.");
    assert.ok(sheet.height <= 780 - 40);
    assert.equal(await dialog.getByLabel("Name").evaluate((node) => getComputedStyle(node).fontSize), "16px");
    assert.equal(await dialog.getByLabel("Starting balance").evaluate((node) => getComputedStyle(node).fontSize), "16px");
    assert.equal(await dialog.evaluate((node) => getComputedStyle(node).borderTopLeftRadius), "24px");
    await dialog.getByRole("radio", { name: "Credit card" }).click();
    assert.equal(await noOverflow(), true);
    assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    for (const radio of await dialog.getByRole("radio").all()) assert.ok((await box(radio)).height >= 44);
    const submit = await box(dialog.getByRole("button", { name: "Add account" }));
    assert.ok(submit.height >= 44 && submit.y + submit.height <= 780);
    await dialog.getByLabel("Amount owed").fill("x");
    await dialog.getByRole("button", { name: "Add account" }).click();
    await dialog.getByRole("alert").filter({ hasText: "Enter an amount" }).waitFor();
    assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    await page.keyboard.press("Escape");

    // The picker menu fits inside the viewport.
    await page.locator("#budget-button").click();
    const menu = await box(page.locator("#budget-menu"));
    assert.ok(menu.x >= 0 && menu.x + menu.width <= width);
    assert.equal(await noOverflow(), true);
    assert.deepEqual(app.pageErrors, []);
  });
}
