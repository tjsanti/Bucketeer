import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Isolated Compose project and volume, so acceptance never touches a running personal budget.
const project = `bucketeer-acceptance-${process.pid}`;
let port = 3000;
function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", "-p", project, "-f", "compose.yaml", "-f", "-", ...args], {
    encoding: "utf8",
    input: JSON.stringify({ services: { bucketeer: { environment: { PORT: String(port) } } } }),
    env: { ...process.env, BUCKETEER_PORT: "0", BUCKETEER_BIND: "127.0.0.1" },
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}
function cli(...args: string[]): string {
  return compose("exec", "-T", "bucketeer", "bucketeer", "--url", `http://127.0.0.1:${port}`, ...args);
}
function cliFails(code: string, ...args: string[]): void {
  assert.throws(() => cli(...args, "--json"), (error: unknown) => {
    assert.ok(error && typeof error === "object" && "status" in error && "stdout" in error);
    assert.equal(error.status, 1, args.join(" "));
    assert.equal(JSON.parse(String(error.stdout)).error.code, code, args.join(" "));
    return true;
  }, `${args.join(" ")} must fail with ${code}.`);
}

try {
  console.log("Building and starting an isolated Docker deployment...");
  compose("up", "-d", "--build", "--wait", "--wait-timeout", "60");
  assert.equal(cli("status"), "ok");
  assert.deepEqual(JSON.parse(cli("status", "--json")), { status: "ok" });
  assert.deepEqual(JSON.parse(cli("budget", "list", "--json")), []);
  const saved = JSON.parse(cli("budget", "save", "--name", "Household", "--json"));
  assert.equal(saved.name, "Household");
  assert.deepEqual(JSON.parse(cli("budget", "open", saved.id, "--json")), saved);
  const updated = JSON.parse(cli("budget", "save", "--id", saved.id, "--name", "Family budget", "--json"));
  assert.equal(updated.id, saved.id);
  assert.equal(updated.createdAt, saved.createdAt);
  assert.equal(updated.name, "Family budget");
  // Accounts: money crosses the CLI as dollars and the JSON as integer cents.
  const budgetArgs = ["--budget", saved.id];
  assert.deepEqual(JSON.parse(cli("account", "list", ...budgetArgs, "--json")), []);
  const checking = JSON.parse(cli("account", "add", ...budgetArgs, "--name", "Checking", "--type", "checking", "--starting-balance", "1,000.00", "--date", "2026-11-01", "--json"));
  const visa = JSON.parse(cli("account", "add", ...budgetArgs, "--name", "Visa", "--type", "credit-card", "--starting-balance", "-412.09", "--date", "2026-11-01", "--json"));
  const wallet = JSON.parse(cli("account", "add", ...budgetArgs, "--name", "Wallet", "--type", "cash", "--starting-balance", "0", "--date", "2026-11-01", "--json"));
  for (const [account, cents] of [[checking, 100000], [visa, -41209], [wallet, 0]] as const) {
    assert.equal(account.startingBalance, cents);
    assert.equal(account.balance, cents);
    assert.equal(account.budgetId, saved.id);
  }
  assert.deepEqual(JSON.parse(cli("account", "list", ...budgetArgs, "--json")), [checking, visa, wallet]);
  const accountText = cli("account", "list", ...budgetArgs).split("\n");
  assert.deepEqual(accountText, [
    `${checking.id}\tChecking\tchecking\t1,000.00`,
    `${visa.id}\tVisa\tcredit-card\t\u2212412.09`,
    `${wallet.id}\tWallet\tcash\t0.00`,
  ]);
  const renamed = JSON.parse(cli("account", "edit", checking.id, "--name", "Main checking", "--json"));
  assert.equal(renamed.name, "Main checking");
  assert.equal(renamed.id, checking.id);
  assert.equal(renamed.createdAt, checking.createdAt);
  cliFails("balance_not_zero", "account", "close", visa.id);
  assert.equal(JSON.parse(cli("account", "close", wallet.id, "--json")).closed, true);
  assert.equal(JSON.parse(cli("account", "reopen", wallet.id, "--json")).closed, false);
  cliFails("name_taken", "account", "add", ...budgetArgs, "--name", "visa", "--type", "cash");
  cliFails("invalid_input", "account", "add", ...budgetArgs, "--name", "Bad", "--type", "brokerage");
  cliFails("invalid_input", "account", "add", ...budgetArgs, "--name", "Bad", "--type", "cash", "--date", "2026-02-30");
  cliFails("invalid_input", "account", "add", ...budgetArgs, "--name", "Bad", "--type", "cash", "--starting-balance", "1.234");
  cliFails("not_found", "account", "close", "missing");
  const accounts = JSON.parse(cli("account", "list", ...budgetArgs, "--json"));
  assert.deepEqual(accounts, [renamed, visa, JSON.parse(cli("account", "reopen", wallet.id, "--json"))]);
  console.log("Budget saved and updated, accounts added and edited. Recreating with the same volume and a non-default port...");
  port = 4317;
  compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "60");
  assert.deepEqual(JSON.parse(cli("budget", "open", saved.id, "--json")), updated);
  assert.deepEqual(JSON.parse(cli("budget", "list", "--json")), [updated]);
  assert.deepEqual(JSON.parse(cli("account", "list", ...budgetArgs, "--json")), accounts);
  assert.throws(() => cli("budget", "open", "missing", "--json"), (error: unknown) => {
    assert.ok(error && typeof error === "object" && "status" in error && "stdout" in error);
    assert.equal(error.status, 1);
    assert.equal(JSON.parse(String(error.stdout)).error.code, "not_found");
    return true;
  }, "Missing budgets must produce a nonzero exit code.");
  compose("exec", "-T", "bucketeer", "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    for (const path of ['/', '/ui/app.js', '/ui/theme.js', '/ui/dom.js', '/ui/sheet.js', '/ui/shell.js', '/ui/accounts.js', '/ui/styles.css', '/client.js', '/core/money.js', '/core/types.js']) {
      const response = await fetch('http://localhost:${port}' + path);
      assert.equal(response.status, 200, path);
      assert.ok((await response.text()).length > 0, path);
    }
    const money = await (await fetch('http://localhost:${port}/core/money.js')).text();
    assert.match(money, /export function parseMoney/);
    assert.match(money, /export function formatMoney/);
    const accountsPage = await fetch('http://localhost:${port}/budgets/${saved.id}/accounts');
    assert.equal(accountsPage.status, 200);
    assert.equal(await accountsPage.text(), await (await fetch('http://localhost:${port}/')).text());
    const css = await (await fetch('http://localhost:${port}/ui/styles.css')).text();
    const fonts = [...css.matchAll(/url\\("(\\/ui\\/fonts\\/[^"]+\\.woff2)"\\)/g)].map((match) => match[1]);
    assert.equal(fonts.length, 4, 'bundled font URLs in styles.css');
    for (const path of fonts) {
      const response = await fetch('http://localhost:${port}' + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable', path);
      assert.ok((await response.arrayBuffer()).byteLength > 0, path);
    }
  `);
  console.log("PASS: Docker health on default and custom ports, CLI budget and account flows, container recreation, persistence, errors, and UI assets.");
} finally {
  compose("down", "--volumes", "--remove-orphans", "--rmi", "local");
}
