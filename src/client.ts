import type { Budget, BudgetNameInput, Health } from "./core/index.js";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function createClient(baseUrl: string) {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("Server URL must use HTTP or HTTPS.");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new ApiError("unreachable", "Cannot reach the Bucketeer server. Check its address and whether it is running.");
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new ApiError("invalid_response", "Server returned an invalid JSON response.");
    }
    if (!response.ok) {
      throw new ApiError(body?.error?.code ?? "request_failed", body?.error?.message ?? `Request failed with HTTP ${response.status}.`);
    }
    return body as T;
  }

  return {
    status: () => request<Health>("/health"),
    listBudgets: () => request<Budget[]>("/api/budgets"),
    openBudget: (id: string) => request<Budget>(`/api/budgets/${encodeURIComponent(id)}`),
    createBudget: (input: BudgetNameInput) => request<Budget>("/api/budgets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    renameBudget: (id: string, input: BudgetNameInput) => request<Budget>(`/api/budgets/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  };
}
