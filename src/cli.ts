#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ApiError, createClient } from "./client.js";
import type {
  Account, AccountType, Bucket, BucketColour, BucketGroup, BucketMonth, BucketTable, BucketType, Budget, Category, GroupMonth, NewBucketInput, RegisterTransaction,
  SplitLine, Transaction,
} from "./core/index.js";
import { addMonths } from "./core/months.js";
import { formatMoney, parseMoney } from "./core/money.js";
import { BudgetError } from "./core/types.js";

const help = `Usage:
  bucketeer status [--json]
  bucketeer budget list [--json]
  bucketeer budget save --name <name> [--id <id>] [--json]
  bucketeer budget open <id> [--json]
  bucketeer account list --budget <id> [--json]
  bucketeer account add --budget <id> --name <name> --type <checking|savings|credit-card|cash>
                        [--starting-balance <amount>] [--date <YYYY-MM-DD>] [--json]
  bucketeer account edit <id> [--name <name>] [--starting-balance <amount>] [--date <YYYY-MM-DD>] [--json]
  bucketeer account close <id> [--json]
  bucketeer account reopen <id> [--json]
  bucketeer group list --budget <id> [--json]
  bucketeer group add --budget <id> --name <name> [--json]
  bucketeer group rename <id> --name <name> [--json]
  bucketeer group move <id> --position <n> [--json]
  bucketeer group delete <id> [--json]
  bucketeer bucket list --budget <id> [--archived] [--json]
  bucketeer bucket add --budget <id> --name <name> (--group <id> | --new-group <name>)
                       [--type recurring|goal|plain] [--amount <amount>] [--by <YYYY-MM>] [--colour <hue>] [--json]
  bucketeer bucket edit <id> [--name <name>] [--group <id> | --new-group <name>] [--type <type>]
                       [--amount <amount>] [--by <YYYY-MM>] [--colour <hue>] [--json]
  bucketeer bucket move <id> [--group <id>] --position <n> [--json]
  bucketeer bucket archive <id> [--json]
  bucketeer bucket restore <id> [--json]
  bucketeer tx list --account <id> [--month <YYYY-MM>] [--json]
  bucketeer tx add --account <id> --amount <amount> (--income | --bucket <id> | --line <bucketId>:<amount> --line …)
                   [--date <YYYY-MM-DD>] [--payee <payee>] [--memo <memo>] [--json]
  bucketeer tx edit <id> [--amount <amount>] [--income | --bucket <id> | --line <bucketId>:<amount> --line …] [--date <YYYY-MM-DD>] [--payee <payee>] [--memo <memo>] [--json]
  bucketeer tx delete <id> [--json]
  bucketeer ready --budget <id> [--json]
  bucketeer month --budget <id> [--month <YYYY-MM>] [--json]
  bucketeer assign <bucketId> --amount <amount> [--month <YYYY-MM>] [--json]

Options:
  --url <url>    Server address (default: BUCKETEER_URL or http://localhost:3000)
  --budget <id>  Budget for list and add commands (default: BUCKETEER_BUDGET)
  --starting-balance <amount>
                 Dollars, signed: 1000, 1,000.50, -412.09 (a card's debt is negative; default 0)
  --account <id> Account for tx list and tx add
  --date <date>  Balance date for a new account (default: today), or a transaction's date
                 (default: today in the server's time zone)
  --income       File the transaction as Income, which adds to Ready to assign
  --bucket <id>  File the transaction to a bucket: money out is spent, money in is assigned to it
  --line <bucketId>:<amount>
                 One line of a split, repeated for each bucket (at least two). Lines share the
                 transaction's sign and add up to --amount
  --type <type>  For buckets: recurring (--amount per month), goal (--amount by --by), or plain (default)
  --amount <amount>
                 Dollars: 160, 3,000.00 (signed for transactions, where Income is positive;
                 signed for assign, where -50 takes money back to Ready to assign)
  --by <month>   A goal's month, YYYY-MM
  --month <month>
                 YYYY-MM: for tx list, only that month's transactions, then the balance at its end;
                 for month and assign, the month (default: the server's current month)
  --colour <hue> sky, denim, blue, slate, teal, mint, green, forest,
                 lime, olive, sun, cocoa, peach, tangerine, rose, plum (default: least used)
  --position <n> 1 is first
  --archived     Include archived buckets
  --json         Print machine-readable results and errors
  --help         Show this help
`;

// parseArgs rejects "--starting-balance -412.09" (a value that starts with "-"), so join the pair.
function joinSignedAmount(args: string[]): string[] {
  const joined: string[] = [];
  for (const arg of args) {
    if (["--starting-balance", "--amount", "--position"].includes(joined.at(-1) ?? "") && /^-[\d.$]/.test(arg)) joined[joined.length - 1] += `=${arg}`;
    else joined.push(arg);
  }
  return joined;
}

let jsonOutput = process.argv.slice(2).includes("--json");
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: joinSignedAmount(process.argv.slice(2)),
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      url: { type: "string" },
      name: { type: "string" },
      id: { type: "string" },
      budget: { type: "string" },
      type: { type: "string" },
      "starting-balance": { type: "string" },
      date: { type: "string" },
      group: { type: "string" },
      "new-group": { type: "string" },
      amount: { type: "string" },
      by: { type: "string" },
      colour: { type: "string" },
      position: { type: "string" },
      archived: { type: "boolean" },
      account: { type: "string" },
      income: { type: "boolean" },
      bucket: { type: "string" },
      line: { type: "string", multiple: true },
      payee: { type: "string" },
      memo: { type: "string" },
      month: { type: "string" },
    },
  });
  jsonOutput = values.json;
  if (values.help) {
    console.log(help);
  } else {
    const [command, action, id] = positionals;
    const client = createClient(values.url ?? process.env.BUCKETEER_URL ?? "http://localhost:3000");
    // Reject options a command does not use, so a typo never silently does something else.
    const options = (count: number, ...allowed: string[]) => {
      const extra = Object.keys(values).filter((key) => !["json", "help", "url", ...allowed].includes(key));
      if (positionals.length !== count || extra.length) throw new ApiError("usage", help.trim());
    };
    const budget = () => {
      const found = values.budget ?? process.env.BUCKETEER_BUDGET;
      if (!found) throw new ApiError("usage", "Choose a budget with --budget <id> or BUCKETEER_BUDGET.");
      return found;
    };
    let result: unknown;
    if (command === "status") {
      options(1);
      result = await client.status();
      if (!jsonOutput) console.log("ok");
    } else if (command === "budget" && action === "list") {
      options(2);
      const budgets = await client.listBudgets();
      result = budgets;
      if (!jsonOutput) console.log(budgets.length ? budgets.map(formatBudget).join("\n") : "No saved budgets.");
    } else if (command === "budget" && action === "save" && values.name !== undefined) {
      options(2, "name", "id");
      const input = { name: values.name };
      const saved = await (values.id === undefined ? client.createBudget(input) : client.renameBudget(values.id, input));
      result = saved;
      if (!jsonOutput) console.log(formatBudget(saved));
    } else if (command === "budget" && action === "open" && id) {
      options(3);
      const opened = await client.openBudget(id);
      result = opened;
      if (!jsonOutput) console.log(formatBudget(opened));
    } else if (command === "account" && action === "list") {
      options(2, "budget");
      const accounts = await client.listAccounts(budget());
      result = accounts;
      if (!jsonOutput) console.log(accounts.length ? accounts.map(formatAccount).join("\n") : "No accounts.");
    } else if (command === "account" && action === "add" && values.name !== undefined && values.type !== undefined) {
      options(2, "budget", "name", "type", "starting-balance", "date");
      const account = await client.createAccount(budget(), {
        name: values.name,
        type: values.type as AccountType,
        startingBalance: parseMoney(values["starting-balance"] ?? "0"),
        startingDate: values.date ?? today(),
      });
      result = account;
      if (!jsonOutput) console.log(formatAccount(account));
    } else if (command === "account" && action === "edit" && id) {
      options(3, "name", "starting-balance", "date");
      const account = await client.editAccount(id, {
        ...(values.name !== undefined && { name: values.name }),
        ...(values["starting-balance"] !== undefined && { startingBalance: parseMoney(values["starting-balance"]) }),
        ...(values.date !== undefined && { startingDate: values.date }),
      });
      result = account;
      if (!jsonOutput) console.log(formatAccount(account));
    } else if (command === "account" && (action === "close" || action === "reopen") && id) {
      options(3);
      const account = await (action === "close" ? client.closeAccount(id) : client.reopenAccount(id));
      result = account;
      if (!jsonOutput) console.log(formatAccount(account));
    } else if (command === "group" && action === "list") {
      options(2, "budget");
      const { groups } = await client.listBucketTable(budget());
      result = groups;
      if (!jsonOutput) console.log(groups.length ? groups.map(formatGroup).join("\n") : "No groups.");
    } else if (command === "group" && action === "add" && values.name !== undefined) {
      options(2, "budget", "name");
      const group = await client.createGroup(budget(), { name: values.name });
      result = group;
      if (!jsonOutput) console.log(formatGroup(group));
    } else if (command === "group" && action === "rename" && id && values.name !== undefined) {
      options(3, "name");
      const group = await client.renameGroup(id, { name: values.name });
      result = group;
      if (!jsonOutput) console.log(formatGroup(group));
    } else if (command === "group" && action === "move" && id && values.position !== undefined) {
      options(3, "position");
      const group = await client.moveGroup(id, { index: position(values.position) });
      result = group;
      if (!jsonOutput) console.log(formatGroup(group));
    } else if (command === "group" && action === "delete" && id) {
      options(3);
      await client.deleteGroup(id);
      result = { id, deleted: true };
      if (!jsonOutput) console.log(`Deleted group ${id}.`);
    } else if (command === "bucket" && action === "list") {
      options(2, "budget", "archived");
      const table = await client.listBucketTable(budget());
      const shown = values.archived ? table : { groups: table.groups, buckets: table.buckets.filter((bucket) => !bucket.archived) };
      result = shown;
      if (!jsonOutput) console.log(shown.buckets.length ? shown.buckets.map((bucket) => formatBucket(bucket, table)).join("\n") : "No buckets.");
    } else if (command === "bucket" && action === "add" && values.name !== undefined) {
      options(2, "budget", "name", "group", "new-group", "type", "amount", "by", "colour");
      // The type defaults to plain, which takes no amount or month, so either without a type is a mistake.
      if (values.type === undefined && (values.amount !== undefined || values.by !== undefined)) throw new ApiError("usage", "Choose a --type for --amount or --by.");
      if ((values.group === undefined) === (values["new-group"] === undefined)) throw new ApiError("usage", "Choose a group with --group <id> or --new-group <name>.");
      const budgetId = budget();
      const input: NewBucketInput = { name: values.name, type: (values.type ?? "plain") as BucketType, ...bucketFields(values) };
      const bucket = await client.createBucket(budgetId, input);
      result = bucket;
      if (!jsonOutput) console.log(formatBucket(bucket, await client.listBucketTable(budgetId)));
    } else if (command === "bucket" && action === "edit" && id) {
      options(3, "name", "group", "new-group", "type", "amount", "by", "colour");
      if (values.group !== undefined && values["new-group"] !== undefined) throw new ApiError("usage", "Choose --group or --new-group, not both.");
      const bucket = await client.editBucket(id, {
        ...(values.name !== undefined && { name: values.name }),
        ...(values.type !== undefined && { type: values.type as BucketType }),
        ...bucketFields(values),
      });
      result = bucket;
      if (!jsonOutput) console.log(formatBucket(bucket, await client.listBucketTable(bucket.budgetId)));
    } else if (command === "bucket" && action === "move" && id && values.position !== undefined) {
      options(3, "group", "position");
      const index = position(values.position);
      const groupId = values.group ?? (await client.openBucket(id)).groupId;
      if (groupId === null) throw new ApiError("usage", "This bucket has no group; choose one with --group <id>.");
      const bucket = await client.moveBucket(id, { groupId, index });
      result = bucket;
      if (!jsonOutput) console.log(formatBucket(bucket, await client.listBucketTable(bucket.budgetId)));
    } else if (command === "bucket" && action === "archive" && id) {
      options(3);
      const archived = await client.archiveBucket(id);
      result = archived;
      if (!jsonOutput) console.log(formatBucket(archived.bucket, await client.listBucketTable(archived.bucket.budgetId)));
    } else if (command === "bucket" && action === "restore" && id) {
      options(3);
      const bucket = await client.restoreBucket(id);
      result = bucket;
      if (!jsonOutput) console.log(formatBucket(bucket, await client.listBucketTable(bucket.budgetId)));
    } else if (command === "ready") {
      options(1, "budget");
      const ready = await client.readyToAssign(budget());
      result = ready;
      if (!jsonOutput) console.log(formatMoney(ready.readyToAssign));
    } else if (command === "month" && action === undefined) {
      options(1, "budget", "month");
      const view = await client.bucketMonth(budget(), values.month ?? await currentMonth(budget()));
      result = view;
      if (!jsonOutput) {
        console.log([`${view.summary.month}\tReady to assign\t${formatMoney(view.summary.readyToAssign)}`, ...view.buckets.map((bucket) => formatBucketMonth(bucket, view.groups))].join("\n"));
      }
    } else if (command === "assign" && action !== undefined && values.amount !== undefined) {
      options(2, "amount", "month");
      const budgetId = (await client.openBucket(action)).budgetId;
      const assigned = await client.assign(action, { month: values.month ?? await currentMonth(budgetId), amount: parseMoney(values.amount) });
      result = assigned;
      if (!jsonOutput) console.log(formatBucketMonth(assigned, (await client.bucketMonth(budgetId, assigned.month)).groups));
    } else if (command === "tx" && action === "list" && values.account !== undefined) {
      options(2, "account", "month");
      const names = await bucketNames((await client.openAccount(values.account)).budgetId);
      const listed = (rows: { transactions: RegisterTransaction[] }) => rows.transactions.length ? rows.transactions.map((row) => formatTransaction(row, names)).join("\n") : "No transactions.";
      if (values.month === undefined) {
        const register = await client.listTransactions(values.account);
        result = register;
        if (!jsonOutput) console.log(listed(register));
      } else {
        const month = await client.accountMonth(values.account, values.month);
        result = month;
        if (!jsonOutput) console.log(`${listed(month)}\nBalance at end of ${values.month}\t${formatMoney(month.balance)}`);
      }
    } else if (command === "tx" && action === "add" && values.account !== undefined && values.amount !== undefined) {
      options(2, "account", "amount", "income", "bucket", "line", "date", "payee", "memo");
      const category = categoryOption(values);
      if (!category) throw new ApiError("usage", "Choose a category with --income, --bucket <id> or --line <bucketId>:<amount>.");
      const added = await client.addTransaction(values.account, { amount: parseMoney(values.amount), category, ...transactionFields(values) });
      result = added;
      if (!jsonOutput) console.log(await inRegister(added));
    } else if (command === "tx" && action === "edit" && id && ["amount", "income", "bucket", "line", "date", "payee", "memo"].some((key) => key in values)) {
      options(3, "amount", "income", "bucket", "line", "date", "payee", "memo");
      const category = categoryOption(values);
      const edited = await client.editTransaction(id, {
        ...(values.amount !== undefined && { amount: parseMoney(values.amount) }),
        ...(category && { category }),
        ...transactionFields(values),
      });
      result = edited;
      if (!jsonOutput) console.log(await inRegister(edited));
    } else if (command === "tx" && action === "delete" && id) {
      options(3);
      await client.deleteTransaction(id);
      result = { id, deleted: true };
      if (!jsonOutput) console.log(`Deleted transaction ${id}.`);
    } else {
      throw new ApiError("usage", help.trim());
    }

    // The transaction as its account's register shows it, with the running balance.
    async function inRegister(transaction: Transaction): Promise<string> {
      const { transactions } = await client.listTransactions(transaction.accountId);
      const row = transactions.find((found) => found.id === transaction.id) ?? { ...transaction, runningBalance: 0 };
      return formatTransaction(row, await bucketNames(transaction.budgetId));
    }

    // The server's current month: its month range ends 12 months after it.
    async function currentMonth(budgetId: string): Promise<string> {
      return addMonths((await client.monthRange(budgetId)).last, -12);
    }

    async function bucketNames(budgetId: string): Promise<Map<string, string>> {
      return new Map((await client.listBucketTable(budgetId)).buckets.map((bucket) => [bucket.id, bucket.name]));
    }
    if (jsonOutput) console.log(JSON.stringify(result));
  }
} catch (error) {
  const code = error instanceof ApiError || error instanceof BudgetError ? error.code : "cli_error";
  const message = error instanceof Error ? error.message : String(error);
  if (jsonOutput) console.log(JSON.stringify({ error: { code, message } }));
  else console.error(message);
  process.exitCode = 1;
}

function formatBudget(budget: Budget): string {
  return `${budget.id}\t${budget.name}`;
}

function formatAccount(account: Account): string {
  const fields = [account.id, account.name, account.type, formatMoney(account.balance)];
  return (account.closed ? [...fields, "closed"] : fields).join("\t");
}

// The bucket fields shared by add and edit; the server validates them.
function bucketFields(values: { group?: string; "new-group"?: string; amount?: string; by?: string; colour?: string }) {
  return {
    ...(values.group !== undefined && { groupId: values.group }),
    ...(values["new-group"] !== undefined && { newGroupName: values["new-group"] }),
    ...(values.amount !== undefined && { amount: parseMoney(values.amount) }),
    ...(values.by !== undefined && { goalMonth: values.by }),
    ...(values.colour !== undefined && { colour: values.colour as BucketColour }),
  };
}

// --position is 1-based; the API index is position - 1.
function position(text: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(text)) throw new BudgetError("invalid_input", "Position must be a whole number from 1.");
  return Number(text) - 1;
}

// The one category option given, or undefined for none; two is a usage error. Repeated --line options make one split.
function categoryOption(values: { income?: boolean; bucket?: string; line?: string[] }): Category | undefined {
  const given: Category[] = [];
  if (values.income) given.push({ kind: "income" });
  if (values.bucket !== undefined) given.push({ kind: "bucket", bucketId: values.bucket });
  if (values.line !== undefined) given.push({ kind: "split", lines: values.line.map(splitLine) });
  if (given.length > 1) throw new ApiError("usage", "Give one category: --income, --bucket <id> or --line <bucketId>:<amount> (repeated).");
  return given[0];
}

// "<bucketId>:<amount>", amount in signed dollars.
function splitLine(text: string): SplitLine {
  const colon = text.lastIndexOf(":");
  if (colon <= 0) throw new BudgetError("invalid_input", "Write each split line as --line <bucketId>:<amount>.");
  return { bucketId: text.slice(0, colon), amount: parseMoney(text.slice(colon + 1)), memo: "" };
}

function transactionFields(values: { date?: string; payee?: string; memo?: string }) {
  return {
    ...(values.date !== undefined && { date: values.date }),
    ...(values.payee !== undefined && { payee: values.payee }),
    ...(values.memo !== undefined && { memo: values.memo }),
  };
}

// id, date, payee, category, amount, running balance.
function formatTransaction(transaction: RegisterTransaction, bucketNames: Map<string, string>): string {
  const { category: filed } = transaction;
  const category = filed.kind === "income" ? "Income" : filed.kind === "split" ? `Split (${filed.lines.length})` : bucketNames.get(filed.bucketId) ?? filed.bucketId;
  return [transaction.id, transaction.date, transaction.payee, category, formatMoney(transaction.amount), formatMoney(transaction.runningBalance)].join("\t");
}

function formatGroup(group: BucketGroup): string {
  return `${group.id}\t${group.name}`;
}

function targetOf(bucket: Bucket): string {
  return bucket.amount === null ? ""
    : bucket.type === "goal" ? `${formatMoney(bucket.amount)} by ${bucket.goalMonth}`
    : `${formatMoney(bucket.amount)}/month`;
}

// id, group, name, type, target, available, and "archived" when archived.
function formatBucket(bucket: Bucket, table: BucketTable): string {
  const group = table.groups.find((candidate) => candidate.id === bucket.groupId)?.name ?? "";
  const fields = [bucket.id, group, bucket.name, bucket.type, targetOf(bucket), formatMoney(bucket.available)];
  return (bucket.archived ? [...fields, "archived"] : fields).join("\t");
}

// group, name, target, assigned, spent, available in the month, and "archived" when archived.
function formatBucketMonth(bucket: BucketMonth, groups: readonly GroupMonth[]): string {
  const group = groups.find((candidate) => candidate.id === bucket.groupId)?.name ?? "";
  const fields = [group, bucket.name, targetOf(bucket), formatMoney(bucket.assigned), formatMoney(bucket.spent), formatMoney(bucket.available)];
  return (bucket.archived ? [...fields, "archived"] : fields).join("\t");
}

// Today in the CLI's own timezone, as YYYY-MM-DD.
function today(): string {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part, index) => String(part).padStart(index ? 2 : 4, "0")).join("-");
}
