import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, firefox, webkit } from "playwright-core";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright-core";

/** Registers cleanup to run at the end: a test's context, or the screenshot script's own list. */
export interface Teardown {
  after(fn: () => unknown): void;
}

/**
 * Starts the built server on a free port with an in-memory database; stops it when the test ends. `timeZone`
 * sets its TZ; it shares the test machine's otherwise.
 */
export async function startServer(t: Teardown, timeZone?: string): Promise<string> {
  const server = spawn(process.execPath, [resolve("dist/server.js")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: ":memory:", ...(timeZone ? { TZ: timeZone } : {}) },
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

export type Engine = "chromium" | "webkit" | "firefox";

/**
 * The engine every browser test runs in, from BUCKETEER_BROWSER (chromium by default). `npm run test:ui` runs the
 * suite once per engine; a missing engine fails its tests rather than skipping them.
 */
export const engine: Engine = (() => {
  const value = process.env.BUCKETEER_BROWSER || "chromium";
  if (value === "chromium" || value === "webkit" || value === "firefox") return value;
  throw new Error(`BUCKETEER_BROWSER must be chromium, webkit or firefox, not "${value}".`);
})();

/**
 * Tab and Shift+Tab as a keyboard user presses them to reach buttons. On a Mac, Safari's Tab moves only between text
 * fields unless Keyboard navigation is on in System Settings, and Option-Tab reaches buttons too; Playwright's WebKit
 * follows the same setting.
 */
export const tabKeys: { next: string; previous: string } = (() => {
  if (engine !== "webkit" || process.platform !== "darwin") return { next: "Tab", previous: "Shift+Tab" };
  let mode = 0;
  try {
    mode = Number(execFileSync("defaults", ["read", "-g", "AppleKeyboardUIMode"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    // Unset: Keyboard navigation is off.
  }
  return mode & 2 ? { next: "Tab", previous: "Shift+Tab" } : { next: "Alt+Tab", previous: "Alt+Shift+Tab" };
})();

/**
 * A browser context in headless `which` engine (Chromium from BUCKETEER_BROWSER_PATH when set), closed with its
 * browser when the test ends. Firefox has no mobile emulation, so `isMobile` is dropped there: a phone is touch at the
 * phone's viewport, still with a mouse's hover.
 */
export async function openContext(t: Teardown, options: BrowserContextOptions = {}, which: Engine = engine): Promise<BrowserContext> {
  const browserPath = process.env.BUCKETEER_BROWSER_PATH;
  const browser = which === "chromium"
    ? await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) })
    : await { webkit, firefox }[which].launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext(which === "firefox" ? { ...options, isMobile: false } : options);
  if (which === "firefox") {
    // Playwright's Firefox crashes the page when its main-world and isolated-world scripts both read one element's
    // ariaLabelledByElements, as a role or label locator over an aria-labelledby element does for evaluateAll and
    // then any other call. The app never reads it; without it in the main world, Playwright reads aria-labelledby.
    await context.addInitScript(() => { Reflect.deleteProperty(Element.prototype, "ariaLabelledByElements"); });
  }
  if (options.hasTouch) {
    // A phone's scroll indicators overlay whatever they scroll (iOS ignores ::-webkit-scrollbar), but a desktop
    // engine emulating one still lays out its own scrollbars, narrowing the page and its scroll areas. Playwright's
    // Chromium already hides them.
    await context.addInitScript(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("* { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
  }
  return context;
}

export interface App {
  url: string;
  page: Page;
  pageErrors: string[];
  foreignRequests: string[];
}

/**
 * A fresh server and browser page; tracks page errors and requests that leave the app's origin. `serverTimeZone`
 * and `browserTimeZone` put the two in different zones; both share the test machine's otherwise. `touch` is a phone
 * with a touch screen. When the test ends the browser closes, then the server stops.
 */
export async function openApp(t: Teardown, options: {
  colorScheme?: "light" | "dark"; width?: number; height?: number; touch?: boolean; reducedMotion?: "reduce" | "no-preference";
  serverTimeZone?: string; browserTimeZone?: string;
} = {}): Promise<App> {
  const context = await openContext(t, {
    colorScheme: options.colorScheme ?? "light",
    viewport: { width: options.width ?? 1280, height: options.height ?? 900 },
    reducedMotion: options.reducedMotion ?? "reduce",
    ...(options.browserTimeZone ? { timezoneId: options.browserTimeZone } : {}),
    ...(options.touch ? { hasTouch: true, isMobile: true } : {}),
  });
  const url = await startServer(t, options.serverTimeZone);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const foreignRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== url) foreignRequests.push(request.url());
  });
  return { url, page, pageErrors, foreignRequests };
}

/** Waits until the app has finished loading its route, within `timeout` ms when given. */
export async function ready(page: Page, timeout?: number): Promise<void> {
  await page.locator("#main:not([aria-busy])").waitFor(timeout === undefined ? {} : { timeout });
}

export async function seedBudget(url: string, name: string): Promise<string> {
  const response = await fetch(`${url}/api/budgets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  assert.equal(response.status, 201);
  return ((await response.json()) as { id: string }).id;
}
