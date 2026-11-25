import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { engine } from "./harness.js";

const run = promisify(execFile);

test("the screenshot script writes a PNG of a seeded page and prints its path", { timeout: 60_000 }, async (t) => {
  const out = await mkdtemp(join(tmpdir(), "bucketeer-shots-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { stdout } = await run(process.execPath, ["scripts/screenshot.ts", "--engine", engine, "--route", "buckets", "--out", out, "--no-build"], { signal: t.signal });
  const file = join(out, `buckets-${engine}-1280-light.png`);
  assert.equal(stdout.trim(), file);
  const png = await readFile(file);
  assert.ok(png.length > 10_000, `${png.length} bytes`);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test("the screenshot script refuses routes that share a file name and sizes that round to nothing", { timeout: 30_000 }, async (t) => {
  const refuses = (args: string[], message: RegExp) => run(process.execPath, ["scripts/screenshot.ts", "--no-build", ...args], { signal: t.signal }).then(
    () => assert.fail(`${args.join(" ")} was accepted`),
    (error: { code?: number; stderr?: string }) => {
      assert.equal(error.code, 2, args.join(" "));
      assert.match(error.stderr ?? "", message);
    },
  );
  await refuses(["--route", "/budgets/{budget}/buckets?month=2026-10", "--route", "/budgets/{budget}/buckets?MONTH=2026-10"], /would both be saved as/);
  await refuses(["--width", "0.1"], /--width must be/);
  await refuses(["--scale", "0.0001"], /--scale must be/);
});
