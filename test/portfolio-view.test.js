import test from "node:test";
import assert from "node:assert/strict";
import { portfolioView } from "../server/paper/view.js";
import { emptyState } from "../server/paper/store.js";

test("legacy performance is withheld while the broker reset is pending", () => {
  const state = { ...emptyState(), strategyVersion: 2, status: "running", capital: 10000,
    accountMark: { equity: 99687.57, cash: 96143.71 }, accountBaseline: { equity: 100000, cash: 100000 },
    positions: [{ symbol: "OLD", market_value: 3543.86 }],
    orders: [{ client_order_id: "old", status: "filled" }],
    days: { old: { signals: [], decisions: {} } }, snapshots: [{ equity: 9687.57 }],
    benchmark: { entryPrice: 100, lastPrice: 99 } };
  const original = structuredClone(state);
  const view = portfolioView(state);
  assert.equal(view.status, "resetting");
  assert.equal(view.reset.pending, true);
  assert.equal(view.reset.remainingPositions, 1);
  assert.equal(view.metrics, null);
  assert.deepEqual(view.positions, []);
  assert.deepEqual(view.orders, []);
  assert.deepEqual(view.days, []);
  assert.deepEqual(view.history, []);
  assert.equal(view.benchmark, null);
  assert.equal(view.intradayExperiment, null);
  assert.equal(view.startedAt, null);
  assert.deepEqual(state, original); // Public reads must never delete broker reconciliation data.
});

test("reset errors and disabled-worker messages remain visible", () => {
  const state = { ...emptyState(), strategyVersion: 2, lastError: "Exit pending" };
  const view = portfolioView(state, { status: "attention", message: "Reset paused" });
  assert.equal(view.status, "attention");
  assert.equal(view.message, "Reset paused");
  assert.equal(view.lastError, "Exit pending");
  assert.equal(view.metrics, null);
});

test("new strategy displays real metrics after reset", () => {
  const state = emptyState();
  const view = portfolioView(state);
  assert.equal(view.reset, null);
  assert.equal(view.strategyVersion, 3);
  assert.equal(view.metrics.equity, 10000);
  assert.equal(view.metrics.profit, 0);
});
