// Pure and dependency-free (apart from the error class): the server serves this module to the browser unchanged.
import { BudgetError } from "./types.js";

const MINUS = "−";
const amount = /^([-+−])?(\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/** "1,234.56", "-$412.09", "−412.09", "+5" -> integer cents. Throws invalid_input for anything else. */
export function parseMoney(text: string): number {
  const match = amount.exec(typeof text === "string" ? text.trim() : "");
  if (!match) throw new BudgetError("invalid_input", "Enter an amount like 1,234.56 with at most two decimals.");
  const [, sign, , whole = "", fraction = ""] = match;
  const cents = Number(whole.replaceAll(",", "")) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new BudgetError("invalid_input", "That amount is too large.");
  return sign === "-" || sign === MINUS ? -cents || 0 : cents;
}

/** Integer cents -> "2,463.35", "−412.09" (U+2212), or with symbol "$8,141.26" / "−$412.09". */
export function formatMoney(cents: number, options: { symbol?: boolean } = {}): string {
  if (!Number.isSafeInteger(cents)) throw new BudgetError("invalid_input", "Amount must be a whole number of cents.");
  const absolute = Math.abs(cents);
  const dollars = String(Math.floor(absolute / 100)).replace(/\B(?=(\d{3})+$)/g, ",");
  const text = `${options.symbol ? "$" : ""}${dollars}.${String(absolute % 100).padStart(2, "0")}`;
  return cents < 0 ? MINUS + text : text;
}
