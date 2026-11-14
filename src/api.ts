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
  ["/ui/app.js", { file: "./ui/app.js", type: "text/javascript; charset=utf-8", cache: revalidate }],
  ["/ui/styles.css", { file: "./ui/styles.css", type: "text/css; charset=utf-8", cache: revalidate }],
  ["/ui/theme.js", { file: "./ui/theme.js", type: "text/javascript; charset=utf-8", cache: revalidate }],
  ["/client.js", { file: "./client.js", type: "text/javascript; charset=utf-8", cache: revalidate }],
]);

// Bundled fonts and their licences, copied into dist/ui/fonts by the build.
// Font names carry a content hash, so a changed font gets a new URL and can be cached forever.
function findAsset(pathname: string): Asset | undefined {
  const known = assets.get(pathname);
  if (known) return known;
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
      const match = /^\/api\/budgets\/([^/]+)$/.exec(pathname);
      if (match?.[1]) {
        let id: string;
        try {
          id = decodeURIComponent(match[1]);
        } catch {
          throw new HttpError(400, "invalid_input", "Budget ID is malformed.");
        }
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
        json(response, error.code === "not_found" ? 404 : 400, { error: { code: error.code, message: error.message } });
      } else if (error instanceof HttpError) {
        json(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        console.error(error);
        json(response, 500, { error: { code: "internal_error", message: "The server could not complete the request." } });
      }
    }
  });
}
