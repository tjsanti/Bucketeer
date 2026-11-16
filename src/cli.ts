#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ApiError, createClient } from "./client.js";
import type { Account, AccountType, Budget } from "./core/index.js";
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

Options:
  --url <url>    Server address (default: BUCKETEER_URL or http://localhost:3000)
  --budget <id>  Budget for account list/add (default: BUCKETEER_BUDGET)
  --starting-balance <amount>
                 Dollars, signed: 1000, 1,000.50, -412.09 (a card's debt is negative; default 0)
  --date <date>  Balance date for a new account (default: today)
  --json         Print machine-readable results and errors
  --help         Show this help
`;

// parseArgs rejects "--starting-balance -412.09" (a value that starts with "-"), so join the pair.
function joinSignedAmount(args: string[]): string[] {
  const joined: string[] = [];
  for (const arg of args) {
    if (joined.at(-1) === "--starting-balance" && /^-[\d.$]/.test(arg)) joined[joined.length - 1] += `=${arg}`;
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
    } else {
      throw new ApiError("usage", help.trim());
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

// Today in the CLI's own timezone, as YYYY-MM-DD.
function today(): string {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part, index) => String(part).padStart(index ? 2 : 4, "0")).join("-");
}
