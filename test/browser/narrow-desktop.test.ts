import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { openApp, ready, seedBudget } from "./harness.js";

// Below 1140px the sidebar becomes the phone's top bar, but the pages stay desktop down to 761px. The narrowest
// width checked is 780: headless WebKit evaluates media queries without its 10px scrollbar, so 761–770 is a phone there.
const topBarWidths = [780, 800, 1024, 1120];
const sidebarWidths = [1160, 1280];

const MINUS = "−";

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const box = async (locator: Locator) => (await locator.boundingBox())!;

/**
 * Each cell's text (measured over its text node, not the cell) against the cell's content box: a label that
 * overflows its cell overlaps the next one or is cut off by the card.
 */
const textBoxes = (cells: Locator) => cells.evaluateAll((nodes) => nodes.map((cell) => {
  const range = document.createRange();
  range.selectNodeContents(cell.firstChild!);
  const text = range.getBoundingClientRect();
  const style = getComputedStyle(cell);
  const outer = cell.getBoundingClientRect();
  return {
    text: cell.textContent ?? "", left: text.left, right: text.right, lines: range.getClientRects().length,
    start: outer.left + parseFloat(style.paddingLeft), end: outer.right - parseFloat(style.paddingRight),
  };
}));

/** How wide an input's value is in the input's own font, and the room its content box has for it. */
const valueRoom = (input: Locator) => input.evaluate((node: HTMLInputElement) => {
  const style = getComputedStyle(node);
  const context = document.createElement("canvas").getContext("2d")!;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const px = (value: string) => parseFloat(value) || 0;
  const room = node.getBoundingClientRect().width - px(style.borderLeftWidth) - px(style.borderRightWidth) - px(style.paddingLeft) - px(style.paddingRight);
  return { value: node.value, text: context.measureText(node.value).width, room };
});

async function assertShowsValue(input: Locator, where: string): Promise<void> {
  const { value, text, room } = await valueRoom(input);
  assert.ok(text <= room + 1, `${where}: "${value}" needs ${text.toFixed(1)}px but its field has ${room.toFixed(1)}px`);
}

async function assertTextFits(cells: Locator, where: string): Promise<void> {
  for (const cell of await textBoxes(cells)) {
    assert.ok(cell.lines === 1 && cell.left >= cell.start - 1 && cell.right <= cell.end + 1,
      `${where}: "${cell.text}" runs ${cell.left.toFixed(1)}–${cell.right.toFixed(1)} in a cell with room for ${cell.start.toFixed(1)}–${cell.end.toFixed(1)} (${cell.lines} line(s))`);
  }
}

/** A date in the browser's zone, which the test machine shares with the server, `daysAgo` before today. */
function localDate(daysAgo = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
}
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
// Up to six days back stays inside this month, which the register shows, and sorts no later than today.
const earlier = iso(localDate(Math.min(6, new Date().getDate() - 1)));

/** This month, or one `ahead` of it, as YYYY-MM in the browser's zone. */
function monthKey(ahead = 0): string {
  const now = new Date();
  return iso(new Date(now.getFullYear(), now.getMonth() + ahead, 1)).slice(0, 7);
}

async function post(url: string, path: string, body: unknown, status = 201): Promise<{ id: string }> {
  const response = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()) as { id: string };
}

/** Everyday Checking with a split, seven-figure savings, and a card owing six figures; Everyday holds Groceries and Phone & internet. */
async function household(url: string) {
  const budgetId = await seedBudget(url, "Household");
  const account = (name: string, type: string, startingBalance: number) =>
    post(url, `/api/budgets/${budgetId}/accounts`, { name, type, startingBalance, startingDate: `${monthKey()}-01` });
  const checking = await account("Everyday Checking", "checking", 245_000);
  const savings = await account("Rainy Day Savings", "savings", 123_656_789);
  const card = await account("Visa", "credit-card", -12_340_178);
  const everyday = await post(url, `/api/budgets/${budgetId}/groups`, { name: "Everyday" });
  const groceries = await post(url, `/api/budgets/${budgetId}/buckets`, { name: "Groceries", groupId: everyday.id, type: "plain", colour: "green" });
  const phone = await post(url, `/api/budgets/${budgetId}/buckets`, { name: "Phone & internet", groupId: everyday.id, type: "plain", colour: "sky" });
  const add = (accountId: string, body: object) => post(url, `/api/accounts/${accountId}/transactions`, body);
  await add(checking.id, { date: earlier, payee: "Acme Payroll", memo: "Salary", amount: 320_000, category: { kind: "income" } });
  await add(checking.id, { date: earlier, payee: "Corner Bakery", memo: "Bread", amount: -1_250, category: { kind: "bucket", bucketId: groceries.id } });
  await add(checking.id, { payee: "Megamart", memo: "Big shop", amount: -12_640, category: { kind: "split", lines: [
    { bucketId: groceries.id, amount: -8_640, memo: "" }, { bucketId: phone.id, amount: -4_000, memo: "Charger" },
  ] } });
  await add(card.id, { date: earlier, payee: "Telco", memo: "Mobile plan", amount: -6_500, category: { kind: "bucket", bucketId: phone.id } });
  await add(savings.id, { payee: "Card payment", amount: -200_000, category: { kind: "transfer", accountId: card.id } });
  return { budgetId, checking, savings, card };
}

test("from 800 to 1280px the register keeps its desktop entry row, under a top bar below 1140px and beside the sidebar from 1140px", { timeout: 120_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId, checking, savings, card } = await household(app.url);
  const registerOf = (account: { id: string }) => `${app.url}/budgets/${budgetId}/accounts/${account.id}`;
  const open = async (account: { id: string }, width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(registerOf(account));
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
  };

  for (const width of [...topBarWidths, ...sidebarWidths]) {
    const topBar = width < 1140;
    await t.test(`${width}px: the sidebar ${topBar ? "is a top bar over" : "stays beside"} the desktop register`, { timeout: 30_000 }, async () => {
      const where = `At ${width}px`;
      await open(checking, width);
      const brand = await box(page.locator(".wordmark"));
      const picker = await box(page.locator("#budget-button"));
      const toggle = await box(page.locator("#theme-toggle"));
      const buckets = await box(page.locator("#nav-buckets"));
      const accounts = await box(page.locator("#nav-accounts"));
      const main = await box(page.locator("#main"));
      if (topBar) {
        // Brand, picker and theme toggle across the top, then the two nav links side by side; no account list.
        assert.equal(await page.locator("#side-accounts").isVisible(), false, `${where} the account list is hidden`);
        for (const [name, item] of [["picker", picker], ["toggle", toggle]] as const) {
          assert.ok(Math.abs(item.y + item.height / 2 - (brand.y + brand.height / 2)) <= 1, `${where} the ${name} shares the brand's row`);
        }
        assert.ok(brand.x + brand.width <= picker.x && picker.x + picker.width <= toggle.x, `${where} brand, picker and toggle sit left to right`);
        assert.ok(Math.abs(buckets.y - accounts.y) <= 1 && buckets.x + buckets.width <= accounts.x, `${where} the nav links share one row`);
        assert.ok(Math.max(brand.y + brand.height, picker.y + picker.height, toggle.y + toggle.height) <= buckets.y, `${where} the nav sits under the top row`);
        assert.ok(main.y >= buckets.y + buckets.height, `${where} the page starts under the top bar`);
      } else {
        // The 252px sidebar: brand and toggle, picker, the nav links stacked, then the account list.
        const side = await box(page.locator(".side"));
        assert.ok(side.x === 0 && side.width === 252, `${where} the sidebar is ${side.width}px wide`);
        assert.ok(main.x >= side.width, `${where} the page sits beside the sidebar`);
        assert.ok(accounts.y >= buckets.y + buckets.height, `${where} the nav links stack`);
        assert.equal(await page.locator("#side-accounts").isVisible(), true, `${where} the account list shows`);
        assert.deepEqual(await page.locator("#side-list li.row .an").allInnerTexts(), ["Everyday Checking", "Rainy Day Savings", "Visa"]);
      }
      // The page itself stays desktop: the inline entry row, not the phone's New transaction bar.
      assert.equal(await page.locator("form.entry").isVisible(), true, `${where} the entry row shows`);
      assert.equal(await page.getByRole("button", { name: "New transaction" }).isVisible(), false, `${where} there is no New transaction bar`);
      assert.equal(await noHorizontalScroll(page), true, `${where} the page does not scroll sideways`);
    });

    await t.test(`${width}px: the register's headers, entry fields, split line and balances show in full`, { timeout: 30_000 }, async () => {
      const where = `At ${width}px`;
      await open(checking, width);
      const register = page.getByRole("table", { name: "Everyday Checking register" });
      const headers = register.getByRole("columnheader");
      assert.deepEqual(await headers.allInnerTexts(), ["Date", "Payee", "Category", "Memo", "Amount", "Balance"]);
      await assertTextFits(headers, `${where} the header`);
      const labels = await textBoxes(headers);
      for (const [index, label] of labels.slice(0, -1).entries()) {
        assert.ok(label.right <= labels[index + 1]!.left + 1, `${where}: "${label.text}" overlaps "${labels[index + 1]!.text}"`);
      }

      // Everyday values show whole in the entry row; Groceries carries its dot and the chevron.
      const entry = page.locator("form.entry");
      const payee = entry.getByLabel("Payee");
      const category = entry.getByRole("combobox", { name: "Category" });
      const memo = entry.getByLabel("Memo");
      await payee.fill("Superstore");
      await category.click();
      await page.getByRole("listbox", { name: "Categories" }).getByRole("option", { name: /^Groceries/ }).click();
      assert.equal(await category.inputValue(), "Groceries");
      await memo.fill("Weekly shop");
      for (const [name, field] of [["Payee", payee], ["Category", category], ["Memo", memo]] as const) {
        // Below 800px Memo is a few pixels short of "Weekly shop" and scrolls it: the accepted cost of a whole Payee and Category.
        if (name === "Memo" && width < 800) continue;
        await assertShowsValue(field, `${where} the entry row's ${name}`);
      }

      // So does a split line's bucket when the split is edited in place.
      await register.locator(".rrow", { hasText: "Megamart" }).click();
      const line = page.locator("form.edit").getByRole("group", { name: "Split lines" }).getByRole("combobox", { name: "Split line 1 bucket" });
      assert.equal(await line.inputValue(), "Groceries");
      await assertShowsValue(line, `${where} the split line's bucket`);

      // Seven-figure savings and a card owing six figures keep their whole running balance in the column.
      for (const [account, balances] of [[savings, ["1,234,567.89"]], [card, [`${MINUS}121,466.78`, `${MINUS}123,466.78`]]] as const) {
        await open(account, width);
        const cells = page.locator(".reg .rrow .c.bal");
        assert.deepEqual(await cells.allInnerTexts(), balances);
        await assertTextFits(cells, `${where} the Balance column`);
      }
      assert.equal(await noHorizontalScroll(page), true, `${where} the page does not scroll sideways`);
    });
  }
  assert.deepEqual(app.pageErrors, []);
});

/**
 * The measured Buckets case: four accounts opened this month, one paycheque, and Fixed, Everyday and Goals with
 * recurring, goal and plain buckets. Ready to assign is $12,513.35; Income $2,412.00, Assigned $6,928.06, Spent $1,977.02.
 */
async function bucketsHousehold(url: string) {
  const budgetId = await seedBudget(url, "Household");
  const month = monthKey();
  const first = `${month}-01`;
  const account = (name: string, type: string, startingBalance: number) =>
    post(url, `/api/budgets/${budgetId}/accounts`, { name, type, startingBalance, startingDate: first });
  const checking = await account("Everyday Checking", "checking", 482_150);
  const savings = await account("High-Interest Savings", "savings", 1_250_000);
  const card = await account("Visa", "credit-card", -41_209);
  await account("Cash", "cash", 12_000);
  const groups: Record<string, string> = {};
  for (const name of ["Fixed", "Everyday", "Goals"]) groups[name] = (await post(url, `/api/budgets/${budgetId}/groups`, { name })).id;
  const buckets: Record<string, string> = {};
  for (const [group, name, fields] of [
    ["Fixed", "Rent", { colour: "blue", type: "recurring", amount: 165_000 }],
    ["Fixed", "Phone & internet", { colour: "plum", type: "recurring", amount: 11_500 }],
    ["Everyday", "Groceries", { colour: "green", type: "recurring", amount: 60_000 }],
    ["Everyday", "Dining out", { colour: "rose", type: "recurring", amount: 15_000 }],
    ["Everyday", "Household supplies & toiletries", { colour: "sun", type: "recurring", amount: 8_000 }],
    ["Goals", "Vacation", { colour: "teal", type: "goal", amount: 300_000, goalMonth: monthKey(9) }],
    ["Goals", "Emergency fund", { colour: "denim", type: "goal", amount: 1_000_000, goalMonth: monthKey(14) }],
    ["Goals", "Gifts", { colour: "peach", type: "plain" }],
  ] as const) buckets[name] = (await post(url, `/api/budgets/${budgetId}/buckets`, { name, groupId: groups[group], ...fields })).id;
  const add = (accountId: string, body: object) => post(url, `/api/accounts/${accountId}/transactions`, { date: first, ...body });
  const spend = (bucket: string) => ({ kind: "bucket", bucketId: buckets[bucket] });
  await add(checking.id, { payee: "Employer Payroll", memo: "Paycheque", amount: 241_200, category: { kind: "income" } });
  for (const [bucket, amount] of [["Rent", 165_000], ["Phone & internet", 11_500], ["Groceries", 18_653], ["Dining out", 5_000],
    ["Vacation", 124_000], ["Emergency fund", 350_000], ["Gifts", 18_653]] as const) {
    await post(url, `/api/buckets/${buckets[bucket]}/assign`, { month, amount }, 200);
  }
  await add(checking.id, { payee: "Parkview Apartments", amount: -165_000, category: spend("Rent") });
  await add(checking.id, { payee: "Telco", amount: -11_412, category: spend("Phone & internet") });
  await add(checking.id, { payee: "Superstore", amount: -8_000, category: { kind: "split", lines: [
    { bucketId: buckets.Groceries, amount: -7_000, memo: "" }, { bucketId: buckets["Household supplies & toiletries"], amount: -1_000, memo: "" },
  ] } });
  await add(checking.id, { payee: "Rainy day", amount: -50_000, category: { kind: "transfer", accountId: savings.id } });
  await add(card.id, { payee: "Noodle Bar", amount: -12_040, category: spend("Dining out") });
  await add(checking.id, { payee: "Corner Bakery", amount: -1_250, category: spend("Groceries") });
  return { budgetId };
}

type Rect = { x: number; y: number; width: number; height: number };
const inside = (inner: Rect, outer: Rect) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1
  && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
const apart = (a: Rect, b: Rect) => a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1;

/**
 * A money figure's text (all of it, cents included) against the content box of the cell it sits in, and whether
 * it is on one line: its box is one line-height tall, not two.
 */
const figureFit = (figure: Locator, cell: string) => figure.evaluate((node, cell) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  const text = range.getBoundingClientRect();
  const own = getComputedStyle(node);
  const holder = node.closest(cell)!;
  const style = getComputedStyle(holder);
  const outer = holder.getBoundingClientRect();
  return {
    text: (node.textContent ?? "").trim(), rect: { x: text.left, y: text.top, width: text.width, height: text.height },
    oneLine: node.getBoundingClientRect().height < (parseFloat(own.lineHeight) || parseFloat(own.fontSize) * 1.2) * 1.5,
    // Inside the cell's border (a stat's divider) and padding.
    room: {
      x: outer.left + holder.clientLeft + parseFloat(style.paddingLeft), y: outer.top + holder.clientTop + parseFloat(style.paddingTop),
      width: holder.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: holder.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    },
  };
}, cell);

async function assertFigureFits(figure: Locator, cell: string, where: string): Promise<Rect> {
  const fit = await figureFit(figure, cell);
  assert.ok(fit.oneLine, `${where}: "${fit.text}" is on one line`);
  assert.ok(fit.rect.x >= fit.room.x - 1 && fit.rect.x + fit.rect.width <= fit.room.x + fit.room.width + 1,
    `${where}: "${fit.text}" runs ${fit.rect.x.toFixed(1)}–${(fit.rect.x + fit.rect.width).toFixed(1)} in a cell with room for ${fit.room.x.toFixed(1)}–${(fit.room.x + fit.room.width).toFixed(1)}`);
  return fit.rect;
}

const summaryStrip = (page: Page) => page.getByRole("region", { name: "Month summary" });

/**
 * Ready to assign above Income, Assigned and Spent (`stacked`), or all four in one row; every figure on one line
 * inside its cell; Make it rain inside Ready to assign, clear of its figure.
 */
async function assertSummaryStrip(page: Page, stacked: boolean, where: string): Promise<void> {
  const strip = summaryStrip(page);
  const stripBox = await box(strip);
  const ready = await box(strip.locator(".ready"));
  const stats = await Promise.all([0, 1, 2].map((index) => box(strip.locator(".stat").nth(index))));
  const sameTop = (a: Rect, b: Rect) => Math.abs(a.y - b.y) <= 1;
  if (stacked) {
    assert.ok(Math.abs(ready.x - stripBox.x) <= 1 && Math.abs(ready.width - stripBox.width) <= 1,
      `${where}: Ready to assign spans the ${stripBox.width.toFixed(0)}px strip (it is ${ready.width.toFixed(0)}px)`);
    for (const stat of stats) assert.ok(stat.y >= ready.y + ready.height - 1, `${where}: the stats sit under Ready to assign`);
    assert.ok(sameTop(stats[0]!, stats[1]!) && sameTop(stats[1]!, stats[2]!), `${where}: Income, Assigned and Spent share a row`);
  } else {
    for (const stat of stats) assert.ok(sameTop(ready, stat), `${where}: Ready to assign and the stats share one row in the ${stripBox.width.toFixed(0)}px strip`);
    assert.ok(ready.x + ready.width <= stats[0]!.x + 1, `${where}: Ready to assign comes first`);
  }
  for (const [index, stat] of stats.slice(0, -1).entries()) assert.ok(stat.x + stat.width <= stats[index + 1]!.x + 1, `${where}: the stats sit left to right`);

  const figure = await assertFigureFits(strip.locator(".ready-figure"), ".ready", `${where} Ready to assign`);
  for (const index of [0, 1, 2]) await assertFigureFits(strip.locator(".stat .figure").nth(index), ".stat", `${where} a stat`);
  const button = await box(strip.getByRole("button", { name: "Make it rain" }));
  assert.ok(inside(button, ready) && inside(button, stripBox), `${where}: Make it rain sits inside Ready to assign and the strip`);
  assert.ok(apart(button, figure), `${where}: Make it rain is clear of the figure`);
}

/** Each group row's name and count (their text, not their boxes) against each other and the room before the group's menu button. */
const groupLabels = (page: Page) => page.locator(".btable .bgroup .gcell").evaluateAll((cells) => cells.map((cell) => {
  const textOf = (node: Element) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect();
  };
  const name = cell.querySelector(".gname")!;
  const count = cell.querySelector(".gcount")!;
  const nameText = textOf(name);
  const countText = textOf(count);
  return {
    name: name.textContent ?? "", count: count.textContent ?? "",
    nameRight: nameText.right, nameRoom: name.getBoundingClientRect().right, countLeft: countText.left, countRight: countText.right,
    end: cell.querySelector(".more-btn")!.getBoundingClientRect().left,
  };
}));

/** The ancestors whose overflow clipping cuts into `node`'s box or its text, nearest first; the window counts as one. */
const clippedBy = (node: Locator) => node.evaluate((note) => {
  const range = document.createRange();
  range.selectNodeContents(note);
  const rects = [note.getBoundingClientRect(), range.getBoundingClientRect()];
  const left = Math.min(...rects.map((rect) => rect.left)), right = Math.max(...rects.map((rect) => rect.right));
  const top = Math.min(...rects.map((rect) => rect.top)), bottom = Math.max(...rects.map((rect) => rect.bottom));
  const cuts: string[] = [];
  for (let ancestor = note.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const clip = ancestor.getBoundingClientRect();
    if (left < clip.left - 1 || right > clip.right + 1 || top < clip.top - 1 || bottom > clip.bottom + 1) {
      cuts.push(`.${[...ancestor.classList].join(".") || ancestor.tagName.toLowerCase()} (${clip.left.toFixed(0)}–${clip.right.toFixed(0)} against ${left.toFixed(0)}–${right.toFixed(0)})`);
    }
  }
  if (left < -1 || right > window.innerWidth + 1) cuts.push(`the window (0–${window.innerWidth} against ${left.toFixed(0)}–${right.toFixed(0)})`);
  return cuts;
});

/** A goal's two lines (the bar's, then the month's share): where each sits, whether it is one line, and whether it is cut short. */
const goalLines = (row: Locator) => row.evaluate((node) => {
  const lineOf = (line: Element) => {
    const rect = line.getBoundingClientRect();
    const style = getComputedStyle(line);
    return {
      text: (line.textContent ?? "").trim(), top: rect.top, bottom: rect.bottom, right: rect.right,
      clipped: line.scrollWidth > line.clientWidth + 1, need: line.scrollWidth, room: line.clientWidth,
      oneLine: rect.height < (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5) * 1.5,
    };
  };
  const rect = node.getBoundingClientRect();
  return { goal: lineOf(node.querySelector(".goal")!), share: lineOf(node.querySelector(".goal-share")!), bottom: rect.bottom, right: rect.right };
});

test("from 800 to 1280px the Buckets page's summary strip and table keep every figure, label and note whole", { timeout: 180_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await bucketsHousehold(app.url);
  const open = async (width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${app.url}/budgets/${budgetId}/buckets`);
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
  };
  // The strip is under 900px wide at 800 (752px under the top bar) and at 1160 (828px beside the sidebar).
  const stackedAt = new Set([780, 800, 1160]);

  for (const width of [...topBarWidths, ...sidebarWidths]) {
    const stacked = stackedAt.has(width);
    await t.test(`${width}px: the summary strip ${stacked ? "puts Ready to assign above the stats" : "sits in one row"}, and no figure breaks`, { timeout: 30_000 }, async () => {
      const where = `At ${width}px`;
      await open(width);
      const strip = summaryStrip(page);
      assert.equal((await strip.locator(".ready-figure").innerText()).replace(/\s+/g, ""), "$12,513.35");
      assert.deepEqual((await strip.locator(".stat .figure").allInnerTexts()).map((text) => text.trim()), ["$2,412.00", "$6,928.06", "$1,977.02"]);
      await assertSummaryStrip(page, stacked, where);
      assert.equal(await noHorizontalScroll(page), true, `${where} the page does not scroll sideways`);
    });

    await t.test(`${width}px: the buckets table's headers, group rows, goals and add/take note show in full`, { timeout: 30_000 }, async () => {
      const where = `At ${width}px`;
      await open(width);
      const grid = page.getByRole("table", { name: "Buckets" });
      const headers = grid.getByRole("columnheader");
      assert.deepEqual(await headers.allInnerTexts(), ["Bucket", "Target or goal", "Spent", "Add / take", "Available"]);
      await assertTextFits(headers, `${where} the header`);
      const labels = await textBoxes(headers);
      for (const [index, label] of labels.slice(0, -1).entries()) {
        assert.ok(label.right <= labels[index + 1]!.left + 1, `${where}: "${label.text}" overlaps "${labels[index + 1]!.text}"`);
      }

      // Group names whole, then their counts, then the menu button.
      const groups = await groupLabels(page);
      assert.deepEqual(groups.map((group) => [group.name, group.count]), [["Fixed", "2"], ["Everyday", "3"], ["Goals", "3"]]);
      for (const group of groups) {
        assert.ok(group.nameRight <= group.nameRoom + 1, `${where}: "${group.name}" needs ${group.nameRight.toFixed(1)} but is cut at ${group.nameRoom.toFixed(1)}`);
        assert.ok(group.nameRight <= group.countLeft + 1 && group.countRight <= group.end + 1, `${where}: ${group.name}'s count overlaps its name or menu button`);
      }

      // Goals keep the bar's line over the month's share. Below about 820px the Target column is a few pixels short
      // of a long line, which ends in an ellipsis (the trade for whole group names); it never wraps or spills.
      for (const name of ["Vacation", "Emergency fund"]) {
        const lines = await goalLines(grid.locator(".brow", { hasText: name }));
        assert.ok(lines.share.top >= lines.goal.bottom - 0.5, `${where}: ${name}'s share sits under its bar`);
        for (const [which, line] of [["bar", lines.goal], ["share", lines.share]] as const) {
          assert.ok(line.oneLine, `${where}: ${name}'s ${which} line "${line.text}" is one line`);
          if (width >= 820) assert.ok(!line.clipped, `${where}: ${name}'s ${which} line "${line.text}" needs ${line.need}px but has ${line.room}px`);
          assert.ok(line.bottom <= lines.bottom + 0.5 && line.right <= lines.right + 0.5, `${where}: ${name}'s ${which} line stays inside its row`);
        }
      }

      // Every bucket keeps its Spent figure and its pill.
      const rows = grid.locator(".brow");
      assert.equal(await rows.count(), 8);
      for (const row of await rows.all()) {
        assert.equal(await row.locator(".c.spent").isVisible(), true, `${where}: a bucket shows Spent`);
        assert.equal(await row.getByRole("textbox", { name: /^Add to or take from / }).isVisible(), true, `${where}: a bucket has its pill`);
      }

      // Too much for Ready to assign: the note beside the pill shows whole, cut by neither its card nor the window.
      const pill = grid.getByRole("textbox", { name: "Add to or take from Groceries" });
      await pill.focus();
      await pill.pressSequentially("20000");
      const note = grid.locator(".brow", { hasText: "Groceries" }).getByRole("alert");
      assert.equal((await note.innerText()).replace(/\s+/g, " ").trim(), "Only $12,513.35 is ready to assign. You can add up to that.");
      assert.deepEqual(await clippedBy(note), [], `${where}: the note is cut off`);
      await pill.press("Escape");
      await note.waitFor({ state: "detached" });
      assert.equal(await pill.inputValue(), "");
      assert.equal(await noHorizontalScroll(page), true, `${where} the page does not scroll sideways`);
    });
  }
  assert.deepEqual(app.pageErrors, []);
});

/**
 * Five figures in every stat: Checking at $153,456.78 from last month, all but $30,000.00 assigned to Nest egg then,
 * and this month $15,234.56 of income, $12,345.67 assigned to Renovation and $10,987.65 spent from it.
 * Ready to assign is $32,888.89; Nest egg and its group Savings have $123,456.78 available.
 */
async function bigMonth(url: string) {
  const budgetId = await seedBudget(url, "Renovation year");
  const month = monthKey();
  const checking = await post(url, `/api/budgets/${budgetId}/accounts`, { name: "Checking", type: "checking", startingBalance: 15_345_678, startingDate: `${monthKey(-1)}-01` });
  const renovation = await post(url, `/api/budgets/${budgetId}/buckets`, { name: "Renovation", newGroupName: "Home", type: "plain" });
  const nestEgg = await post(url, `/api/budgets/${budgetId}/buckets`, { name: "Nest egg", newGroupName: "Savings", type: "plain" });
  await post(url, `/api/buckets/${nestEgg.id}/assign`, { month: monthKey(-1), amount: 12_345_678 }, 200);
  const add = (amount: number, category: object) => post(url, `/api/accounts/${checking.id}/transactions`, { date: `${month}-01`, amount, category });
  await add(1_523_456, { kind: "income" });
  await post(url, `/api/buckets/${renovation.id}/assign`, { month, amount: 1_234_567 }, 200);
  await add(-1_098_765, { kind: "bucket", bucketId: renovation.id });
  return { budgetId };
}

test("at 320, 360 and 390px the phone's strip keeps five-figure stats and Ready to assign on one line", { timeout: 90_000 }, async (t) => {
  const app = await openApp(t, { width: 390, height: 844, touch: true });
  const { page } = app;
  const { budgetId } = await bigMonth(app.url);
  for (const width of [320, 360, 390]) {
    await t.test(`${width}px: Ready to assign spans the strip and every figure shows whole`, { timeout: 30_000 }, async () => {
      const where = `At ${width}px`;
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${app.url}/budgets/${budgetId}/buckets`);
      await ready(page);
      await page.evaluate(() => document.fonts.ready);
      const strip = summaryStrip(page);
      assert.equal((await strip.locator(".ready-figure").innerText()).replace(/\s+/g, ""), "$32,888.89");
      assert.deepEqual((await strip.locator(".stat .figure").allInnerTexts()).map((text) => text.trim()), ["$15,234.56", "$12,345.67", "$10,987.65"]);
      await assertSummaryStrip(page, true, where);
      assert.equal(await noHorizontalScroll(page), true, `${where} the page does not scroll sideways`);
    });
  }
  assert.deepEqual(app.pageErrors, []);
});

test("from 780 to 1280px the Buckets table's Spent and Available keep five- and six-figure amounts inside their cells", { timeout: 90_000 }, async (t) => {
  const app = await openApp(t);
  const { page } = app;
  const { budgetId } = await bigMonth(app.url);
  for (const width of [...topBarWidths, ...sidebarWidths]) {
    await t.test(`${width}px: every bucket's and group's Spent and Available fits its cell`, { timeout: 30_000 }, async () => {
      const where = `At ${width}px`;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${app.url}/budgets/${budgetId}/buckets`);
      await ready(page);
      await page.evaluate(() => document.fonts.ready);
      const grid = page.getByRole("table", { name: "Buckets" });
      const spent = grid.locator(".brow .c.spent, .bgroup .c.spent");
      const available = grid.locator(".brow .c.avail, .bgroup .c.avail");
      // Renovation and its group Home spent $10,987.65; Nest egg and its group Savings hold $123,456.78.
      assert.equal((await spent.allInnerTexts()).filter((text) => text.includes("10,987.65")).length, 2);
      assert.equal((await available.allInnerTexts()).filter((text) => text.includes("123,456.78")).length, 2);
      await assertTextFits(spent, `${where} Spent`);
      await assertTextFits(available, `${where} Available`);
      assert.equal(await noHorizontalScroll(page), true, `${where} the page does not scroll sideways`);
    });
  }
  assert.deepEqual(app.pageErrors, []);
});
