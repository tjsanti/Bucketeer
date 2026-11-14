import { createHash } from "node:crypto";
import { copyFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const source = new URL("../src/ui/", import.meta.url);
const output = new URL("../dist/ui/", import.meta.url);

// The stylesheet keeps the dark tokens in one :root[data-theme="dark"] block.
// The same block is emitted again under prefers-color-scheme, so dark follows
// the system unless data-theme="light" overrides it.
function withSystemDarkTheme(css: string): string {
  const darkBlock = /^:root\[data-theme="dark"\] \{\n([^}]*)\}\n/m;
  const match = darkBlock.exec(css);
  if (!match?.[1]) throw new Error('styles.css must contain one top-level :root[data-theme="dark"] { ... } token block.');
  if (css.split('[data-theme="dark"]').length !== 2) {
    throw new Error('Only the token block may use [data-theme="dark"]; put dark-only values in it as tokens.');
  }
  const end = match.index + match[0].length;
  const body = match[1].replace(/^(?=.)/gm, "  ");
  const systemBlock = `\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${body}  }\n}\n`;
  return css.slice(0, end) + systemBlock + css.slice(end);
}

// Fonts are bundled (the app runs behind a VPN): Fontsource variable woff2 files plus their OFL licences.
// Each font gets a content-hashed name so the server can cache it as immutable.
const fonts = new URL("fonts/", output);
await rm(fonts, { recursive: true, force: true });
await mkdir(fonts, { recursive: true });
const hashedFonts = new Map<string, string>();
for (const family of ["nunito", "figtree"]) {
  const pkg = new URL(`../node_modules/@fontsource-variable/${family}/`, import.meta.url);
  for (const subset of ["latin", "latin-ext"]) {
    const name = `${family}-${subset}-wght-normal`;
    const content = await readFile(new URL(`files/${name}.woff2`, pkg));
    const hashed = `${name}.${createHash("sha256").update(content).digest("hex").slice(0, 8)}.woff2`;
    await writeFile(new URL(hashed, fonts), content);
    hashedFonts.set(`/ui/fonts/${name}.woff2`, `/ui/fonts/${hashed}`);
  }
  await copyFile(new URL("LICENSE", pkg), new URL(`${family}-OFL.txt`, fonts));
}

// Source files name fonts without hashes; point every reference at the hashed file.
function withHashedFonts(text: string, filename: string, required: boolean): string {
  let result = text;
  for (const [plain, hashed] of hashedFonts) {
    if (required && !result.includes(plain)) throw new Error(`${filename} does not reference ${plain}.`);
    result = result.replaceAll(plain, hashed);
  }
  const leftover = /\/ui\/fonts\/[a-z0-9-]+\.woff2/.exec(result);
  if (leftover) throw new Error(`${filename} references an unknown font: ${leftover[0]}`);
  return result;
}

const html = await readFile(new URL("index.html", source), "utf8");
await writeFile(new URL("index.html", output), withHashedFonts(html, "index.html", false));
const css = await readFile(new URL("styles.css", source), "utf8");
await writeFile(new URL("styles.css", output), withHashedFonts(withSystemDarkTheme(css), "styles.css", true));

await chmod(new URL("../dist/cli.js", import.meta.url), 0o755);
