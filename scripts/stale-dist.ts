import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const recordPath = (root: string) => join(root, "dist/build-files.json");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Forgets the last build, so one that stops partway counts as stale. */
export function clearBuildRecord(root: string): void {
  rmSync(recordPath(root), { force: true });
}

/** Records that a build under `root/dist` has finished, and the files it left there. */
export function recordBuild(root: string): void {
  clearBuildRecord(root);
  const dist = join(root, "dist");
  writeFileSync(recordPath(root), JSON.stringify(filesUnder(dist).map((file) => relative(dist, file))));
}

/**
 * Whether the build under `root/dist` needs running again: it never finished, a file it made is gone, or a file under
 * src, scripts/copy-assets.ts or tsconfig.json has changed since it finished.
 */
export function distIsStale(root: string): boolean {
  const record = statSync(recordPath(root), { throwIfNoEntry: false });
  if (!record) return true;
  const made = JSON.parse(readFileSync(recordPath(root), "utf8")) as string[];
  if (made.some((file) => !existsSync(join(root, "dist", file)))) return true;
  const sources = [...filesUnder(join(root, "src")), join(root, "scripts/copy-assets.ts"), join(root, "tsconfig.json")];
  return sources.some((source) => statSync(source).mtimeMs > record.mtimeMs);
}
