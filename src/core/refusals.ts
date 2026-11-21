// The wording of an add or take the budget refuses (ADR-0003). Core throws it; the browser shows the same words
// while a draft is typed, so this module imports nothing the browser can't load.
import { formatMoney } from "./money.js";

/** The refusal for an add beyond Ready to assign (shared with clients, which check a draft before sending it). */
export function addRefusal(readyToAssign: number): string {
  return readyToAssign > 0 ? `Only ${formatMoney(readyToAssign, { symbol: true })} is ready to assign. You can add up to that.` : "Nothing is ready to assign.";
}

/** The refusal for a take beyond what the bucket can give (`takeable`: lowestAvailableFrom, at least 0). */
export function takeRefusal(name: string, takeable: number): string {
  return takeable > 0 ? `${name} has ${formatMoney(takeable, { symbol: true })} available. You can take up to that.` : `${name} has nothing available to take.`;
}
