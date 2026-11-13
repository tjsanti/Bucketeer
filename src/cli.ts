#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ApiError, createClient } from "./client.js";
import type { Budget } from "./core/index.js";

const help = `Usage:
  bucketeer status [--json]
  bucketeer budget list [--json]
  bucketeer budget save --name <name> [--id <id>] [--json]
  bucketeer budget open <id> [--json]

Options:
  --url <url>    Server address (default: BUCKETEER_URL or http://localhost:3000)
  --json         Print machine-readable results and errors
  --help         Show this help
`;

let jsonOutput = process.argv.slice(2).includes("--json");
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      url: { type: "string" },
      name: { type: "string" },
      id: { type: "string" },
    },
  });
  jsonOutput = values.json;
  if (values.help) {
    console.log(help);
  } else {
    const [command, action, id] = positionals;
    const client = createClient(values.url ?? process.env.BUCKETEER_URL ?? "http://localhost:3000");
    let result: unknown;
    if (command === "status" && positionals.length === 1 && values.name === undefined && values.id === undefined) {
      result = await client.status();
      if (!jsonOutput) console.log("ok");
    } else if (command === "budget" && action === "list" && positionals.length === 2 && values.name === undefined && values.id === undefined) {
      const budgets = await client.listBudgets();
      result = budgets;
      if (!jsonOutput) console.log(budgets.length ? budgets.map(formatBudget).join("\n") : "No saved budgets.");
    } else if (command === "budget" && action === "save" && positionals.length === 2 && values.name !== undefined) {
      const input = { name: values.name };
      const budget = await (values.id === undefined ? client.createBudget(input) : client.renameBudget(values.id, input));
      result = budget;
      if (!jsonOutput) console.log(formatBudget(budget));
    } else if (command === "budget" && action === "open" && positionals.length === 3 && id && values.name === undefined && values.id === undefined) {
      const budget = await client.openBudget(id);
      result = budget;
      if (!jsonOutput) console.log(formatBudget(budget));
    } else {
      throw new ApiError("usage", help.trim());
    }
    if (jsonOutput) console.log(JSON.stringify(result));
  }
} catch (error) {
  const code = error instanceof ApiError ? error.code : "cli_error";
  const message = error instanceof Error ? error.message : String(error);
  if (jsonOutput) console.log(JSON.stringify({ error: { code, message } }));
  else console.error(message);
  process.exitCode = 1;
}

function formatBudget(budget: Budget): string {
  return `${budget.id}\t${budget.name}`;
}
