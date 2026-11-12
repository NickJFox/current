import { summarize } from "./engine.js";

export function portfolioView(state, { status = state.status, message = state.message,
  workerRunning = false, lastError = null } = {}) {
  return {
    status, message,
    workerRunning, lastRunAt: state.lastRunAt, lastSuccessAt: state.lastSuccessAt,
    strategyVersion: state.strategyVersion || 1, intradayExperiment: state.intradayExperiment || null,
    lastError: lastError || state.lastError, startedAt: state.startedAt, nextOpen: state.nextOpen || null,
    capital: state.capital, trailPercent: state.trailPercent, metrics: summarize(state),
    positions: state.positions.map((p) => ({ ...p, stop: state.orders.findLast((o) => o.symbol === p.symbol && o.side === "sell" && !["filled", "canceled", "expired", "rejected", "replaced"].includes(o.status))?.stop_price || null })),
    orders: state.orders.slice(-100).reverse().map(({ id, ...o }) => o),
    days: Object.entries(state.days).sort(([a], [b]) => b.localeCompare(a)).slice(0, 30).map(([day, details]) => ({ day, ...details })),
    history: state.snapshots, benchmark: state.benchmark, benchmarkError: state.benchmarkError || null,
    methodology: "Momentum scans every five minutes from 15 minutes after the regular open until 10 minutes before the exchange closes (normally 9:45–15:50 ET). One entry attempt per symbol per trading day; no adding to existing holdings. Whole-share, cash-only capped limit entries; unfilled entries canceled after their five-minute scan window. Stop proceeds are eligible at the next scan. 3% broker-hosted GTC trailing stops in regular hours, attached after fill reconciliation (up to a scheduled minute later; longer during outages). Positions may remain open overnight. SPY is an S&P 500 price-return proxy. The all-day comparison uses the sleeve equity and SPY price at strategy activation; lifetime results retain earlier history. Dividends and additional transaction costs excluded. IEX quotes by default. Paper fills are simulations.",
  };
}
