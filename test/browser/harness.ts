import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";

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
