import { copyFile, chmod } from "node:fs/promises";

for (const filename of ["index.html", "styles.css"]) {
  await copyFile(new URL(`../src/ui/${filename}`, import.meta.url), new URL(`../dist/ui/${filename}`, import.meta.url));
}
await chmod(new URL("../dist/cli.js", import.meta.url), 0o755);
