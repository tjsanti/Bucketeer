import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, firefox, webkit } from "playwright-core";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright-core";

// What the browser tests and scripts/screenshot.ts share. Node runs the script from the .ts files with its types
// stripped, so this file reads no test configuration and imports only packages and types.

/** Registers cleanup to run at the end: a test's context, or the screenshot script's own list. */
export interface Teardown {
  after(fn: () => unknown): void;
}

/** The browser engines Playwright drives here. */
export const engines = ["chromium", "webkit", "firefox"] as const;
export type Engine = (typeof engines)[number];

/**
 * Starts the built server on a free port with an in-memory database; stops it when `t` ends or this process
 * exits. `timeZone` sets its TZ; it shares the test machine's otherwise.
 */
export async function startServer(t: Teardown, timeZone?: string): Promise<string> {
  const server = spawn(process.execPath, [resolve("dist/server.js")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DATABASE_PATH: ":memory:", ...(timeZone ? { TZ: timeZone } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(server, "exit");
  let stderr = "";
  server.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const stop = () => {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
  };
  process.once("exit", stop);
  t.after(async () => {
    process.off("exit", stop);
    stop();
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

/**
 * A browser context in headless `engine` (Chromium from BUCKETEER_BROWSER_PATH when set), closed with its browser
 * when `t` ends. Firefox has no mobile emulation, so `isMobile` is dropped there: a phone is touch at the phone's
 * viewport, still with a mouse's hover.
 */
export async function launchContext(t: Teardown, engine: Engine, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const browserPath = process.env.BUCKETEER_BROWSER_PATH;
  const browser = engine === "chromium"
    ? await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) })
    : await { webkit, firefox }[engine].launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext(engine === "firefox" ? { ...options, isMobile: false } : options);
  if (engine === "firefox") {
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

/** Waits until the app has finished loading its route, within `timeout` ms when given. */
export async function ready(page: Page, timeout?: number): Promise<void> {
  await page.locator("#main:not([aria-busy])").waitFor(timeout === undefined ? {} : { timeout });
}
