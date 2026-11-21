import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Isolated Compose projects and volumes, so acceptance never touches a running personal budget.
const mainProject = `bucketeer-acceptance-${process.pid}`;
const upgradeProject = `bucketeer-acceptance-upgrade-${process.pid}`;
const mainImage = `bucketeer-acceptance-main-${process.pid}`;
const mainContainer = `bucketeer-acceptance-main-${process.pid}`;
let project = mainProject;
let port = 3000;
let timeZone: string | undefined;
function docker(args: string[], input?: string | Buffer): string {
  return execFileSync("docker", args, { encoding: "utf8", input, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }).trim();
}
function compose(...args: string[]): string {
  return execFileSync("docker", ["compose", "-p", project, "-f", "compose.yaml", "-f", "-", ...args], {
    encoding: "utf8",
    input: JSON.stringify({ services: { bucketeer: { environment: { PORT: String(port) } } } }),
    env: { ...process.env, BUCKETEER_PORT: "0", BUCKETEER_BIND: "127.0.0.1", ...(timeZone ? { TZ: timeZone } : {}) },
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
  let accounts = JSON.parse(cli("account", "list", ...budgetArgs, "--json"));
  assert.deepEqual(accounts, [renamed, visa, JSON.parse(cli("account", "reopen", wallet.id, "--json"))]);
  // Income: it fills Ready to assign and the account's balance; a card's starting debt still reduces Ready to assign.
  const ready = () => JSON.parse(cli("ready", ...budgetArgs, "--json")).readyToAssign;
  assert.equal(ready(), 58791);
  assert.equal(cli("ready", ...budgetArgs), "587.91");
  const accountArgs = ["--account", checking.id];
  const paycheck = JSON.parse(cli("tx", "add", ...accountArgs, "--amount", "2000", "--income", "--payee", "Acme Payroll", "--json"));
  assert.deepEqual([paycheck.amount, paycheck.category, paycheck.payee], [200000, { kind: "income" }, "Acme Payroll"]);
  assert.equal(ready(), 258791);
  assert.equal(JSON.parse(cli("account", "list", ...budgetArgs, "--json"))[0].balance, 300000);
  assert.deepEqual(cli("tx", "list", ...accountArgs).split("\n"), [`${paycheck.id}\t${paycheck.date}\tAcme Payroll\tIncome\t2,000.00\t3,000.00`]);
  cliFails("invalid_input", "tx", "add", ...accountArgs, "--amount", "-5", "--income");
  cliFails("invalid_input", "tx", "add", ...accountArgs, "--amount", "5", "--income", "--date", "2999-01-01");
  cliFails("invalid_input", "tx", "add", ...accountArgs, "--amount", "5", "--income", "--date", "2000-01-01");
  cliFails("usage", "tx", "add", ...accountArgs, "--amount", "5");
  // A date before an account's starting date is accepted and counts. (Dates are a few days back, so the clock never matters.)
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const savings = JSON.parse(cli("account", "add", ...budgetArgs, "--name", "Savings", "--type", "savings", "--date", daysAgo(2), "--json"));
  const early = JSON.parse(cli("tx", "add", "--account", savings.id, "--amount", "25", "--income", "--date", daysAgo(3), "--json"));
  assert.equal(early.date, daysAgo(3));
  assert.equal(JSON.parse(cli("account", "list", ...budgetArgs, "--json"))[3].balance, 2500);
  assert.equal(ready(), 261291);
  // A closed account takes no new transactions.
  cli("account", "close", wallet.id);
  cliFails("account_closed", "tx", "add", "--account", wallet.id, "--amount", "5", "--income");
  cli("account", "reopen", wallet.id);
  // Editing income down is allowed; deleting removes it.
  assert.equal(JSON.parse(cli("tx", "edit", early.id, "--amount", "10", "--json")).amount, 1000);
  assert.deepEqual(JSON.parse(cli("tx", "delete", early.id, "--json")), { id: early.id, deleted: true });
  assert.equal(ready(), 258791);
  // tx list --month: only that month's rows, then the balance at its end (the container's zone is UTC).
  const thisMonth = new Date().toISOString().slice(0, 7);
  const lastMonth = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)) - 2, 15)).toISOString().slice(0, 7);
  const backPay = JSON.parse(cli("tx", "add", "--account", savings.id, "--amount", "25", "--income", "--date", `${lastMonth}-15`, "--json"));
  assert.deepEqual(cli("tx", "list", "--account", savings.id, "--month", lastMonth).split("\n"), [
    `${backPay.id}\t${lastMonth}-15\t\tIncome\t25.00\t25.00`,
    `Balance at end of ${lastMonth}\t25.00`,
  ]);
  assert.deepEqual(cli("tx", "list", "--account", savings.id, "--month", thisMonth).split("\n"), ["No transactions.", `Balance at end of ${thisMonth}\t25.00`]);
  assert.deepEqual(JSON.parse(cli("tx", "list", "--account", savings.id, "--month", lastMonth, "--json")).balance, 2500);
  cliFails("invalid_input", "tx", "list", "--account", savings.id, "--month", "2999-01");
  cli("tx", "delete", backPay.id);
  accounts = JSON.parse(cli("account", "list", ...budgetArgs, "--json"));
  let register = JSON.parse(cli("tx", "list", ...accountArgs, "--json"));
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
  // Spending: a bucket takes either sign. Money out is Spent, money back in is assigned to the bucket, and
  // neither moves Ready to assign.
  // A bucket's figures in a month (default: the server's current month).
  const bucketOf = (id: string, ...month: string[]) => JSON.parse(cli("month", ...budgetArgs, ...month, "--json")).buckets.find((bucket: { id: string }) => bucket.id === id);
  const eatingOut = JSON.parse(cli("bucket", "add", ...budgetArgs, "--name", "Eating out", "--group", fixed.id, "--json"));
  const readyBeforeSpending = ready();
  cli("tx", "add", "--account", visa.id, "--amount", "-120", "--bucket", eatingOut.id, "--payee", "Noodle Bar");
  assert.deepEqual([bucketOf(eatingOut.id).available, bucketOf(eatingOut.id).spent], [-12000, 12000]);
  assert.equal(ready(), readyBeforeSpending);
  cliFails("bucket_overspent", "bucket", "archive", eatingOut.id);
  const reimbursed = JSON.parse(cli("tx", "add", ...accountArgs, "--amount", "30", "--bucket", eatingOut.id, "--json"));
  assert.deepEqual(reimbursed.category, { kind: "bucket", bucketId: eatingOut.id });
  assert.deepEqual([bucketOf(eatingOut.id).available, bucketOf(eatingOut.id).spent], [-9000, 12000]);
  assert.equal(ready(), readyBeforeSpending);
  cliFails("usage", "tx", "add", ...accountArgs, "--amount", "-5", "--income", "--bucket", eatingOut.id);
  // Money left in a bucket blocks archiving until the ledger can return it; an archived bucket takes no new money,
  // but what was filed to it stays and can still be edited.
  const coat = JSON.parse(cli("tx", "add", ...accountArgs, "--amount", "-40", "--bucket", clothing.id, "--payee", "Coat", "--json"));
  const refund = JSON.parse(cli("tx", "add", ...accountArgs, "--amount", "50", "--bucket", clothing.id, "--json"));
  cliFails("bucket_has_money", "bucket", "archive", clothing.id);
  cli("tx", "edit", refund.id, "--amount", "40");
  assert.equal(JSON.parse(cli("bucket", "archive", clothing.id, "--json")).bucket.archived, true);
  cliFails("bucket_archived", "tx", "add", ...accountArgs, "--amount", "-5", "--bucket", clothing.id);
  cliFails("bucket_archived", "tx", "edit", reimbursed.id, "--bucket", clothing.id);
  const kept = JSON.parse(cli("tx", "edit", coat.id, "--memo", "Winter", "--json"));
  assert.deepEqual([kept.memo, kept.category], ["Winter", { kind: "bucket", bucketId: clothing.id }]);
  cli("bucket", "restore", clothing.id);
  // Assigning: every assign and take is a signed ledger entry in a month, drawn from one Ready to assign.
  const month = JSON.parse(cli("month", ...budgetArgs, "--json")).summary.month as string;
  const nextMonth = `${Number(month.slice(5)) === 12 ? Number(month.slice(0, 4)) + 1 : month.slice(0, 4)}-${String(Number(month.slice(5)) % 12 + 1).padStart(2, "0")}`;
  const readyBeforeAssigning = ready();
  assert.ok(readyBeforeAssigning >= 165000, "The acceptance budget has enough ready to assign Rent.");
  const assigned = JSON.parse(cli("assign", rent.id, "--amount", "1650", "--json"));
  assert.deepEqual([assigned.month, assigned.assigned, assigned.available], [month, 165000, 165000]);
  assert.equal(ready(), readyBeforeAssigning - 165000);
  cliFails("not_enough_ready", "assign", rent.id, "--amount", "99,999,999");
  cliFails("not_enough_available", "assign", rent.id, "--amount", "-2000");
  cliFails("invalid_input", "assign", rent.id, "--amount", "1", "--month", "1999-01");
  // Assigning into next month draws from the same Ready to assign, shown alike in every month.
  assert.equal(JSON.parse(cli("assign", rent.id, "--amount", "10", "--month", nextMonth, "--json")).assigned, 1000);
  assert.equal(JSON.parse(cli("month", ...budgetArgs, "--month", nextMonth, "--json")).summary.readyToAssign, ready());
  assert.equal(ready(), readyBeforeAssigning - 166000);
  // Overspending carries into the next month.
  assert.deepEqual([bucketOf(eatingOut.id, "--month", nextMonth).carriedIn, bucketOf(eatingOut.id, "--month", nextMonth).available], [-9000, -9000]);
  assert.match(cli("month", ...budgetArgs).split("\n")[0]!, new RegExp(`^${month}\tReady to assign\t`));
  const monthBefore = JSON.parse(cli("month", ...budgetArgs, "--month", nextMonth, "--json"));
  // Splits: each line draws from its own bucket; lines must share the sign, sum to the amount and number two or more.
  const [eatingBefore, clothingBefore] = [bucketOf(eatingOut.id).available, bucketOf(clothing.id).available];
  const splitText = cli("tx", "add", ...accountArgs, "--amount", "-80", "--line", `${eatingOut.id}:-50`, "--line", `${clothing.id}:-30`, "--payee", "Superstore");
  assert.equal(splitText.split("\t")[3], "Split (2)");
  assert.deepEqual([bucketOf(eatingOut.id).available, bucketOf(clothing.id).available], [eatingBefore - 5000, clothingBefore - 3000]);
  cliFails("invalid_input", "tx", "add", ...accountArgs, "--amount", "-80", "--line", `${eatingOut.id}:-50`, "--line", `${clothing.id}:-20`);
  cliFails("invalid_input", "tx", "add", ...accountArgs, "--amount", "-80", "--line", `${eatingOut.id}:-100`, "--line", `${clothing.id}:20`);
  cliFails("invalid_input", "tx", "add", ...accountArgs, "--amount", "-80", "--line", `${eatingOut.id}:-80`);
  accounts = JSON.parse(cli("account", "list", ...budgetArgs, "--json"));
  register = JSON.parse(cli("tx", "list", ...accountArgs, "--json"));
  const bucketsBefore = JSON.parse(cli("bucket", "list", ...budgetArgs, "--archived", "--json"));
  assert.deepEqual(bucketsBefore.groups.map((group: { name: string }) => group.name), ["Goals", "Fixed"]);
  console.log("Budget saved and updated, accounts added and edited, income recorded, spending and reimbursements filed to buckets, money assigned and taken by month, buckets and groups added, moved, archived and restored. Recreating with the same volume and a non-default port...");
  port = 4317;
  compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "60");
  assert.deepEqual(JSON.parse(cli("budget", "open", saved.id, "--json")), updated);
  assert.deepEqual(JSON.parse(cli("budget", "list", "--json")), [updated]);
  assert.deepEqual(JSON.parse(cli("account", "list", ...budgetArgs, "--json")), accounts);
  assert.deepEqual(JSON.parse(cli("tx", "list", ...accountArgs, "--json")), register);
  assert.deepEqual(JSON.parse(cli("bucket", "list", ...budgetArgs, "--archived", "--json")), bucketsBefore);
  assert.deepEqual(JSON.parse(cli("month", ...budgetArgs, "--month", nextMonth, "--json")), monthBefore);
  assert.throws(() => cli("budget", "open", "missing", "--json"), (error: unknown) => {
    assert.ok(error && typeof error === "object" && "status" in error && "stdout" in error);
    assert.equal(error.status, 1);
    assert.equal(JSON.parse(String(error.stdout)).error.code, "not_found");
    return true;
  }, "Missing budgets must produce a nonzero exit code.");
  compose("exec", "-T", "bucketeer", "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    for (const path of ['/', '/ui/app.js', '/ui/theme.js', '/ui/dom.js', '/ui/sheet.js', '/ui/shell.js', '/ui/accounts.js', '/ui/buckets.js', '/ui/bucket-dialog.js', '/ui/reorder.js', '/ui/register.js', '/ui/split-lines.js', '/ui/category-picker.js', '/ui/styles.css', '/client.js', '/core/money.js', '/core/types.js', '/core/colours.js']) {
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
    const accountPage = await fetch('http://localhost:${port}/budgets/${saved.id}/accounts/${checking.id}');
    assert.equal(accountPage.status, 200);
    assert.equal(await accountPage.text(), await (await fetch('http://localhost:${port}/')).text());
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
  console.log("PASS: Docker health on default and custom ports, CLI budget, account, income, spending, group and bucket flows, container recreation, persistence, errors, and UI assets.");

  // Upgrade: a volume written by the image from main, before versioned migrations, opens in place with the current build.
  console.log("Building the image from main and filling an old volume with it...");
  docker(["build", "-q", "-t", mainImage, "-"], execFileSync("git", ["archive", "--format=tar", "main"], { maxBuffer: 100 * 1024 * 1024 }));
  const volume = `${upgradeProject}_bucketeer-data`;
  docker(["volume", "create", "--label", `com.docker.compose.project=${upgradeProject}`, "--label", "com.docker.compose.volume=bucketeer-data", volume]);
  docker(["run", "-d", "--name", mainContainer, "-v", `${volume}:/data`, mainImage]);
  const oldCli = (...args: string[]) => docker(["exec", mainContainer, "bucketeer", "--url", "http://127.0.0.1:3000", ...args]);
  for (let attempt = 0; ; attempt++) {
    try {
      oldCli("status");
      break;
    } catch (error) {
      if (attempt >= 60) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  const oldBudget = JSON.parse(oldCli("budget", "save", "--name", "Old household", "--json"));
  const oldBudgetArgs = ["--budget", oldBudget.id];
  oldCli("account", "add", ...oldBudgetArgs, "--name", "Checking", "--type", "checking", "--starting-balance", "250.00", "--date", "2026-11-01");
  const oldGroup = JSON.parse(oldCli("group", "add", ...oldBudgetArgs, "--name", "Fixed", "--json"));
  oldCli("bucket", "add", ...oldBudgetArgs, "--name", "Rent", "--group", oldGroup.id, "--type", "recurring", "--amount", "1650");
  const archivedOld = JSON.parse(oldCli("bucket", "add", ...oldBudgetArgs, "--name", "Old", "--group", oldGroup.id, "--json"));
  oldCli("bucket", "archive", archivedOld.id);
  const oldState = {
    budgets: JSON.parse(oldCli("budget", "list", "--json")),
    accounts: JSON.parse(oldCli("account", "list", ...oldBudgetArgs, "--json")),
    buckets: JSON.parse(oldCli("bucket", "list", ...oldBudgetArgs, "--archived", "--json")),
  };
  docker(["stop", mainContainer]);
  docker(["rm", mainContainer]);

  console.log("Upgrading the old volume in place with the current build...");
  project = upgradeProject;
  port = 3000;
  const userVersion = () => Number(compose("exec", "-T", "bucketeer", "node", "--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync('/data/bucketeer.sqlite', { readOnly: true });
    console.log(database.prepare('PRAGMA user_version').get().user_version);
  `));
  const currentState = () => ({
    budgets: JSON.parse(cli("budget", "list", "--json")),
    accounts: JSON.parse(cli("account", "list", ...oldBudgetArgs, "--json")),
    buckets: JSON.parse(cli("bucket", "list", ...oldBudgetArgs, "--archived", "--json")),
  });
  compose("up", "-d", "--build", "--wait", "--wait-timeout", "60");
  assert.deepEqual(currentState(), oldState);
  assert.equal(userVersion(), 3);
  // The migrated volume takes transactions.
  const oldAccount = oldState.accounts[0].id;
  cli("tx", "add", "--account", oldAccount, "--amount", "10", "--income");
  oldState.accounts[0] = JSON.parse(cli("account", "list", ...oldBudgetArgs, "--json"))[0];
  assert.equal(oldState.accounts[0].balance, 26000);
  port = 4317;
  timeZone = "America/Los_Angeles";
  compose("up", "-d", "--force-recreate", "--wait", "--wait-timeout", "60");
  assert.deepEqual(currentState(), oldState);
  assert.equal(userVersion(), 3);
  assert.equal(compose("exec", "-T", "bucketeer", "node", "-e", "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"), "America/Los_Angeles");
  console.log("PASS: a volume from main upgrades in place to schema version 3 and keeps its data across a container recreate; TZ reaches the server.");
} finally {
  for (const name of [mainProject, upgradeProject]) {
    project = name;
    compose("down", "--volumes", "--remove-orphans", "--rmi", "local");
  }
  for (const args of [["rm", "-f", mainContainer], ["rmi", "-f", mainImage], ["volume", "rm", "-f", `${upgradeProject}_bucketeer-data`]]) {
    try {
      execFileSync("docker", args, { stdio: "ignore" });
    } catch {
      // Already gone.
    }
  }
}
