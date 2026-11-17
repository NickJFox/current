import test from "node:test";
import assert from "node:assert/strict";
import { parseNumber, regularSessionProgress } from "../server/market-data.js";

test("parseNumber handles market-data formats", () => {
  assert.equal(parseNumber("$1,234.50"), 1234.5);
  assert.equal(parseNumber("2.5M"), 2_500_000);
  assert.equal(parseNumber("3.2%"), 3.2);
  assert.equal(parseNumber("N/A"), 0);
});
test("regularSessionProgress returns one outside the regular session", () => {
  assert.equal(regularSessionProgress(new Date("2026-07-25T16:00:00Z")), 1);
  assert.equal(regularSessionProgress(new Date("2026-07-23T12:00:00Z")), 1);
});

test("regularSessionProgress adjusts during the regular session", () => {
  const halfway = regularSessionProgress(new Date("2026-07-23T16:45:00Z"));
  assert.ok(Math.abs(halfway - 0.5) < 0.001);
});
