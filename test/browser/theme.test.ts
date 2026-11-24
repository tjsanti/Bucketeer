import assert from "node:assert/strict";
import { test } from "node:test";
import { openContext, ready, startServer } from "./harness.js";

const lightBackground = "rgb(242, 246, 248)";
const darkBackground = "rgb(15, 23, 30)";

test("the theme follows the system, a saved choice overrides it, and fonts come from the app", { timeout: 30_000 }, async (t) => {
  const context = await openContext(t, { colorScheme: "dark" });
  const url = await startServer(t);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const foreignRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== url) foreignRequests.push(request.url());
  });
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const toggle = page.getByRole("button", { name: "Dark theme" });

  await page.goto(url);
  await ready(page);
  assert.equal(await background(), darkBackground);
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");

  await toggle.click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  assert.equal(await background(), lightBackground);
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");

  await page.reload();
  await ready(page);
  assert.equal(await background(), lightBackground, "The saved choice must survive a reload.");

  await page.emulateMedia({ colorScheme: "light" });
  await toggle.click();
  assert.equal(await background(), darkBackground, "An explicit dark choice must override a light system.");

  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() => [...document.fonts].filter((font) => font.status === "loaded").map((font) => font.family.replaceAll('"', "")));
  assert.ok(loaded.includes("Nunito"), `Nunito should load: ${loaded.join(", ")}`);
  assert.ok(loaded.includes("Figtree"), `Figtree should load: ${loaded.join(", ")}`);
  const css = await (await page.request.get(`${url}/ui/styles.css`)).text();
  const fontUrls = [...css.matchAll(/url\("(\/ui\/fonts\/[^"]+)"\)/g)].map((match) => match[1]);
  assert.equal(fontUrls.length, 4, "Both families should ship Latin and Latin Extended files.");
  for (const fontUrl of fontUrls) {
    assert.match(fontUrl ?? "", /^\/ui\/fonts\/(nunito|figtree)-latin(-ext)?-wght-normal\.[0-9a-f]{8}\.woff2$/);
    const font = await page.request.get(`${url}${fontUrl}`);
    assert.equal(font.status(), 200, fontUrl);
    assert.equal(font.headers()["content-type"], "font/woff2");
    assert.equal(font.headers()["cache-control"], "public, max-age=31536000, immutable");
  }
  const licence = await page.request.get(`${url}/ui/fonts/nunito-OFL.txt`);
  assert.equal(licence.status(), 200);
  assert.equal(licence.headers()["cache-control"], "no-cache");
  assert.equal((await page.request.get(`${url}/ui/styles.css`)).headers()["cache-control"], "no-cache");
  assert.equal((await page.request.get(`${url}/ui/fonts/nunito-latin-wght-normal.woff2`)).status(), 404, "Unhashed names are not served.");
  assert.equal((await page.request.get(`${url}/ui/fonts/missing-font.0123abcd.woff2`)).status(), 404);
  assert.deepEqual(foreignRequests, []);
  assert.deepEqual(pageErrors, []);
});

test("the theme toggle still works when storage is unavailable", { timeout: 30_000 }, async (t) => {
  const page = await (await openContext(t, { colorScheme: "light" })).newPage();
  const url = await startServer(t);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked", "SecurityError"); } });
  });
  await page.goto(url);
  await ready(page);
  await page.getByRole("button", { name: "Dark theme" }).click();
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), darkBackground);
  assert.deepEqual(pageErrors, []);
});
