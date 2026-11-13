export interface Budget {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetNameInput {
  name: string;
}

export interface Health {
  status: "ok";
}

export class BudgetError extends Error {
  constructor(
    public readonly code: "invalid_input" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}
