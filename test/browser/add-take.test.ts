import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";

const MINUS = "−";
const compact = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const now = new Date();
const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

async function send(url: string, path: string, body: unknown, status = 201): Promise<{ id: string; groupId?: string }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()) as { id: string; groupId?: string };
}

/**
 * Checking at 500.00. Fixed: Rent (recurring 1,650). Everyday: Gifts (plain, 100.00 assigned this month), then
 * Fuel (recurring 160). Ready to assign is 400.00.
 */
async function household(url: string) {
  const budgetId = await seedBudget(url, "Household");
  await send(url, `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 50_000, startingDate: `${current}-01` });
  await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Rent", newGroupName: "Fixed", type: "recurring", amount: 165_000 });
  const gifts = await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Gifts", newGroupName: "Everyday", type: "plain" });
  await send(url, `/api/budgets/${budgetId}/buckets`, { name: "Fuel", groupId: gifts.groupId, type: "recurring", amount: 16_000 });
  await send(url, `/api/buckets/${gifts.id}/assign`, { month: current, amount: 10_000 }, 200);
  return { budgetId, gifts };
}

const rowOf = (page: Page, name: string) => page.locator(".brow", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
const pill = (page: Page, name: string) => page.getByRole("textbox", { name: `Add to or take from ${name}` });
const avail = async (page: Page, name: string) => compact(await rowOf(page, name).locator(".c.avail").innerText());
const groupAvail = async (page: Page, name: string) => compact(await page.locator(".bgroup", { hasText: name }).locator(".c.avail").innerText());
const readyFigure = (page: Page) => page.getByRole("region", { name: "Month summary" }).locator(".ready-figure");
const readyText = async (page: Page) => compact(await readyFigure(page).innerText());
const snack = (page: Page) => page.locator("#snack");
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");

async function eventually(check: () => Promise<void>, timeout = 3_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function openBuckets(page: Page, url: string, budgetId: string) {
  await page.goto(`${url}/budgets/${budgetId}/buckets`);
  await ready(page);
}

test("the pill adds and takes for the month, previews the result, and Undo or Cmd/Ctrl+Z reverses it", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await household(app.url);
  await openBuckets(page, app.url, budgetId);

  const table = page.getByRole("table", { name: "Buckets" });
  assert.deepEqual((await table.getByRole("columnheader").allInnerTexts()).map(compact).filter(Boolean), ["Bucket", "Target or goal", "Spent", "Add / take", "Available"]);
  const fuel = pill(page, "Fuel");
  const box = (await fuel.boundingBox())!;
  assert.deepEqual([Math.round(box.width), Math.round(box.height)], [80, 24]);
  assert.equal(await fuel.inputValue(), "");
  assert.equal(await fuel.getAttribute("placeholder"), `+ / ${MINUS}`);

  // Focus opens the row panel: assigned this month (of the target) and spent, never carried in.
  await fuel.focus();
  const panel = rowOf(page, "Fuel").locator(".rpanel");
  await panel.waitFor();
  assert.match(compact(await panel.innerText()), /Assigned this month 0\.00 of 160\.00/);
  assert.match(compact(await panel.innerText()), /Spent 0\.00/);
  assert.doesNotMatch(await panel.innerText(), /Carried in/i);
  assert.doesNotMatch(compact(await rowOf(page, "Gifts").innerText()), /Assigned this month/, "Only the focused row has a panel.");

  // Typing previews before → after, in the panel, the row's Available and the strip's Ready to assign.
  await fuel.pressSequentially("20");
  assert.match(compact(await panel.innerText()), /Add \$20\.00 to Fuel/);
  assert.match(compact(await panel.innerText()), /Available 0\.00 → 20\.00/);
  assert.match(compact(await panel.innerText()), /Ready to assign \$400\.00 → \$380\.00/);
  assert.match(compact(await panel.innerText()), /Assigned this month 0\.00 → 20\.00 of 160\.00/);
  assert.equal(await avail(page, "Fuel"), "20.00");
  assert.equal(await rowOf(page, "Fuel").locator(".avail .fig").getAttribute("class"), "fig is-preview");
  assert.equal(await readyText(page), "$380.00");
  assert.match((await readyFigure(page).getAttribute("class"))!, /is-preview/);
  assert.match(await readyFigure(page).evaluate((node) => getComputedStyle(node).textDecorationStyle), /dashed/);

  // Enter applies and keeps focus; the row, the group total and the strip update.
  await fuel.press("Enter");
  await eventually(async () => assert.equal(compact(await snack(page).locator(".msg").innerText()), "Added $20.00 to Fuel."));
  await eventually(async () => assert.equal(await avail(page, "Fuel"), "20.00"));
  assert.equal(await focusedLabel(page), "Add to or take from Fuel");
  assert.equal(await pill(page, "Fuel").getAttribute("placeholder"), "✓ +20.00");
  assert.equal(await groupAvail(page, "Everyday"), "120.00");
  assert.equal(await readyText(page), "$380.00");
  assert.doesNotMatch((await readyFigure(page).getAttribute("class"))!, /is-preview/);
  await eventually(async () => assert.match(await page.locator("#announce").innerText(), /Added \$20\.00 to Fuel\./));
  // The confirming flash is skipped under reduced motion.
  const flash = await rowOf(page, "Fuel").locator(".c.avail").evaluate((node) => [getComputedStyle(node).animationName, getComputedStyle(node).animationDuration]);
  assert.deepEqual(flash, ["avail-flash", "0s"]);

  // The snackbar's Undo reverses it.
  await snack(page).getByRole("button", { name: "Undo" }).click();
  await eventually(async () => assert.equal(await avail(page, "Fuel"), "0.00"));
  assert.equal(await readyText(page), "$400.00");
  assert.equal(await groupAvail(page, "Everyday"), "100.00");

  // A take, then Cmd/Ctrl+Z from outside a field.
  await pill(page, "Gifts").focus();
  await pill(page, "Gifts").pressSequentially("-30");
  assert.equal(await pill(page, "Gifts").inputValue(), `${MINUS}30`, "A typed hyphen shows as a true minus.");
  await pill(page, "Gifts").press("Enter");
  await eventually(async () => assert.equal(compact(await snack(page).locator(".msg").innerText()), "Took $30.00 from Gifts."));
  await eventually(async () => assert.equal(await avail(page, "Gifts"), "70.00"));
  assert.equal(await readyText(page), "$430.00");
  await pill(page, "Gifts").press("Escape");
  await page.locator("h1").click();
  await page.keyboard.press("ControlOrMeta+z");
  await eventually(async () => assert.equal(await avail(page, "Gifts"), "100.00"));
  assert.equal(await readyText(page), "$400.00");

  // Escape clears a draft.
  await fuel.focus();
  await fuel.pressSequentially("5");
  await fuel.press("Escape");
  assert.equal(await fuel.inputValue(), "");
  assert.equal(await avail(page, "Fuel"), "0.00");
  assert.equal(await readyText(page), "$400.00");
  assert.deepEqual(app.pageErrors, []);
});

test("the pill's error notes float beside it, and Tab skips group rows and never applies an invalid draft", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await household(app.url);
  await openBuckets(page, app.url, budgetId);

  const gifts = pill(page, "Gifts");
  await gifts.focus();
  const fuelRow = rowOf(page, "Fuel");
  const before = (await fuelRow.boundingBox())!.y;
  const note = rowOf(page, "Gifts").getByRole("alert");

  await gifts.pressSequentially("500");
  assert.equal(compact(await note.innerText()), "Only $400.00 is ready to assign. You can add up to that.");
  assert.equal(await gifts.getAttribute("aria-invalid"), "true");
  assert.equal((await fuelRow.boundingBox())!.y, before, "The note never pushes rows down.");
  const noteBox = (await note.boundingBox())!;
  const pillBox = (await gifts.boundingBox())!;
  assert.ok(noteBox.x + noteBox.width <= pillBox.x, "The note sits beside the pill.");

  await gifts.fill("");
  await gifts.pressSequentially("-150");
  assert.equal(compact(await note.innerText()), "Gifts has $100.00 available. You can take up to that.");
  assert.equal((await fuelRow.boundingBox())!.y, before);
  await gifts.fill("");
  await gifts.pressSequentially("12.345");
  assert.equal(compact(await note.innerText()), "Use at most two decimal places, like 20.50.");
  await gifts.fill("");
  await gifts.pressSequentially("abc");
  assert.equal(compact(await note.innerText()), `Type an amount like 20, or ${MINUS}20 to take money out.`);
  // Enter refuses it.
  await gifts.press("Enter");
  assert.equal(await gifts.inputValue(), "abc");
  assert.equal(await readyText(page), "$400.00");

  // Tab with a valid draft applies it and moves to the next bucket, past the Everyday group row.
  const rent = pill(page, "Rent");
  await rent.focus();
  await rent.pressSequentially("10");
  await rent.press("Tab");
  assert.equal(await focusedLabel(page), "Add to or take from Gifts");
  await eventually(async () => assert.equal(await avail(page, "Rent"), "10.00"));
  assert.equal(await readyText(page), "$390.00");

  // An invalid draft is kept, not applied, and doesn't trap focus.
  await gifts.fill("");
  await gifts.pressSequentially("900");
  await gifts.press("Tab");
  assert.equal(await focusedLabel(page), "Add to or take from Fuel");
  assert.equal(await gifts.inputValue(), "900");
  assert.equal(await avail(page, "Gifts"), "100.00");
  assert.equal(await readyText(page), "$390.00");
  // Shift+Tab goes back the same way.
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focusedLabel(page), "Add to or take from Gifts");
  assert.equal(await gifts.inputValue(), "900");
  assert.deepEqual(app.pageErrors, []);
});

test("a goal's panel shows this month's assigned of its monthly share, and no share once the goal is reached", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await household(app.url);
  // Vacation wants 3,000 ten months out: 300 per month. Bike's 100 was all saved last month.
  const monthOf = (offset: number) => {
    const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  };
  const buckets = `/api/budgets/${budgetId}/buckets`;
  const vacation = await send(app.url, buckets, { name: "Vacation", newGroupName: "Goals", type: "goal", amount: 300_000, goalMonth: monthOf(9) });
  const bike = await send(app.url, buckets, { name: "Bike", groupId: vacation.groupId, type: "goal", amount: 10_000, goalMonth: monthOf(3) });
  await send(app.url, `/api/budgets/${budgetId}/accounts`, { name: "Savings", type: "savings", startingBalance: 10_000, startingDate: `${monthOf(-1)}-01` });
  await send(app.url, `/api/buckets/${bike.id}/assign`, { month: monthOf(-1), amount: 10_000 }, 200);
  await openBuckets(page, app.url, budgetId);

  await pill(page, "Vacation").focus();
  const panel = rowOf(page, "Vacation").locator(".rpanel");
  await panel.waitFor();
  assert.match(compact(await panel.innerText()), /Assigned this month 0\.00 of 300\.00/);
  await pill(page, "Vacation").pressSequentially("50");
  assert.match(compact(await panel.innerText()), /Assigned this month 0\.00 → 50\.00 of 300\.00/);
  await pill(page, "Vacation").press("Escape");

  await pill(page, "Bike").focus();
  const reached = rowOf(page, "Bike").locator(".rpanel");
  await reached.waitFor();
  assert.match(compact(await reached.innerText()), /Assigned this month 0\.00 Spent/);
  assert.doesNotMatch(await reached.innerText(), / of /);

  // On a phone the bucket sheet gives the share a line of its own, as a recurring bucket's sheet gives its amount.
  await page.setViewportSize({ width: 390, height: 844 });
  const by = (months: number) => new Date(now.getFullYear(), now.getMonth() + months, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const context = async (name: string) => {
    await rowOf(page, name).click();
    const sheet = page.getByRole("dialog", { name });
    await sheet.waitFor();
    const lines = await sheet.locator(".ctx > span").allInnerTexts();
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "hidden" });
    return lines;
  };
  assert.deepEqual(await context("Vacation"), [`$3,000.00 by ${by(9)}`, "$300.00 per month", "Assigned 0.00 · Spent 0.00"]);
  assert.deepEqual(await context("Bike"), [`$100.00 by ${by(3)}`, "Assigned 0.00 · Spent 0.00"]);
  assert.deepEqual(await context("Fuel"), ["$160.00 per month", "Assigned 0.00 · Spent 0.00"]);
  assert.deepEqual(app.pageErrors, []);
});

test("a take is limited by what a later month still needs, as the server says", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, gifts } = await household(app.url);
  // Next month takes 70.00 of Gifts' 100.00 back, so this month can only give up 30.00 more.
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  await send(app.url, `/api/buckets/${gifts.id}/assign`, { month: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`, amount: -7_000 }, 200);
  await openBuckets(page, app.url, budgetId);

  const pillIn = pill(page, "Gifts");
  await pillIn.focus();
  await pillIn.pressSequentially("-50");
  assert.equal(compact(await rowOf(page, "Gifts").getByRole("alert").innerText()), "Gifts has $30.00 available. You can take up to that.");
  assert.equal(await avail(page, "Gifts"), "100.00");
  assert.deepEqual(app.pageErrors, []);
});

test("a negative Ready to assign is overspent red wherever it shows, and the strip follows a preview across zero", { timeout: 60_000 }, async (t) => {
  const over = "rgb(179, 36, 59)"; // --over, light
  const colourOf = (locator: ReturnType<Page["locator"]>) => locator.evaluate((node) => getComputedStyle(node).color);
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await household(app.url);
  // A card owing 500.00 puts Ready to assign at −100.00.
  await send(app.url, `/api/budgets/${budgetId}/accounts`, { name: "Visa", type: "credit-card", startingBalance: -50_000, startingDate: `${current}-01` });
  await openBuckets(page, app.url, budgetId);
  const strip = page.getByRole("region", { name: "Month summary" }).locator(".ready");
  assert.equal(await readyText(page), `${MINUS}$100.00`);
  assert.equal(await colourOf(readyFigure(page)), over);

  // Taking 100.00 back previews $0.00: no longer red. Clearing the draft brings the red back.
  const gifts = pill(page, "Gifts");
  await gifts.focus();
  await gifts.pressSequentially("-100");
  assert.equal(await readyText(page), "$0.00");
  assert.equal(await strip.evaluate((node) => node.classList.contains("neg")), false);
  // The panel's before figure is negative, so it is red too.
  const before = rowOf(page, "Gifts").locator(".rpanel dd").filter({ hasText: `${MINUS}$100.00` }).locator(".neg");
  assert.equal(await colourOf(before), over);
  await gifts.press("Escape");
  assert.equal(await readyText(page), `${MINUS}$100.00`);
  assert.equal(await strip.evaluate((node) => node.classList.contains("neg")), true);

  // On a phone, the sheet's Ready to assign is red too.
  await page.setViewportSize({ width: 390, height: 844 });
  await rowOf(page, "Fuel").click();
  const sheet = page.getByRole("dialog", { name: "Fuel" });
  await sheet.waitFor();
  const figure = sheet.locator(".preview strong");
  assert.equal(compact(await figure.innerText()), `${MINUS}$100.00`);
  assert.equal(await colourOf(figure), over);
  assert.deepEqual(app.pageErrors, []);
});

test("a refused amount is only refused until the draft changes", { timeout: 60_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, gifts } = await household(app.url);
  await openBuckets(page, app.url, budgetId);

  // Elsewhere, all 400.00 goes to Gifts, so the server refuses the pill's 50.00 the page still thinks it has.
  await send(app.url, `/api/buckets/${gifts.id}/assign`, { month: current, amount: 40_000 }, 200);
  const fuel = pill(page, "Fuel");
  await fuel.focus();
  await fuel.pressSequentially("50");
  await fuel.press("Enter");
  const note = rowOf(page, "Fuel").getByRole("alert");
  await note.locator("span", { hasText: "Nothing is ready to assign." }).waitFor();
  assert.equal(await fuel.inputValue(), "50");

  // The money comes back; editing the draft drops the old refusal, so the same amount applies.
  await send(app.url, `/api/buckets/${gifts.id}/assign`, { month: current, amount: -40_000 }, 200);
  await fuel.press("Backspace");
  await fuel.pressSequentially("0");
  assert.equal(await fuel.getAttribute("aria-invalid"), "false");
  await fuel.press("Enter");
  await eventually(async () => assert.equal(await avail(page, "Fuel"), "50.00"));
  assert.deepEqual(app.pageErrors, []);
});

for (const scheme of ["light", "dark"] as const) {
  test(`at 390px in the ${scheme} theme a row opens the bucket sheet's Add / take tab`, { timeout: 60_000 }, async (t) => {
    const app = await openApp(t, { colorScheme: scheme, width: 390, height: 844 });
    const { page } = app;
    const { budgetId } = await household(app.url);
    // Stand-in for the on-screen keyboard: a visual viewport the test can shrink.
    await page.addInitScript(() => {
      const viewport = new EventTarget();
      const state = window as unknown as { fakeKeyboard?: number };
      Object.defineProperties(viewport, {
        height: { get: () => window.innerHeight - (state.fakeKeyboard ?? 0) },
        width: { get: () => window.innerWidth },
        offsetTop: { get: () => 0 },
        offsetLeft: { get: () => 0 },
        scale: { get: () => 1 },
      });
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    });
    await openBuckets(page, app.url, budgetId);
    assert.equal(await pill(page, "Fuel").isVisible(), false, "Phones have no pill.");

    await rowOf(page, "Fuel").click();
    const sheet = page.getByRole("dialog", { name: "Fuel" });
    await sheet.waitFor();
    assert.equal(await sheet.getByRole("tab", { name: "Add / take" }).getAttribute("aria-selected"), "true");
    assert.match(compact(await sheet.locator(".sheet-fig").innerText()), /Available 0\.00/);
    assert.match(compact(await sheet.locator(".sheet-fig").innerText()), /Assigned 0\.00 · Spent 0\.00/);
    assert.doesNotMatch(await sheet.innerText(), /Carried in/i);
    const amount = sheet.getByRole("textbox", { name: "Amount to add to Fuel" });
    assert.equal(await focusedLabel(page), "Amount to add to Fuel");

    // The Fill chip fills the month's need; Apply names the change.
    const fill = sheet.getByRole("button", { name: "Fill 160.00" });
    await fill.click();
    assert.equal(await amount.inputValue(), "160.00");
    assert.match(compact(await sheet.locator(".preview").innerText()), /Available after 160\.00/);
    assert.match(compact(await sheet.locator(".preview").innerText()), /Ready to assign after \$240\.00/);
    const apply = sheet.getByRole("button", { name: "Add $160.00 to Fuel" });
    for (const target of [fill, apply, sheet.getByRole("radio", { name: "Add" }), sheet.getByRole("radio", { name: "Take" }), sheet.getByRole("button", { name: "Close" })]) {
      const size = (await target.boundingBox())!;
      assert.ok(size.width >= 44 && size.height >= 44, `${await target.innerText()} ${size.width}x${size.height}`);
    }
    assert.equal(await noHorizontalScroll(page), true);

    // The sheet follows the on-screen keyboard.
    await page.evaluate(() => {
      (window as unknown as { fakeKeyboard: number }).fakeKeyboard = 300;
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await eventually(async () => {
      const edge = (await sheet.boundingBox())!;
      assert.ok(Math.abs(edge.y + edge.height - (844 - 300)) <= 1, `sheet bottom at ${edge.y + edge.height}`);
    });
    await page.evaluate(() => {
      (window as unknown as { fakeKeyboard: number }).fakeKeyboard = 0;
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });

    await apply.click();
    await sheet.waitFor({ state: "detached" });
    await eventually(async () => assert.equal(compact(await snack(page).locator(".msg").innerText()), "Added $160.00 to Fuel."));
    await eventually(async () => assert.equal(await avail(page, "Fuel"), "160.00"));
    assert.equal(await readyText(page), "$240.00");

    // Take: the toggle stands in for the minus key; the limit is the bucket's Available.
    await rowOf(page, "Fuel").click();
    await sheet.waitFor();
    await sheet.getByRole("radio", { name: "Take" }).click();
    const take = sheet.getByRole("textbox", { name: "Amount to take from Fuel" });
    assert.equal(await focusedLabel(page), "Amount to take from Fuel");
    await take.pressSequentially("200");
    assert.equal(compact(await sheet.locator(".preview").innerText()), "Fuel has $160.00 available. You can take up to that.");
    await take.fill("20");
    await sheet.getByRole("button", { name: "Take $20.00 from Fuel" }).click();
    await sheet.waitFor({ state: "detached" });
    await eventually(async () => assert.equal(await avail(page, "Fuel"), "140.00"));
    assert.equal(await readyText(page), "$260.00");

    // Edit is still a tap away, from the sheet.
    await rowOf(page, "Fuel").click();
    await sheet.getByRole("button", { name: "Edit Fuel" }).click();
    await page.getByRole("dialog", { name: "Edit Fuel" }).waitFor();
    assert.equal(await noHorizontalScroll(page), true);
    assert.deepEqual(app.pageErrors, []);
  });
}
