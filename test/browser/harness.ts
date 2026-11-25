import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright-core";
import { engines, launchContext, startServer } from "./launch.js";
import type { Engine, Teardown } from "./launch.js";

export { ready, startServer } from "./launch.js";

/**
 * The engine every browser test runs in, from BUCKETEER_BROWSER (chromium by default). `npm run test:ui` runs the
 * suite once per engine; a missing engine fails its tests rather than skipping them.
 */
export const engine: Engine = (() => {
  const value = process.env.BUCKETEER_BROWSER || "chromium";
  const found = engines.find((name) => name === value);
  if (found) return found;
  throw new Error(`BUCKETEER_BROWSER must be ${engines.slice(0, -1).join(", ")} or ${engines.at(-1)}, not "${value}".`);
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

/** A browser context in the test engine, closed with its browser when the test ends (see `launchContext`). */
export function openContext(t: Teardown, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  return launchContext(t, engine, options);
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

export async function seedBudget(url: string, name: string): Promise<string> {
  const response = await fetch(`${url}/api/budgets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  assert.equal(response.status, 201);
  return ((await response.json()) as { id: string }).id;
}
