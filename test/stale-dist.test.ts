import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { distIsStale, recordBuild } from "../scripts/stale-dist.ts";

const sources = ["src/server.ts", "src/core/money.ts", "src/ui/styles.css", "scripts/copy-assets.ts", "tsconfig.json"];
const outputs = ["dist/server.js", "dist/core/money.js", "dist/ui/styles.css", "dist/ui/fonts/nunito.woff2"];

async function touch(root: string, file: string, secondsAgo: number): Promise<void> {
  const path = join(root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "x");
  const time = new Date(Date.now() - secondsAgo * 1000);
  await utimes(path, time, time);
}

/** A project whose sources are ten minutes old and whose build has just finished. */
async function builtProject(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bucketeer-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of [...sources, ...outputs]) await touch(root, file, 600);
  recordBuild(root);
  return root;
}

test("a finished build newer than every source is fresh", async (t) => {
  assert.equal(distIsStale(await builtProject(t)), false);
});

test("a build that never finished is stale", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bucketeer-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of [...sources, ...outputs]) await touch(root, file, 600);
  assert.equal(distIsStale(root), true);
});

test("a build missing any one file it made is stale", async (t) => {
  for (const missing of outputs) {
    const root = await builtProject(t);
    await rm(join(root, missing));
    assert.equal(distIsStale(root), true, missing);
  }
});

test("a source changed since the build finished makes it stale, even when a failed build rewrote its output", async (t) => {
  for (const source of sources) {
    const root = await builtProject(t);
    await touch(root, source, -5);
    for (const output of outputs) await touch(root, output, -10);
    assert.equal(distIsStale(root), true, source);
  }
});

test("a source file the build doesn't emit leaves a later build fresh", async (t) => {
  const root = await builtProject(t);
  for (const stray of ["src/.DS_Store", "src/ui/types.d.ts", "src/ui/styles.css.orig"]) await touch(root, stray, 5);
  recordBuild(root);
  assert.equal(distIsStale(root), false);
});
