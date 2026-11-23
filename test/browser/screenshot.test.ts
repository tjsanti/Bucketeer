import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { engine } from "./harness.js";

test("the screenshot script writes a PNG of a seeded page and prints its path", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "bucketeer-shots-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/screenshot.ts", "--engine", engine, "--route", "buckets", "--out", out, "--no-build"]);
  const file = join(out, `buckets-${engine}-1280-light.png`);
  assert.equal(stdout.trim(), file);
  const png = await readFile(file);
  assert.ok(png.length > 10_000, `${png.length} bytes`);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
