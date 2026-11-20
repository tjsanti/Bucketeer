import type {
  Account, AccountEditInput, ArchiveResult, Bucket, BucketEditInput, BucketGroup, BucketMoveInput, BucketTable, Budget, BudgetNameInput,
  GroupNameInput, Health, MoveInput, NewAccountInput, NewBucketInput,
} from "./core/index.js";

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
    if (response.status === 204) return undefined as T;
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
  const budgetPath = (id: string) => `/api/budgets/${encodeURIComponent(id)}`;
  const group = (id: string) => `/api/groups/${encodeURIComponent(id)}`;
  const bucket = (id: string) => `/api/buckets/${encodeURIComponent(id)}`;

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
    listBucketTable: (budgetId: string) => request<BucketTable>(`${budgetPath(budgetId)}/buckets`),
    createGroup: (budgetId: string, input: GroupNameInput) => request<BucketGroup>(`${budgetPath(budgetId)}/groups`, send("POST", input)),
    renameGroup: (id: string, input: GroupNameInput) => request<BucketGroup>(group(id), send("PATCH", input)),
    moveGroup: (id: string, input: MoveInput) => request<BucketGroup>(`${group(id)}/move`, send("POST", input)),
    deleteGroup: (id: string) => request<void>(group(id), send("DELETE")),
    createBucket: (budgetId: string, input: NewBucketInput) => request<Bucket>(`${budgetPath(budgetId)}/buckets`, send("POST", input)),
    openBucket: (id: string) => request<Bucket>(bucket(id)),
    editBucket: (id: string, input: BucketEditInput) => request<Bucket>(bucket(id), send("PATCH", input)),
    moveBucket: (id: string, input: BucketMoveInput) => request<Bucket>(`${bucket(id)}/move`, send("POST", input)),
    archiveBucket: (id: string) => request<ArchiveResult>(`${bucket(id)}/archive`, send("POST")),
    restoreBucket: (id: string) => request<Bucket>(`${bucket(id)}/restore`, send("POST")),
  };
}
