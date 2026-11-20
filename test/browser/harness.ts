import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

/** Starts the built server on a free port with an in-memory database; stops it when the test ends. */
export async function startServer(t: TestContext): Promise<string> {
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
  return `http://127.0.0.1:${port}`;
}

/** Launches headless Chromium (or BUCKETEER_BROWSER_PATH); closes it when the test ends. */
export async function launchBrowser(t: TestContext): Promise<Browser> {
  const browserPath = process.env.BUCKETEER_BROWSER_PATH;
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  t.after(() => browser.close());
  return browser;
}

export interface App {
  url: string;
  page: Page;
  pageErrors: string[];
  foreignRequests: string[];
}

/** A fresh server and browser page; tracks page errors and requests that leave the app's origin. */
export async function openApp(t: TestContext, options: { colorScheme?: "light" | "dark"; width?: number; height?: number; touch?: boolean } = {}): Promise<App> {
  const url = await startServer(t);
  const browser = await launchBrowser(t);
  const context = await browser.newContext({
    colorScheme: options.colorScheme ?? "light",
    viewport: { width: options.width ?? 1280, height: options.height ?? 900 },
    reducedMotion: "reduce",
    ...(options.touch ? { hasTouch: true, isMobile: true } : {}),
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const foreignRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== url) foreignRequests.push(request.url());
  });
  return { url, page, pageErrors, foreignRequests };
}

/** Waits until the app has finished loading its route. */
export async function ready(page: Page): Promise<void> {
  await page.locator("#main:not([aria-busy])").waitFor();
}

export async function seedBudget(url: string, name: string): Promise<string> {
  const response = await fetch(`${url}/api/budgets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  assert.equal(response.status, 201);
  return ((await response.json()) as { id: string }).id;
}
