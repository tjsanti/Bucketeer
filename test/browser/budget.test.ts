import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("the UI distinguishes a saved budget with a stale list from a failed save", { timeout: 30_000 }, async (t) => {
  const server = spawn(process.execPath, [resolve("dist/server.js")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: ":memory:" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(server, "exit");
  let stderr = "";
  server.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    await exited;
  });
  const lines = createInterface({ input: server.stdout });
  const line = await Promise.race([
    once(lines, "line").then(([value]) => String(value)),
    exited.then(() => { throw new Error(`Server exited before listening: ${stderr}`); }),
  ]);
  lines.close();
  const port = /port (\d+)/.exec(line)?.[1];
  assert.ok(port, line);
  const url = `http://127.0.0.1:${port}`;
  const browserPath = process.env.BUCKETEER_BROWSER_PATH;
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let failList = false;
  await page.route("**/api/budgets", async (route) => {
    if (failList && route.request().method() === "GET") {
      await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Budget list is temporarily unavailable." } } });
    } else {
      await route.continue();
    }
  });

  await page.goto(url);
  await page.locator("#save-budget:enabled").waitFor();
  failList = true;
  await page.getByLabel("Budget name").fill("Household");
  await page.getByRole("button", { name: "Save budget", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.locator("#save-budget:enabled").waitFor();
  assert.equal(await page.locator("#save-message").textContent(), "Saved");
  assert.match(await page.getByRole("alert").innerText(), /budget was saved.*list could not refresh/);
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Household");
  const savedUrl = page.url();
  const id = new URL(savedUrl).hash.slice(1);
  assert.ok(id);
  const savedResponse = await fetch(`${url}/api/budgets/${id}`);
  assert.equal(savedResponse.status, 200);
  assert.equal((await savedResponse.json()).name, "Household");

  failList = false;
  await page.reload();
  await page.locator("#save-budget:enabled").waitFor();
  assert.equal(await page.getByLabel("Budget name").inputValue(), "Household");
  assert.equal(await page.locator("#budget-list li").count(), 1);

  // A rejected rename must retain the user's input without claiming it was saved.
  await page.route("**/api/budgets/*", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Saving is temporarily unavailable." } } });
    } else {
      await route.continue();
    }
  });
  await page.getByLabel("Budget name").fill("Family & <budget>");
  await page.getByRole("button", { name: "Save budget", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.locator("#save-budget:enabled").waitFor();
  assert.equal(await page.locator("#save-message").textContent(), "");
  assert.equal(await page.getByRole("alert").innerText(), "Saving is temporarily unavailable.");
  assert.equal(await page.getByLabel("Budget name").inputValue(), "Family & <budget>");
  assert.equal((await (await fetch(`${url}/api/budgets/${id}`)).json()).name, "Household");

  await page.unroute("**/api/budgets/*");
  await page.getByRole("button", { name: "Save budget", exact: true }).click();
  await page.locator("#save-budget:enabled").waitFor();
  assert.equal(await page.locator("#save-message").textContent(), "Saved");
  assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Family & <budget>");
  assert.equal(await page.locator("#budget-list li").count(), 1);
  assert.equal(page.url(), savedUrl);

  await page.getByRole("button", { name: "+ New", exact: true }).click();
  await page.getByLabel("Budget name").fill("Work");
  await page.getByRole("button", { name: "Save budget", exact: true }).click();
  await page.locator("#save-budget:enabled").waitFor();
  assert.equal(await page.locator("#budget-list li").count(), 2);
  await page.getByRole("link", { name: /^Family & <budget> Saved/ }).click();
  await page.waitForFunction(() => (document.getElementById("budget-name") as HTMLInputElement).value === "Family & <budget>");
  await page.locator("#save-budget:enabled").waitFor();
  assert.equal(await page.getByLabel("Budget name").inputValue(), "Family & <budget>");
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(pageErrors, []);
});
