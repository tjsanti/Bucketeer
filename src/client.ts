import type { Account, AccountEditInput, Budget, BudgetNameInput, Health, NewAccountInput } from "./core/index.js";

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

  const send = (method: string, body?: unknown): RequestInit => body === undefined
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const account = (id: string) => `/api/accounts/${encodeURIComponent(id)}`;

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
    listAccounts: (budgetId: string) => request<Account[]>(`/api/budgets/${encodeURIComponent(budgetId)}/accounts`),
    createAccount: (budgetId: string, input: NewAccountInput) => request<Account>(`/api/budgets/${encodeURIComponent(budgetId)}/accounts`, send("POST", input)),
    openAccount: (id: string) => request<Account>(account(id)),
    editAccount: (id: string, input: AccountEditInput) => request<Account>(account(id), send("PATCH", input)),
    closeAccount: (id: string) => request<Account>(`${account(id)}/close`, send("POST")),
    reopenAccount: (id: string) => request<Account>(`${account(id)}/reopen`, send("POST")),
  };
}
