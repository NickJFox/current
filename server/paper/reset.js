import { randomUUID } from "node:crypto";
import { emptyState } from "./store.js";
import { STRATEGY_VERSION } from "./strategy.js";

const terminal = new Set(["filled", "canceled", "expired", "rejected", "replaced"]);

// Called only by the single ledger writer. Keep the old ledger until all broker
// exposure is resolved; deleting it first would orphan positions and stops.
export async function resetLegacyPortfolio(engine, clock, account, positions, openOrders) {
  const old = engine.state;
  if (old.strategyVersion === STRATEGY_VERSION && !old.strategyReset) return true;
  if (old.accountId && old.accountId !== account.id) throw new Error("Paper account changed; strategy reset stopped.");
  const known = new Set(Object.keys(old.intents));
  if (openOrders.some((o) => !known.has(o.client_order_id))) throw new Error("Unexpected open order; strategy reset stopped.");
  const owned = new Set(Object.values(old.intents).filter((i) => i.body.side === "buy").map((i) => i.body.symbol));
  if (positions.some((p) => !owned.has(p.symbol) || Number(p.qty) <= 0)) {
    throw new Error("Unexpected paper position; strategy reset stopped.");
  }
  old.strategyReset ||= { runId: randomUUID().slice(0, 8), startedAt: engine.now().toISOString(), exits: {} };
  old.status = "resetting";
  old.message = "Resetting for the live momentum strategy. No new entries until old orders and holdings are cleared.";
  await engine.save();
  if ((positions.length || openOrders.length) && !clock.is_open) {
    old.message = "Waiting for regular market hours to close the previous paper portfolio and restart. Existing stops remain in place.";
    await engine.save(); return false;
  }
  // Reconcile uncertain legacy submissions before canceling any still-open order.
  for (const id of known) {
    const order = await engine.provider.order(id);
    if (order) engine.record(order);
  }
  await engine.save();
  const resetIds = new Set(Object.values(old.strategyReset.exits));
  for (const order of await engine.provider.openOrders()) {
    if (!known.has(order.client_order_id)) throw new Error("Unexpected order during strategy reset.");
    if (resetIds.has(order.client_order_id)) continue;
    try { await engine.provider.cancel(order.id); }
    catch (error) { if (![404, 422].includes(error.status)) throw error; }
  }
  const remaining = await engine.provider.openOrders();
  if (remaining.some((o) => !resetIds.has(o.client_order_id))) return false;
  // Wait for cancellation acknowledgements, including orders not yet visible in
  // the open-order list. An ambiguous buy must not appear after the reset.
  for (const id of known) {
    if (resetIds.has(id)) continue;
    const order = await engine.provider.order(id);
    if (order) engine.record(order);
    if (order && !terminal.has(order.status)) { await engine.save(); return false; }
    if (!order && !old.orders.some((o) => o.client_order_id === id && terminal.has(o.status))) {
      throw new Error("Unresolved previous order; strategy reset will retry before clearing history.");
    }
  }
  positions = await engine.provider.positions();
  if (positions.some((p) => !owned.has(p.symbol) || Number(p.qty) <= 0)) throw new Error("Unexpected position during strategy reset.");
  for (const p of positions) {
    let id = old.strategyReset.exits[p.symbol];
    if (id) {
      const previous = await engine.provider.order(id);
      if (previous) {
        engine.record(previous);
        if (!["canceled", "expired", "rejected"].includes(previous.status)) continue;
      }
      // Definitively terminal unfilled/partial exits may be retried for the
      // broker's remaining quantity; ambiguous exits retain the original ID.
      if (previous) id = null;
    }
    if (!id) {
      id = `cm-reset-${old.strategyReset.runId}-${p.symbol}-${Object.keys(old.intents).length}`;
      old.strategyReset.exits[p.symbol] = id;
      await engine.save();
    }
    await engine.place(id, { client_order_id: id, symbol: p.symbol, qty: String(p.qty),
      side: "sell", type: "market", time_in_force: "day" });
  }
  if ((await engine.provider.positions()).length || (await engine.provider.openOrders()).length) {
    await engine.save(); return false;
  }
  // Confirm exit terminal states before erasing durable reconciliation data.
  for (const id of Object.values(old.strategyReset.exits)) {
    const order = await engine.provider.order(id);
    if (!order || !terminal.has(order.status)) return false;
  }
  const freshAccount = await engine.provider.account();
  if (freshAccount.id !== account.id) throw new Error("Paper account changed during reset.");
  if (Number(freshAccount.long_market_value || 0) !== 0 || Number(freshAccount.short_market_value || 0) !== 0) return false;
  if (!Number.isFinite(Number(freshAccount.cash)) || !Number.isFinite(Number(freshAccount.equity || freshAccount.cash))) {
    throw new Error("Fresh account valuation unavailable after reset.");
  }
  if (Number(freshAccount.cash) < 10000) throw new Error("At least $10,000 in simulated cash is required after reset.");
  engine.state = { ...emptyState(), runId: old.strategyReset.runId,
    resetAt: engine.now().toISOString(), accountId: account.id,
    accountBaseline: { equity: Number(freshAccount.equity || freshAccount.cash), cash: Number(freshAccount.cash) } };
  await engine.save();
  return false; // Begin the fresh experiment on the next cycle, using a new account mark.
}
