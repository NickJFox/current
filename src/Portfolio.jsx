import { useEffect, useState } from "react";

const money = (value) => value == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
const pct = (value) => value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
const time = (value) => value ? new Date(value).toLocaleString() : "Not yet";

function EquityChart({ history, capital, startedAt }) {
  if (!history.length) return <p className="portfolio-placeholder">The chart will build automatically after the first trading scan.</p>;
  const points = [{ at: startedAt || history[0].at, equity: capital, benchmark: capital }, ...history];
  const values = points.flatMap((p) => [p.equity, p.benchmark]).filter((v) => v != null);
  const min = Math.min(...values) * 0.998, max = Math.max(...values) * 1.002;
  const firstAt = Date.parse(points[0].at), lastAt = Date.parse(points.at(-1).at);
  const x = (i) => 30 + (Date.parse(points[i].at) - firstAt) / Math.max(1, lastAt - firstAt) * 840;
  const y = (value) => 190 - (value - min) / Math.max(1, max - min) * 160;
  const path = (field) => points.map((p, i) => p[field] == null ? null : `${x(i)},${y(p[field])}`).filter(Boolean).join(" ");
  return <figure className="equity-chart">
    <figcaption><span className="strategy-key">Momentum portfolio</span><span className="benchmark-key">SPY benchmark</span></figcaption>
    <svg viewBox="0 0 900 230" role="img" aria-label="Portfolio value compared with SPY over time">
      {[0, 1, 2].map((i) => <g key={i}><line x1="30" x2="870" y1={30 + i * 80} y2={30 + i * 80} stroke="#e3e8e2" /><text x="30" y={23 + i * 80} fill="#68716c" fontSize="11">{money(max - i / 2 * (max - min))}</text></g>)}
      <polyline points={path("benchmark")} fill="none" stroke="#8d80b5" strokeWidth="2.5" strokeDasharray="6 4" />
      <polyline points={path("equity")} fill="none" stroke="#087a43" strokeWidth="3" />
      <text x="30" y="222" fill="#68716c" fontSize="11">{new Date(points[0].at).toLocaleDateString()}</text>
      <text x="870" y="222" textAnchor="end" fill="#68716c" fontSize="11">{new Date(points.at(-1).at).toLocaleDateString()}</text>
    </svg>
  </figure>;
}

export default function Portfolio() {
  const [portfolio, setPortfolio] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/portfolio", { signal: controller.signal, cache: "no-store" });
        if (!(response.headers.get("content-type") || "").includes("application/json")) throw new Error("The portfolio API is missing from this deployment. Deploy the Netlify functions with the website.");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load the portfolio.");
        if (active) { setPortfolio(data); setError(null); }
      } catch (failure) { if (active && failure.name !== "AbortError") setError(failure.message); }
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => { active = false; clearInterval(interval); controller.abort(); };
  }, []);
  const m = portfolio?.metrics;
  const east = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const get = (type) => east.find((p) => p.type === type)?.value;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  const expected = !["Sat", "Sun"].includes(get("weekday")) && minutes >= 565 && minutes <= 970;
  const overdue = portfolio?.lastSuccessAt && Date.now() - Date.parse(portfolio.lastSuccessAt) > 180_000
    && (portfolio.status === "running" || (expected && portfolio.nextOpen && Date.now() >= Date.parse(portfolio.nextOpen)));
  const relative = m?.benchmarkReturnPercent == null ? null : m.returnPercent - m.benchmarkReturnPercent;
  return <section className="portfolio-section" id="performance" aria-labelledby="performance-title">
    <div className="feed-head"><div><p className="section-label">Automated paper trading</p><h2 id="performance-title">Test momentum against the market.</h2></div><p>Simulated money. Real signals. Updates automatically.</p></div>
    {error && <div className="portfolio-status attention" role="alert">{error} Retrying automatically.</div>}
    {!portfolio && !error && <div className="loading-state" role="status">Loading portfolio performance…</div>}
    {portfolio && <>
      <div className={`portfolio-status ${["attention", "setup_required"].includes(portfolio.status) ? "attention" : ""}`}>
        <strong>{({ running: "Automation running", market_closed: "Waiting for next session", setup_required: "Activation required", attention: "Automation needs attention", waiting: "Starting up" })[portfolio.status] || portfolio.status}</strong>
        <span>{portfolio.message}</span>
        {portfolio.lastError && <span role="alert">{portfolio.lastError}</span>}
        <small>Last successful check: {time(portfolio.lastSuccessAt)} · Next market open: {time(portfolio.nextOpen)}</small>
        {overdue && <strong role="alert">Worker heartbeat is overdue. Values may be stale.</strong>}
      </div>
      <div className="portfolio-stats">
        {[
          ["Portfolio value", money(m.equity), `${money(portfolio.capital)} starting capital`],
          ["Total profit / loss", money(m.profit), `${money(m.realizedProfit)} realized · ${money(m.unrealizedProfit)} unrealized`],
          ["Lifetime portfolio return", pct(m.returnPercent), "Includes earlier strategy versions"],
          ["Lifetime SPY return", pct(m.benchmarkReturnPercent), relative == null ? "Starts with the first trading scan" : `${relative >= 0 ? "+" : ""}${relative.toFixed(2)} percentage points vs SPY`],
          ["Available cash", money(m.cash), `${m.positions} open positions`],
          ["Maximum drawdown", `${m.maxDrawdownPercent.toFixed(2)}%`, "From observed portfolio peaks"],
        ].map(([label, value, detail]) => <article className="portfolio-stat" key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>)}
      </div>
      <div className="portfolio-panel"><h3>All-day strategy vs. SPY</h3>
        {portfolio.intradayExperiment ? <>
          <p>Strategy return <strong>{pct(m.intradayReturnPercent)}</strong> · SPY return <strong>{pct(m.intradayBenchmarkReturnPercent)}</strong> · Difference <strong>{m.intradayExcessReturnPercent == null ? "—" : `${m.intradayExcessReturnPercent >= 0 ? "+" : ""}${m.intradayExcessReturnPercent.toFixed(2)} percentage points`}</strong></p>
          <small>Since {time(portfolio.intradayExperiment.startedAt)}. Both start with {money(portfolio.intradayExperiment.startEquity)}. Existing positions carry into this period. SPY is a price-return proxy for the S&amp;P 500. Paper results do not establish future profitability.</small>
        </> : <p>Starts automatically with the first eligible all-day scan.</p>}
      </div>
      <div className="portfolio-panel"><h3>Portfolio vs. S&P 500 proxy</h3><EquityChart history={portfolio.history} capital={portfolio.capital} startedAt={portfolio.startedAt} />{portfolio.benchmark && <small>SPY quote as of {time(portfolio.benchmark.updatedAt)}</small>}{portfolio.benchmarkError && <p role="alert">Benchmark update delayed: {portfolio.benchmarkError}</p>}</div>
      <div className="portfolio-panel"><h3>Open positions</h3>
        <div className="portfolio-table-wrap"><table><thead><tr><th>Stock</th><th>Shares</th><th>Entry</th><th>Latest</th><th>Trailing stop</th><th>Unrealized P/L</th></tr></thead><tbody>
          {portfolio.positions.map((p) => <tr key={p.symbol}><td><strong>{p.symbol}</strong></td><td>{p.qty}</td><td>{money(Number(p.avg_entry_price))}</td><td>{money(Number(p.current_price))}</td><td>{p.stop ? money(Number(p.stop)) : "Attaching / updating"}</td><td>{money(Number(p.unrealized_pl))}</td></tr>)}
          {!portfolio.positions.length && <tr><td colSpan="6">No open positions. Eligible purchases happen automatically during intraday scans when simulated cash is available.</td></tr>}
        </tbody></table></div>
      </div>
      <div className="portfolio-panel"><h3>Recent orders</h3><div className="portfolio-table-wrap"><table><thead><tr><th>Stock</th><th>Action</th><th>Filled shares</th><th>Fill price</th><th>Status</th><th>Time</th></tr></thead><tbody>
        {portfolio.orders.map((o) => <tr key={o.client_order_id}><td><strong>{o.symbol}</strong></td><td>{o.side === "buy" ? "Buy" : o.type === "trailing_stop" ? "Trailing exit" : "Protective exit"}</td><td>{o.filled_qty || "0"} / {o.qty}</td><td>{o.filled_avg_price ? money(Number(o.filled_avg_price)) : "—"}</td><td>{o.status.replaceAll("_", " ")}</td><td>{time(o.filled_at || o.created_at)}</td></tr>)}
        {!portfolio.orders.length && <tr><td colSpan="6">Orders and fills will appear here after activation.</td></tr>}
      </tbody></table></div></div>
      <div className="portfolio-panel"><h3>Momentum scan history</h3>
        {!portfolio.days.length && <p className="portfolio-placeholder">Each trading day’s momentum list and purchase decisions will be saved here.</p>}
        {portfolio.days.map((run) => <details className="scan-history" key={run.day}><summary>{run.day} · {Object.keys(run.scans || {}).length ? `${Object.keys(run.scans).length} intraday scans · ${run.complete ? "Complete" : "In progress"}` : run.missed ? "Missed entry window" : `${run.signals.length} signals · ${run.complete ? "Complete" : "In progress"}`}</summary>
          {run.reason && <p>Earlier morning strategy: {run.reason}</p>}
          <ul>{run.signals.map((signal) => <li key={signal.ticker}><strong>{signal.ticker}</strong> · #{signal.rank} · {signal.relativeVolume?.toFixed(1)}× volume · {run.decisions[signal.ticker]?.reason || run.decisions[signal.ticker]?.status || "Pending"}</li>)}</ul>
          {Object.entries(run.scans || {}).sort(([a], [b]) => Number(b) - Number(a)).map(([slot, scan]) => <details className="scan-history" key={slot}>
            <summary>{time(scan.scannedAt)} · {scan.signals.length} signals · {scan.complete ? "Complete" : "In progress"}</summary>
            {scan.source && <p>{scan.source}. {scan.universe}</p>}
            <ul>{scan.signals.map((signal) => <li key={signal.ticker}><strong>{signal.ticker}</strong> · #{signal.rank} · {signal.relativeVolume?.toFixed(1)}× volume · {scan.decisions[signal.ticker]?.reason || scan.decisions[signal.ticker]?.status || "Pending"}</li>)}</ul>
          </details>)}
        </details>)}
      </div>
      <p className="portfolio-methodology">{portfolio.methodology} Starts {time(portfolio.startedAt)}. Stop orders may execute below their trigger price after a gap. Whole-share sizing or unsupported symbols may leave some signals unpurchased.</p>
    </>}
  </section>;
}
