import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMoney, parseMoney } from "../src/core/money.js";

test("parseMoney reads dollar text as integer cents", () => {
  for (const [text, cents] of [
    ["0", 0], ["5", 500], ["$5", 500], ["5.5", 550], ["5.05", 505], ["0.07", 7], ["1,234.56", 123_456], ["$1,234,567.89", 123_456_789],
    ["1234567", 123_456_700], ["-412.09", -41_209], ["−412.09", -41_209], ["+8.10", 810], ["-$412.09", -41_209], ["−$1,000", -100_000],
    ["  42.00 \n", 4200], ["-0", 0], ["-0.00", 0], ["999999999.99", 99_999_999_999],
  ] as const) {
    assert.equal(parseMoney(text), cents, text);
    assert.ok(!Object.is(parseMoney(text), -0), `${text} is not negative zero`);
  }
});

test("parseMoney rejects malformed amounts with invalid_input", () => {
  for (const text of ["", " ", "abc", "$", "-", "1.234", "1.", ".5", "1,23", "12,34.00", "1,2345", ",123", "1,,234", "--5", "$-5", "5$", "1e3", "0x10", "1 000", "- 5", "1.2.3", "NaN", "Infinity", "99999999999999999999"]) {
    assert.throws(() => parseMoney(text), { name: "BudgetError", code: "invalid_input" }, JSON.stringify(text));
  }
  assert.throws(() => parseMoney(undefined as unknown as string), { code: "invalid_input" });
});

test("formatMoney groups thousands, pads cents, and uses U+2212 for negatives", () => {
  for (const [cents, text, withSymbol] of [
    [0, "0.00", "$0.00"], [5, "0.05", "$0.05"], [100, "1.00", "$1.00"], [246_335, "2,463.35", "$2,463.35"], [814_126, "8,141.26", "$8,141.26"],
    [-41_209, "−412.09", "−$412.09"], [-5, "−0.05", "−$0.05"], [100_000_000, "1,000,000.00", "$1,000,000.00"],
    [99_999_999_999, "999,999,999.99", "$999,999,999.99"], [-0, "0.00", "$0.00"],
  ] as const) {
    assert.equal(formatMoney(cents), text);
    assert.equal(formatMoney(cents, { symbol: true }), withSymbol);
    assert.equal(formatMoney(cents, { symbol: false }), text);
  }
  for (const bad of [1.5, Number.NaN, Infinity, 2 ** 60]) assert.throws(() => formatMoney(bad), { code: "invalid_input" });
});

test("format and parse round-trip", () => {
  for (const cents of [0, 1, -1, 99, 100, 123_456, -123_456, 99_999_999_999, -99_999_999_999]) {
    assert.equal(parseMoney(formatMoney(cents)), cents);
    assert.equal(parseMoney(formatMoney(cents, { symbol: true })), cents);
  }
});
