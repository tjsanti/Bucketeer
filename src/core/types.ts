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

export type AccountType = "checking" | "savings" | "credit-card" | "cash";

export interface Account {
  id: string;
  budgetId: string;
  name: string;
  type: AccountType;
  /** Integer cents, signed; a card's debt is negative. */
  startingBalance: number;
  /** YYYY-MM-DD, a real calendar date. */
  startingDate: string;
  /** Integer cents. Equals startingBalance until spending exists. */
  balance: number;
  order: number;
  closed: boolean;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewAccountInput {
  name: string;
  type: AccountType;
  startingBalance: number;
  startingDate: string;
}

export interface AccountEditInput {
  name?: string;
  startingBalance?: number;
  startingDate?: string;
}

export type BudgetErrorCode = "invalid_input" | "not_found" | "name_taken" | "balance_not_zero";

export class BudgetError extends Error {
  constructor(
    public readonly code: BudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}
