import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openContext, ready, startServer } from "../test/browser/harness.ts";
import type { Engine } from "../test/browser/harness.ts";
import { seedRichBudget } from "../test/browser/seed.ts";

const usage = `Screenshots the built app with a seeded budget showing every main UI state (test/browser/seed.ts).

  npm run screenshot -- [options]

  --engine  chromium | webkit | firefox | all      (chromium)
  --width   viewport width in CSS pixels; 600 or less is a touch phone   (1280)
  --height  viewport height; the shot is the full page                   (900, or 844 at phone widths)
  --theme   light | dark | both                     (light)
  --route   buckets | accounts | register, or a raw path where {budget} and {account} stand for the seeded
            budget's and Checking's ids, e.g. /budgets/{budget}/buckets?month=2026-10   (buckets; repeatable)
  --out     directory for the PNGs                  (.local/screenshots)
  --scale   device pixel ratio                      (1)
  --no-build  fail instead of building when dist is older than src

Prints each PNG path it writes, named route-engine-width[xheight][@scale]-theme.png. Builds first when dist is
older than src.
Style tweaks must go through page.evaluate: the app's CSP blocks page.addStyleTag.`;

function fail(message: string): never {
  console.error(`${message}\n\n${usage}`);
  process.exit(2);
}
const engines: Engine[] = ["chromium", "webkit", "firefox"];
const options = {
  "no-build": { type: "boolean" },
  engine: { type: "string", default: "chromium" },
  width: { type: "string", default: "1280" },
  height: { type: "string" },
  theme: { type: "string", default: "light" },
  route: { type: "string", multiple: true },
  out: { type: "string", default: ".local/screenshots" },
  scale: { type: "string", default: "1" },
  help: { type: "boolean", short: "h" },
} as const;
const values = (() => {
  try {
    return parseArgs({ options }).values;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
})();
if (values.help) {
  console.log(usage);
  process.exit(0);
}
function positive(name: string, value: string, most: number): number {
  const number = Number(value);
  if (!(number > 0 && number <= most)) fail(`--${name} must be a number above 0 and at most ${most}, not "${value}".`);
  return number;
}
const chosenEngines = values.engine === "all" ? engines : engines.filter((name) => name === values.engine);
if (!chosenEngines.length) fail(`--engine must be chromium, webkit, firefox or all, not "${values.engine}".`);
const themes = values.theme === "both" ? ["light", "dark"] as const
  : values.theme === "light" || values.theme === "dark" ? [values.theme] as const
  : fail(`--theme must be light, dark or both, not "${values.theme}".`);
const width = Math.round(positive("width", values.width, 4000));
const phone = width <= 600;
const height = Math.round(positive("height", values.height ?? (phone ? "844" : "900"), 4000));
const scale = positive("scale", values.scale, 4);
const named = ["buckets", "accounts", "register"];
const routes = values.route ?? ["buckets"];
for (const route of routes) {
  if (!named.includes(route) && !route.startsWith("/")) fail(`--route must be buckets, accounts, register or a path starting with /, not "${route}".`);
}
const slug = (route: string) => named.includes(route) ? route : route.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "") || "root";
const slugs = routes.map(slug);
const repeated = slugs.find((name, index) => slugs.indexOf(name) !== index);
if (repeated) fail(`Two routes would both be saved as ${repeated}; drop one.`);
const outDir = resolve(values.out);

// dist is stale when any source file is newer than the build's last output.
function newest(dir: string): number {
  return Math.max(0, ...readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs));
}
function builtAt(): number {
  try {
    return Math.min(...["dist/server.js", "dist/ui/styles.css", "dist/ui/index.html"].map((file) => statSync(file).mtimeMs));
  } catch {
    return 0;
  }
}
if (builtAt() < Math.max(newest("src"), statSync("scripts/copy-assets.ts").mtimeMs)) {
  if (values["no-build"]) {
    console.error("dist is older than src. Run npm run build.");
    process.exit(1);
  }
  console.error("dist is stale; running npm run build...");
  const build = spawnSync("npm", ["run", "build"], { stdio: ["ignore", process.stderr, "inherit"] });
  if (build.status !== 0) {
    console.error("The build failed. Fix it and run npm run build.");
    process.exit(1);
  }
}

const cleanup: (() => unknown)[] = [];
const teardown = { after: (fn: () => unknown) => { cleanup.push(fn); } };
try {
  const url = await startServer(teardown);
  const seeded = await seedRichBudget(url);
  const paths: Record<string, string> = {
    buckets: `/budgets/${seeded.budget.id}/buckets`,
    accounts: `/budgets/${seeded.budget.id}/accounts`,
    register: `/budgets/${seeded.budget.id}/accounts/${seeded.checking.id}`,
  };
  const pathOf = (route: string) => paths[route] ?? route.replaceAll("{budget}", seeded.budget.id).replaceAll("{account}", seeded.checking.id);
  const size = `${width}${values.height ? `x${height}` : ""}${scale === 1 ? "" : `@${scale}`}`;
  mkdirSync(outDir, { recursive: true });

  for (const engine of chosenEngines) {
    for (const theme of themes) {
      const context = await openContext(teardown, {
        viewport: { width, height },
        deviceScaleFactor: scale,
        colorScheme: theme,
        reducedMotion: "reduce",
        ...(phone ? { hasTouch: true, isMobile: true } : {}),
      }, engine);
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      for (const route of routes) {
        await page.goto(`${url}${pathOf(route)}`);
        await ready(page, 10_000).catch((cause: unknown) => {
          const why = pageErrors.length ? `the page threw: ${pageErrors.join("; ")}` : "check the path";
          throw new Error(`${route} did not finish loading in ${engine}; ${why}.`, { cause });
        });
        await page.evaluate(() => document.fonts.ready);
        const file = join(outDir, `${slug(route)}-${engine}-${size}-${theme}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(file);
      }
      await context.close();
    }
  }
} finally {
  // Every step runs even if one fails, so the server is always stopped.
  for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch((error: unknown) => console.error(error));
}
