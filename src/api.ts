import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BudgetError } from "./core/index.js";
import type { Bucketeer } from "./core/index.js";

interface Asset {
  readonly file: string;
  readonly type: string;
  readonly cache: string;
}

const revalidate = "no-cache";
const assets = new Map<string, Asset>([
  ["/", { file: "./ui/index.html", type: "text/html; charset=utf-8", cache: revalidate }],
  ["/ui/styles.css", { file: "./ui/styles.css", type: "text/css; charset=utf-8", cache: revalidate }],
  ["/client.js", { file: "./client.js", type: "text/javascript; charset=utf-8", cache: revalidate }],
  // Shared with the browser: money.js imports types.js at runtime.
  ["/core/money.js", { file: "./core/money.js", type: "text/javascript; charset=utf-8", cache: revalidate }],
  ["/core/types.js", { file: "./core/types.js", type: "text/javascript; charset=utf-8", cache: revalidate }],
  // Month arithmetic for the month header, shared like money.js.
  ["/core/months.js", { file: "./core/months.js", type: "text/javascript; charset=utf-8", cache: revalidate }],
  // Palette order and the least-used colour rule, shared with the browser like money.js.
  ["/core/colours.js", { file: "./core/colours.js", type: "text/javascript; charset=utf-8", cache: revalidate }],
]);

// Bundled fonts and their licences, copied into dist/ui/fonts by the build.
// Font names carry a content hash, so a changed font gets a new URL and can be cached forever.
function findAsset(pathname: string): Asset | undefined {
  const known = assets.get(pathname);
  if (known) return known;
  // Path-routed pages: the UI reads the budget ID from the URL.
  if (/^\/budgets\/[^/]+\/(?:accounts|buckets|accounts\/[^/]+)\/?$/.test(pathname)) return assets.get("/");
  // Compiled UI modules (app.js, theme.js, accounts.js, ...) live flat in dist/ui.
  const script = /^\/ui\/([a-z][a-z0-9-]*\.js)$/.exec(pathname)?.[1];
  if (script) return { file: `./ui/${script}`, type: "text/javascript; charset=utf-8", cache: revalidate };
  const font = /^\/ui\/fonts\/([a-z0-9-]+\.[0-9a-f]{8}\.woff2)$/.exec(pathname)?.[1];
  if (font) return { file: `./ui/fonts/${font}`, type: "font/woff2", cache: "public, max-age=31536000, immutable" };
  const licence = /^\/ui\/fonts\/([A-Za-z0-9-]+\.txt)$/.exec(pathname)?.[1];
  if (licence) return { file: `./ui/fonts/${licence}`, type: "text/plain; charset=utf-8", cache: revalidate };
  return undefined;
}

async function readAsset(path: string): Promise<Buffer> {
  try {
    return await readFile(new URL(path, import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "not_found", "Route not found.");
    throw error;
  }
}

class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

const statuses = { invalid_input: 400, not_found: 404, name_taken: 409, balance_not_zero: 409, group_not_empty: 409, bucket_overspent: 409, bucket_changed: 409, account_closed: 409, bucket_archived: 409, bucket_has_future: 409, not_enough_ready: 409, not_enough_available: 409, money_moved: 409, rain_changed: 409 } as const;

function decodeId(segment: string, what: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "invalid_input", `${what} ID is malformed.`);
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Use Content-Type: application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, "payload_too_large", "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export function createApi(core: Bucketeer) {
  return createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && pathname === "/health") {
        try {
          json(response, 200, core.health());
        } catch {
          json(response, 503, { error: { code: "unhealthy", message: "Database is unavailable." } });
        }
        return;
      }
      if (pathname === "/api/budgets" && request.method === "GET") {
        json(response, 200, core.listBudgets());
        return;
      }
      if (pathname === "/api/budgets" && request.method === "POST") {
        const budget = core.createBudget(await readJson(request));
        response.setHeader("location", `/api/budgets/${budget.id}`);
        json(response, 201, budget);
        return;
      }
      const budgetAccounts = /^\/api\/budgets\/([^/]+)\/accounts$/.exec(pathname)?.[1];
      if (budgetAccounts && request.method === "GET") {
        json(response, 200, core.listAccounts(decodeId(budgetAccounts, "Budget")));
        return;
      }
      if (budgetAccounts && request.method === "POST") {
        const account = core.createAccount(decodeId(budgetAccounts, "Budget"), await readJson(request));
        response.setHeader("location", `/api/accounts/${encodeURIComponent(account.id)}`);
        json(response, 201, account);
        return;
      }
      const budgetReady = /^\/api\/budgets\/([^/]+)\/ready-to-assign$/.exec(pathname)?.[1];
      if (budgetReady && request.method === "GET") {
        json(response, 200, { readyToAssign: core.readyToAssign(decodeId(budgetReady, "Budget")) });
        return;
      }
      const budgetPayees = /^\/api\/budgets\/([^/]+)\/payees$/.exec(pathname)?.[1];
      if (budgetPayees && request.method === "GET") {
        json(response, 200, core.payees(decodeId(budgetPayees, "Budget")));
        return;
      }
      // Recent activity: ?limit=n, the ten newest by default.
      const budgetTransactions = /^\/api\/budgets\/([^/]+)\/transactions$/.exec(pathname)?.[1];
      if (budgetTransactions && request.method === "GET") {
        const limit = new URL(request.url ?? "/", "http://localhost").searchParams.get("limit");
        const read = limit === null ? 10 : /^\d{1,9}$/.test(limit) ? Number(limit) : limit;
        json(response, 200, core.listBudgetTransactions(decodeId(budgetTransactions, "Budget"), { limit: read }));
        return;
      }
      const budgetRange = /^\/api\/budgets\/([^/]+)\/month-range$/.exec(pathname)?.[1];
      if (budgetRange && request.method === "GET") {
        // With the range, the server's today: clients default new dates to it, never their own clock (ADR-0007).
        json(response, 200, { ...core.monthRange(decodeId(budgetRange, "Budget")), today: core.today() });
        return;
      }
      const budgetBalances = /^\/api\/budgets\/([^/]+)\/account-balances$/.exec(pathname)?.[1];
      if (budgetBalances && request.method === "GET") {
        const month = new URL(request.url ?? "/", "http://localhost").searchParams.get("month");
        json(response, 200, core.accountBalances(decodeId(budgetBalances, "Budget"), month ?? ""));
        return;
      }
      const budgetRain = /^\/api\/budgets\/([^/]+)\/months\/([^/]+)\/rain$/.exec(pathname);
      if (budgetRain?.[1] && budgetRain[2]) {
        const [budgetId, month] = [decodeId(budgetRain[1], "Budget"), decodeId(budgetRain[2], "Month")];
        if (request.method === "GET") {
          json(response, 200, core.planRain(budgetId, month));
          return;
        }
        if (request.method === "POST") {
          // The body, { expect: plan }, is optional: without one the server rains whatever the plan is now.
          const body = request.headers["content-type"] === undefined ? undefined : await readJson(request);
          json(response, 201, core.rain(budgetId, month, body));
          return;
        }
      }
      const rainUndo = /^\/api\/rains\/([^/]+)\/undo$/.exec(pathname)?.[1];
      if (rainUndo && request.method === "POST") {
        core.undoRain(decodeId(rainUndo, "Rain"));
        response.writeHead(204, { "cache-control": "no-store" }).end();
        return;
      }
      const budgetMonth = /^\/api\/budgets\/([^/]+)\/months\/([^/]+)$/.exec(pathname);
      if (budgetMonth?.[1] && budgetMonth[2] && request.method === "GET") {
        json(response, 200, core.bucketMonth(decodeId(budgetMonth[1], "Budget"), decodeId(budgetMonth[2], "Month")));
        return;
      }
      const accountMonth = /^\/api\/accounts\/([^/]+)\/months\/([^/]+)$/.exec(pathname);
      if (accountMonth?.[1] && accountMonth[2] && request.method === "GET") {
        json(response, 200, core.accountMonth(decodeId(accountMonth[1], "Account"), decodeId(accountMonth[2], "Month")));
        return;
      }
      const accountTransactions = /^\/api\/accounts\/([^/]+)\/transactions$/.exec(pathname)?.[1];
      if (accountTransactions && request.method === "GET") {
        json(response, 200, core.listTransactions(decodeId(accountTransactions, "Account")));
        return;
      }
      if (accountTransactions && request.method === "POST") {
        const id = decodeId(accountTransactions, "Account");
        const created = core.addTransaction(id, await readJson(request));
        response.setHeader("location", `/api/transactions/${encodeURIComponent(created.id)}`);
        json(response, 201, created);
        return;
      }
      const transactionRoute = /^\/api\/transactions\/([^/]+)$/.exec(pathname)?.[1];
      if (transactionRoute && ["GET", "PATCH", "DELETE"].includes(request.method ?? "")) {
        const id = decodeId(transactionRoute, "Transaction");
        if (request.method === "GET") json(response, 200, core.openTransaction(id));
        else if (request.method === "PATCH") json(response, 200, core.editTransaction(id, await readJson(request)));
        else {
          core.deleteTransaction(id);
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        }
        return;
      }
      const accountRoute = /^\/api\/accounts\/([^/]+)(?:\/(close|reopen))?$/.exec(pathname);
      if (accountRoute?.[1]) {
        const id = decodeId(accountRoute[1], "Account");
        const action = accountRoute[2];
        if (!action && request.method === "GET") {
          json(response, 200, core.openAccount(id));
          return;
        }
        if (!action && request.method === "PATCH") {
          json(response, 200, core.editAccount(id, await readJson(request)));
          return;
        }
        if (action && request.method === "POST") {
          json(response, 200, action === "close" ? core.closeAccount(id) : core.reopenAccount(id));
          return;
        }
      }
      const budgetBuckets = /^\/api\/budgets\/([^/]+)\/(buckets|groups)$/.exec(pathname);
      if (budgetBuckets?.[1]) {
        const budgetId = decodeId(budgetBuckets[1], "Budget");
        if (budgetBuckets[2] === "buckets" && request.method === "GET") {
          json(response, 200, core.listBucketTable(budgetId));
          return;
        }
        if (budgetBuckets[2] === "buckets" && request.method === "POST") {
          const bucket = core.createBucket(budgetId, await readJson(request));
          response.setHeader("location", `/api/buckets/${encodeURIComponent(bucket.id)}`);
          json(response, 201, bucket);
          return;
        }
        if (budgetBuckets[2] === "groups" && request.method === "POST") {
          const group = core.createGroup(budgetId, await readJson(request));
          response.setHeader("location", `/api/groups/${encodeURIComponent(group.id)}`);
          json(response, 201, group);
          return;
        }
      }
      const groupRoute = /^\/api\/groups\/([^/]+)(?:\/(move))?$/.exec(pathname);
      if (groupRoute?.[1]) {
        const id = decodeId(groupRoute[1], "Group");
        if (!groupRoute[2] && request.method === "PATCH") {
          json(response, 200, core.renameGroup(id, await readJson(request)));
          return;
        }
        if (!groupRoute[2] && request.method === "DELETE") {
          core.deleteGroup(id);
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
          return;
        }
        if (groupRoute[2] && request.method === "POST") {
          json(response, 200, core.moveGroup(id, await readJson(request)));
          return;
        }
      }
      const bucketAssign = /^\/api\/buckets\/([^/]+)\/assign$/.exec(pathname)?.[1];
      if (bucketAssign && request.method === "POST") {
        json(response, 200, core.assign(decodeId(bucketAssign, "Bucket"), await readJson(request)));
        return;
      }
      const bucketRoute = /^\/api\/buckets\/([^/]+)(?:\/(move|archive|restore|revert))?$/.exec(pathname);
      if (bucketRoute?.[1]) {
        const id = decodeId(bucketRoute[1], "Bucket");
        const action = bucketRoute[2];
        if (!action && request.method === "GET") {
          json(response, 200, core.openBucket(id));
          return;
        }
        if (!action && request.method === "PATCH") {
          json(response, 200, core.editBucket(id, await readJson(request)));
          return;
        }
        if (action && request.method === "POST") {
          json(response, 200, action === "move" ? core.moveBucket(id, await readJson(request))
            : action === "revert" ? core.revertBucket(id, await readJson(request))
            : action === "archive" ? core.archiveBucket(id) : core.restoreBucket(id));
          return;
        }
      }
      const match = /^\/api\/budgets\/([^/]+)$/.exec(pathname);
      if (match?.[1]) {
        const id = decodeId(match[1], "Budget");
        if (request.method === "GET") {
          json(response, 200, core.openBudget(id));
          return;
        }
        if (request.method === "PUT") {
          json(response, 200, core.renameBudget(id, await readJson(request)));
          return;
        }
      }
      const asset = findAsset(pathname);
      if (asset && (request.method === "GET" || request.method === "HEAD")) {
        const content = await readAsset(asset.file);
        response.writeHead(200, { "content-type": asset.type, "cache-control": asset.cache });
        response.end(request.method === "HEAD" ? undefined : content);
        return;
      }
      throw new HttpError(404, "not_found", "Route not found.");
    } catch (error) {
      if (error instanceof BudgetError) {
        json(response, statuses[error.code], { error: { code: error.code, message: error.message, ...(error.field && { field: error.field }) } });
      } else if (error instanceof HttpError) {
        json(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        console.error(error);
        json(response, 500, { error: { code: "internal_error", message: "The server could not complete the request." } });
      }
    }
  });
}
