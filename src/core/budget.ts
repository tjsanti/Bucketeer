import { BudgetError } from "./types.js";

export const MAX_BUDGET_NAME_LENGTH = 120;

export function readBudgetName(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input) || !("name" in input)) {
    throw new BudgetError("invalid_input", "A budget name is required.");
  }
  if ("id" in input) {
    throw new BudgetError("invalid_input", "Budget IDs are assigned by the server and cannot be changed.");
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || [...name].length > MAX_BUDGET_NAME_LENGTH) {
    throw new BudgetError("invalid_input", `Budget name must be between 1 and ${MAX_BUDGET_NAME_LENGTH} characters.`);
  }
  if (name.includes("\0")) {
    throw new BudgetError("invalid_input", "Budget name cannot contain null characters.");
  }
  return name;
}
