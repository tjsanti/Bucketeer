import assert from "node:assert/strict";
import { test } from "node:test";
import { readDraft } from "../src/ui/add-take.js";

const MINUS = "−";
const gifts = { name: "Gifts", available: 45_500 };

test("an add or a take within the limits is a signed change in cents", () => {
  assert.deepEqual(readDraft("20", gifts, 41_250), { kind: "ok", delta: 2_000 });
  assert.deepEqual(readDraft("+20.5", gifts, 41_250), { kind: "ok", delta: 2_050 });
  assert.deepEqual(readDraft("-20", gifts, 41_250), { kind: "ok", delta: -2_000 });
  assert.deepEqual(readDraft(`${MINUS}455`, gifts, 41_250), { kind: "ok", delta: -45_500 });
  assert.deepEqual(readDraft("412.50", gifts, 41_250), { kind: "ok", delta: 41_250 });
});

test("empty and a lone sign are not errors yet", () => {
  assert.deepEqual(readDraft("  ", gifts, 41_250), { kind: "empty" });
  assert.deepEqual(readDraft("-", gifts, 41_250), { kind: "draft" });
});

test("adding more than Ready to assign, or taking more than Available, says how much is there", () => {
  assert.deepEqual(readDraft("500", gifts, 41_250), { kind: "error", message: "Only $412.50 is ready to assign. You can add up to that." });
  assert.deepEqual(readDraft("-455.01", gifts, 41_250), { kind: "error", message: "Gifts has $455.00 available. You can take up to that." });
  assert.deepEqual(readDraft("5", gifts, 0), { kind: "error", message: "Nothing is ready to assign right now." });
  assert.deepEqual(readDraft("-5", { name: "Gifts", available: -1_000 }, 41_250), { kind: "error", message: "Gifts has no money available to take." });
});

test("malformed amounts are rejected", () => {
  for (const text of ["abc", "20.555", "2-0", "--20", "0", "1e3", "$"]) {
    const result = readDraft(text, gifts, 41_250);
    assert.equal(result.kind, "error", text);
  }
  assert.deepEqual(readDraft("20.555", gifts, 41_250), { kind: "error", message: "Use at most two decimal places, like 20.50." });
  assert.deepEqual(readDraft("0", gifts, 41_250), { kind: "error", message: "Type an amount greater than zero." });
  assert.deepEqual(readDraft("abc", gifts, 41_250), { kind: "error", message: `Type an amount like 20, or ${MINUS}20 to take money out.` });
});
