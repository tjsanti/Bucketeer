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
  // Buckets and groups: dollars in, cents out; positions are 1-based.
  assert.deepEqual(JSON.parse(cli("bucket", "list", ...budgetArgs, "--json")), { groups: [], buckets: [] });
  const fixed = JSON.parse(cli("group", "add", ...budgetArgs, "--name", "Fixed", "--json"));
  const everyday = JSON.parse(cli("group", "add", ...budgetArgs, "--name", "Everyday", "--json"));
  const rent = JSON.parse(cli("bucket", "add", ...budgetArgs, "--name", "Rent", "--group", fixed.id, "--type", "recurring", "--amount", "1650", "--json"));
  assert.deepEqual([rent.type, rent.amount, rent.colour, rent.available, rent.groupId], ["recurring", 165000, "sky", 0, fixed.id]);
  const vacation = JSON.parse(cli("bucket", "add", ...budgetArgs, "--name", "Vacation", "--new-group", "Goals", "--type", "goal", "--amount", "3000", "--by", "2027-08", "--json"));
  assert.deepEqual([vacation.type, vacation.amount, vacation.goalMonth], ["goal", 300000, "2027-08"]);
  const goals = JSON.parse(cli("group", "list", ...budgetArgs, "--json")).find((group: { name: string }) => group.name === "Goals");
  assert.equal(vacation.groupId, goals.id);
  const clothing = JSON.parse(cli("bucket", "add", ...budgetArgs, "--name", "Clothing", "--group", everyday.id, "--json"));
  assert.deepEqual([clothing.type, clothing.amount, clothing.goalMonth], ["plain", null, null]);
  assert.notEqual(clothing.colour, "sky");
  const bucketTable = JSON.parse(cli("bucket", "list", ...budgetArgs, "--json"));
  assert.deepEqual(bucketTable.groups.map((group: { name: string }) => group.name), ["Fixed", "Everyday", "Goals"]);
  assert.deepEqual(bucketTable.buckets, [rent, clothing, vacation]);
  assert.deepEqual(cli("bucket", "list", ...budgetArgs).split("\n"), [
    `${rent.id}\tFixed\tRent\trecurring\t1,650.00/month\t0.00`,
    `${clothing.id}\tEveryday\tClothing\tplain\t\t0.00`,
    `${vacation.id}\tGoals\tVacation\tgoal\t3,000.00 by 2027-08\t0.00`,
  ]);
  assert.equal(JSON.parse(cli("bucket", "edit", rent.id, "--type", "plain", "--json")).amount, null);
  cliFails("invalid_input", "bucket", "edit", vacation.id, "--by", "2020-01");
  cliFails("invalid_input", "bucket", "add", ...budgetArgs, "--name", "Car", "--group", fixed.id, "--type", "goal", "--amount", "100");
  cliFails("invalid_input", "bucket", "add", ...budgetArgs, "--name", "Car", "--group", fixed.id, "--colour", "pink");
  const movedClothing = JSON.parse(cli("bucket", "move", clothing.id, "--group", fixed.id, "--position", "1", "--json"));
  assert.deepEqual([movedClothing.groupId, movedClothing.order], [fixed.id, 1]);
  assert.equal(JSON.parse(cli("group", "move", goals.id, "--position", "1", "--json")).order, 1);
  assert.deepEqual(JSON.parse(cli("group", "list", ...budgetArgs, "--json")).map((group: { name: string }) => group.name), ["Goals", "Fixed", "Everyday"]);
  const archivedClothing = JSON.parse(cli("bucket", "archive", clothing.id, "--json"));
  assert.deepEqual([archivedClothing.bucket.archived, archivedClothing.returned], [true, 0]);
  cliFails("name_taken", "bucket", "add", ...budgetArgs, "--name", "clothing", "--group", fixed.id);
  const restoredClothing = JSON.parse(cli("bucket", "restore", clothing.id, "--json"));
  assert.equal(restoredClothing.archived, false);
  const fixedBuckets = JSON.parse(cli("bucket", "list", ...budgetArgs, "--json")).buckets.filter((bucket: { groupId: string }) => bucket.groupId === fixed.id);
  assert.deepEqual(fixedBuckets.map((bucket: { name: string }) => bucket.name), ["Rent", "Clothing"]);
  cliFails("group_not_empty", "group", "delete", fixed.id);
  assert.deepEqual(JSON.parse(cli("group", "delete", everyday.id, "--json")), { id: everyday.id, deleted: true });
  cliFails("not_found", "bucket", "archive", "missing");
  cliFails("not_found", "group", "delete", "missing");
  cliFails("not_found", "bucket", "add", ...budgetArgs, "--name", "Car", "--group", "missing");
  const bucketsBefore = JSON.parse(cli("bucket", "list", ...budgetArgs, "--archived", "--json"));
  assert.deepEqual(bucketsBefore.groups.map((group: { name: string }) => group.name), ["Goals", "Fixed"]);
  console.log("Budget saved and updated, accounts added and edited, buckets and groups added, moved, archived and restored. Recreating with the same volume and a non-default port...");
  port = 4317;
  compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "60");
  assert.deepEqual(JSON.parse(cli("budget", "open", saved.id, "--json")), updated);
  assert.deepEqual(JSON.parse(cli("budget", "list", "--json")), [updated]);
  assert.deepEqual(JSON.parse(cli("account", "list", ...budgetArgs, "--json")), accounts);
  assert.deepEqual(JSON.parse(cli("bucket", "list", ...budgetArgs, "--archived", "--json")), bucketsBefore);
  assert.throws(() => cli("budget", "open", "missing", "--json"), (error: unknown) => {
    assert.ok(error && typeof error === "object" && "status" in error && "stdout" in error);
    assert.equal(error.status, 1);
    assert.equal(JSON.parse(String(error.stdout)).error.code, "not_found");
    return true;
  }, "Missing budgets must produce a nonzero exit code.");
  compose("exec", "-T", "bucketeer", "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    for (const path of ['/', '/ui/app.js', '/ui/theme.js', '/ui/dom.js', '/ui/sheet.js', '/ui/shell.js', '/ui/accounts.js', '/ui/buckets.js', '/ui/bucket-dialog.js', '/ui/reorder.js', '/ui/styles.css', '/client.js', '/core/money.js', '/core/types.js', '/core/colours.js']) {
      const response = await fetch('http://localhost:${port}' + path);
      assert.equal(response.status, 200, path);
      assert.ok((await response.text()).length > 0, path);
    }
    const money = await (await fetch('http://localhost:${port}/core/money.js')).text();
    assert.match(money, /export function parseMoney/);
    assert.match(money, /export function formatMoney/);
    const colours = await (await fetch('http://localhost:${port}/core/colours.js')).text();
    assert.match(colours, /export function leastUsedColour/);
    const accountsPage = await fetch('http://localhost:${port}/budgets/${saved.id}/accounts');
    assert.equal(accountsPage.status, 200);
    assert.equal(await accountsPage.text(), await (await fetch('http://localhost:${port}/')).text());
    const bucketsPage = await fetch('http://localhost:${port}/budgets/${saved.id}/buckets');
    assert.equal(bucketsPage.status, 200);
    assert.equal(await bucketsPage.text(), await (await fetch('http://localhost:${port}/')).text());
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
  console.log("PASS: Docker health on default and custom ports, CLI budget, account, group and bucket flows, container recreation, persistence, errors, and UI assets.");
} finally {
  compose("down", "--volumes", "--remove-orphans", "--rmi", "local");
}
