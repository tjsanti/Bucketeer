import { spawnSync } from "node:child_process";

// Runs the compiled browser tests once per engine, each run with BUCKETEER_BROWSER set. Engine names among the
// arguments pick the engines (all three by default); other arguments go to `node --test`, and test files among them
// (.js paths or globs) replace the default set.
const engines = ["chromium", "webkit", "firefox"];
const args = process.argv.slice(2);
const chosen = args.filter((arg) => engines.includes(arg));
const rest = args.filter((arg) => !engines.includes(arg));
const isFile = (arg: string) => !arg.startsWith("-") && (arg.endsWith(".js") || arg.includes("*"));
const files = rest.some(isFile) ? [] : [".test-dist/test/browser/*.test.js"];

const failed: string[] = [];
for (const engine of chosen.length ? chosen : engines) {
  console.log(`\n# Browser tests in ${engine}\n`);
  const run = spawnSync(process.execPath, ["--test", ...rest, ...files], { stdio: "inherit", env: { ...process.env, BUCKETEER_BROWSER: engine } });
  if (run.status !== 0) failed.push(engine);
}
if (failed.length) {
  console.error(`\nBrowser tests failed in ${failed.join(", ")}.`);
  process.exitCode = 1;
}
