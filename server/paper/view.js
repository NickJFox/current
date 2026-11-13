import { emptyState } from "./store.js";
import { STRATEGY_VERSION } from "./strategy.js";
import { summarize } from "./engine.js";

export function portfolioView(state, { status = state.status, message = state.message,
  workerRunning = false, lastError = null } = {}) {
  const pending = state.strategyVersion !== STRATEGY_VERSION || Boolean(state.strategyReset);
  const reset = pending ? { pending: true, previousStrategyVersion: state.strategyVersion || 1,
    startedAt: state.strategyReset?.startedAt || null,
    remainingPositions: state.positions.length,
    remainingOrders: state.orders.filter((o) => !["filled", "canceled", "expired", "rejected", "replaced"].includes(o.status)).length } : null;
  const previousVersion = state.strategyVersion || 1;
  if (pending) {
    if (!["attention", "setup_required", "resetting"].includes(status)) {
      status = "resetting";
      message = "Waiting for the automated worker to clear the previous portfolio before starting the new $10,000 strategy.";
    }
    // Withhold legacy performance rather than relabeling it or inventing a
    // successful reset. The worker alone reconciles and replaces the ledger.
    state = { ...emptyState(), lastRunAt: state.lastRunAt, lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError, nextOpen: state.nextOpen };
  }
  return {
    status, message, reset,

    workerRunning, lastRunAt: state.lastRunAt, lastSuccessAt: state.lastSuccessAt,
    strategyVersion: pending ? previousVersion : state.strategyVersion || 1, intradayExperiment: state.intradayExperiment || null,
    lastError: lastError || state.lastError, startedAt: state.startedAt, nextOpen: state.nextOpen || null,
    capital: state.capital, trailPercent: state.trailPercent, metrics: pending ? null : summarize(state),
    positions: state.positions.map((p) => ({ ...p, stop: state.orders.findLast((o) => o.symbol === p.symbol && o.side === "sell" && !["filled", "canceled", "expired", "rejected", "replaced"].includes(o.status))?.stop_price || null })),
    orders: state.orders.slice(-100).reverse().map(({ id, ...o }) => o),
    days: Object.entries(state.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 30).map(([day, details]) => ({ day, ...details })),
    history: state.snapshots, benchmark: state.benchmark, benchmarkError: state.benchmarkError || null,
    methodology: "Live momentum strategy (v3). Same scanner as Happening now: latest five completed minutes versus the preceding 20 minutes; ≥2× volume acceleration, ≥0.5% five-minute gain, non-falling last minute, price ≥$2 and ≥$50K recent turnover. Checks approximately every 30 seconds while the worker is active. Entries only during regular hours, ending 10 minutes before exchange close; pre/post-market scanner signals are not traded. One entry attempt per symbol per day, no adding to holdings. Cash-only whole-share limit entries capped 0.5% above a fresh ask; unfilled entries canceled after their 30-second scan window. 3% broker-hosted GTC trailing stops attached after fill reconciliation; stops trigger only during regular hours. Positions can remain overnight. Fresh $10,000 strategy baseline after old holdings and orders are cleared; earlier strategy history is removed. SPY comparison starts with the new strategy. IEX represents one exchange; discovery is limited to most-active and top-gainer lists. Dividends and additional transaction costs excluded. Paper fills are simulations.",
  };
}
