// The add/take rules shared by the desktop pill and the phone sheet: what a typed draft means for one bucket.
// Pure and DOM-free. A positive change adds from Ready to assign; a negative one takes back to it. The limits are
// the server's figures (Ready to assign, and each bucket's takeable) and the refusals are core's own wording.
import { addRefusal, takeRefusal } from "../core/refusals.js";
import { formatMoney } from "../core/money.js";

export const MINUS = "−";

export type Draft =
  | { kind: "empty" }
  /** A lone sign: not an amount yet, and not an error until it is applied. */
  | { kind: "draft" }
  | { kind: "error"; message: string }
  | { kind: "ok"; delta: number };

/** Reads a draft such as "20", "+20.50", "-20" or "−20" against the bucket's takeable and Ready to assign (cents). */
export function readDraft(text: string, bucket: { name: string; takeable: number }, readyToAssign: number): Draft {
  let rest = text.trim();
  if (!rest) return { kind: "empty" };
  let sign = 1;
  if (rest[0] === "-" || rest[0] === MINUS) { sign = -1; rest = rest.slice(1); }
  else if (rest[0] === "+") rest = rest.slice(1);
  if (rest === "" || rest === ".") return { kind: "draft" };
  if (/^\d*\.\d{3,}$/.test(rest)) return { kind: "error", message: "Use at most two decimal places, like 20.50." };
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(rest)) return { kind: "error", message: `Type an amount like 20, or ${MINUS}20 to take money out.` };
  const [whole = "", fraction = ""] = rest.split(".");
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { kind: "error", message: "That amount is too large. Enter a smaller amount." };
  if (cents === 0) return { kind: "error", message: "Type an amount greater than zero." };
  const delta = sign * cents;
  if (delta > readyToAssign) return { kind: "error", message: addRefusal(readyToAssign) };
  if (-delta > bucket.takeable) return { kind: "error", message: takeRefusal(bucket.name, bucket.takeable) };
  return { kind: "ok", delta };
}

/** "Added $20.00 to Fuel" / "Took $20.00 from Fuel" once done; "Add …" / "Take …" as an instruction (a button, a preview). */
export function describeChange(name: string, delta: number, form: "done" | "instruction" = "done"): string {
  const amount = formatMoney(Math.abs(delta), { symbol: true });
  if (form === "instruction") return delta > 0 ? `Add ${amount} to ${name}` : `Take ${amount} from ${name}`;
  return delta > 0 ? `Added ${amount} to ${name}` : `Took ${amount} from ${name}`;
}

/** "+20.00" / "−20.00", for the pill's confirmation. */
export const signed = (delta: number) => `${delta > 0 ? "+" : MINUS}${formatMoney(Math.abs(delta))}`;
