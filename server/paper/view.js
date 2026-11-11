import { summarize } from "./engine.js";

export function portfolioView(state, { status = state.status, message = state.message,
  workerRunning = false, lastError = null } = {}) {
  return {
    status, message,
    workerRunning, lastRunAt: state.lastRunAt, lastSuccessAt: state.lastSuccessAt,
    lastError: lastError || state.lastError, startedAt: state.startedAt, nextOpen: state.nextOpen || null,
    capital: state.capital, trailPercent: state.trailPercent, metrics: summarize(state),
    positions: state.positions.map((p) => ({ ...p, stop: state.orders.findLast((o) => o.symbol === p.symbol && o.side === "sell" && !["filled", "canceled", "expired", "rejected", "replaced"].includes(o.status))?.stop_price || null })),
    orders: state.orders.slice(-100).reverse().map(({ id, ...o }) => o),
    days: Object.entries(state.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 30).map(([day, details]) => ({ day, ...details })),
    history: state.snapshots, benchmark: state.benchmark, benchmarkError: state.benchmarkError || null,
    methodology: "One morning scan at 9:45 ET; retries until 9:55. Whole-share, cash-only capped limit entries. 3% broker-hosted GTC trailing stops in regular hours, attached after fill reconciliation (up to a scheduled minute later; longer during outages). SPY price-return proxy, same capital and start time. Dividends and additional transaction costs excluded. IEX quotes by default. Paper fills are simulations.",
  };
}
