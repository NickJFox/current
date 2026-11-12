import test from "node:test";
import assert from "node:assert/strict";
import { parseNumber, regularSessionProgress, historicalAverageVolume } from "../server/market-data.js";

test("historical average excludes the current session and requires sufficient history", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ date: `10/${index + 1}/2026`, volume: "1,000" }));
  rows.push({ date: "11/12/2026", volume: "900,000" }, { date: "invalid", volume: "5,000" });
  assert.equal(historicalAverageVolume(rows, "2026-11-12"), 1000);
  assert.equal(historicalAverageVolume(rows.slice(0, 9), "2026-11-12"), 0);
});

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

test("opening volume pace uses elapsed minutes rather than a 10% floor", () => {
  assert.equal(regularSessionProgress(new Date("2026-11-11T14:30:00Z")), 1 / 390);
  assert.equal(regularSessionProgress(new Date("2026-11-11T14:45:00Z")), 15 / 390);
});
