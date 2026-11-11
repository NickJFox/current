const TERMINAL = new Set(["filled", "canceled", "expired", "rejected", "replaced"]);
const number = (value) => Number(value) || 0;
const minute = (time) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };

export function easternTime(date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function summarize(state) {
  let cash = state.capital;
  for (const order of [...state.orders].sort((a, b) => String(a.filled_at || a.created_at).localeCompare(String(b.filled_at || b.created_at)))) {
    const qty = number(order.filled_qty), price = number(order.filled_avg_price);
    if (!qty || !price) continue;
    cash += (order.side === "buy" ? -1 : 1) * qty * price;
  }
  const marketValue = state.positions.reduce((sum, p) => sum + number(p.market_value), 0);
  const equity = state.accountMark && state.accountBaseline
    ? state.capital + state.accountMark.equity - state.accountBaseline.equity : cash + marketValue;
  if (state.accountMark && state.accountBaseline) cash = state.accountMark.cash - state.accountBaseline.cash + state.capital;
  const profit = equity - state.capital;
  const unrealized = state.positions.reduce((sum, p) => sum + number(p.unrealized_pl), 0);
  const realized = profit - unrealized;
  let peak = state.capital, drawdown = state.maxDrawdownPercent || 0;
  for (const point of state.snapshots) {
    peak = Math.max(peak, point.equity);
    drawdown = Math.max(drawdown, (peak - point.equity) / peak * 100);
  }
  peak = Math.max(peak, state.equityPeak || state.capital, equity);
  drawdown = Math.max(drawdown, (peak - equity) / peak * 100);
  const benchmarkValue = state.benchmark ? state.capital * state.benchmark.lastPrice / state.benchmark.entryPrice : null;
  return { cash, equity, profit, realizedProfit: realized, unrealizedProfit: unrealized,
    returnPercent: profit / state.capital * 100, benchmarkValue,
    benchmarkReturnPercent: benchmarkValue === null ? null : (benchmarkValue / state.capital - 1) * 100,
    maxDrawdownPercent: drawdown, positions: state.positions.length,
    filledOrders: state.orders.filter((o) => number(o.filled_qty) > 0).length };
}

function publicOrder(order) {
  return Object.fromEntries(["id", "client_order_id", "symbol", "side", "type", "status", "qty", "filled_qty",
    "filled_avg_price", "filled_at", "created_at", "stop_price", "hwm", "trail_percent"].map((key) => [key, order[key] ?? null]));
}

export class PaperEngine {
  constructor({ store, provider, scanner, now = () => new Date(), enabled = true }) {
    Object.assign(this, { store, provider, scanner, now, enabled });
    this.busy = false;
    this.calendarCache = null;
  }
  async save() { await this.store.write(this.state); }
  record(order) {
    const safe = publicOrder(order);
    const index = this.state.orders.findIndex((o) => o.client_order_id === order.client_order_id);
    if (index < 0) this.state.orders.push(safe); else this.state.orders[index] = safe;
  }
  async place(key, body) {
    // Persist the intent BEFORE sending. A timeout/crash is recovered by client ID,
    // never by sending a new order ID. Broker rejects duplicate client IDs.
    if (!this.state.intents[key]) {
      this.state.intents[key] = { body, createdAt: this.now().toISOString() };
      await this.save();
    }
    const intent = this.state.intents[key];
    let order = await this.provider.order(key);
    if (!order) {
      try { order = await this.provider.submit(intent.body); }
      catch (error) {
        if (![403, 422].includes(error.status)) throw error;
        order = await this.provider.order(key);
        if (!order) throw error;
      }
    }
    this.record(order);
    await this.save();
    return order;
  }
  async syncOrders() {
    for (const [id, intent] of Object.entries(this.state.intents)) {
      const old = this.state.orders.find((o) => o.client_order_id === id);
      if (old && TERMINAL.has(old.status)) continue;
      const order = await this.provider.order(id);
      if (order) this.record(order);
      // Only protective exits are retried outside the morning window below.
      // An uncertain buy is looked up again; it is not recreated hours later.
      else if (intent.body.side === "sell") await this.place(id, intent.body);
    }
    await this.save();
  }
  async protect(positions) {
    for (const position of positions) {
      const buys = this.state.orders.filter((o) => o.symbol === position.symbol && o.side === "buy");
      if (!buys.length || number(position.qty) <= 0) throw new Error("Unexpected paper-account position. Use a dedicated paper account.");
      // Cancel the remainder of a partially filled entry before protecting its filled shares.
      for (const buy of buys.filter((o) => !TERMINAL.has(o.status))) {
        try { await this.provider.cancel(buy.id); }
        catch (error) { if (![404, 422].includes(error.status)) throw error; }
        const refreshed = await this.provider.order(buy.client_order_id);
        if (refreshed) this.record(refreshed);
      }
      if (this.state.orders.some((o) => o.symbol === position.symbol && o.side === "buy" && !TERMINAL.has(o.status))) {
        throw new Error(`Waiting for ${position.symbol} entry cancellation before attaching its stop.`);
      }
      const exits = this.state.orders.filter((o) => o.symbol === position.symbol && o.side === "sell" && !TERMINAL.has(o.status));
      if (exits.length) continue;
      // Each exit attempt is durable and deterministic, including replacements after expiry.
      const latest = (await this.provider.positions()).find((p) => p.symbol === position.symbol);
      if (!latest || number(latest.qty) <= 0) continue;
      const count = this.state.orders.filter((o) => o.symbol === position.symbol && o.side === "sell").length;
      const id = `cm-stop-${position.symbol}-${count}`;
      const lastExit = this.state.orders.filter((o) => o.symbol === position.symbol && o.side === "sell").at(-1);
      const emergency = lastExit?.status === "rejected";
      try {
        const order = await this.place(id, { client_order_id: id, symbol: position.symbol,
          qty: String(latest.qty), side: "sell", type: emergency ? "market" : "trailing_stop",
          time_in_force: emergency ? "day" : "gtc", ...(emergency ? {} : { trail_percent: String(this.state.trailPercent) }) });
        if (order.status === "rejected") throw new Error(`Protective order rejected for ${position.symbol}; automatic exit will be attempted next cycle.`);
      } catch (error) {
        // Definitive validation rejection: record it, so next cycle uses a market exit.
        if (error.status === 422 || error.status === 403) {
          this.record({ ...this.state.intents[id].body, status: "rejected", created_at: this.now().toISOString() });
          await this.save();
        }
        throw error;
      }
    }
    await this.save();
  }
  async benchmark() {
    const quote = await this.provider.quote("SPY");
    const price = number(quote?.bp);
    if (!price || !this.fresh(quote?.t)) throw new Error("Fresh SPY benchmark data is unavailable.");
    if (!this.state.benchmark) this.state.benchmark = { entryPrice: price, startedAt: quote.t };
    this.state.benchmark.lastPrice = price;
    this.state.benchmark.updatedAt = quote.t;
    this.state.benchmarkError = null;
  }
  fresh(timestamp) {
    const age = this.now().getTime() - Date.parse(timestamp);
    return Number.isFinite(age) && age >= -5_000 && age <= 90_000;
  }
  async scan(day, account, target) {
    let run = this.state.days[day];
    if (!run) {
      const signal = await this.scanner();
      if (signal.stale || !this.fresh(signal.updatedAt)) throw new Error("Fresh momentum scan unavailable; morning scan will retry.");
      const companies = signal.companies.filter((c) => /^[A-Z0-9.-]{1,10}$/.test(c.ticker));
      run = { scannedAt: this.now().toISOString(), sourceAt: signal.updatedAt,
        signals: companies.map((c, index) => ({ ticker: c.ticker, rank: index + 1, price: c.price, relativeVolume: c.relativeVolume })),
        decisions: {}, complete: false };
      const strategyCash = this.state.accountBaseline ? number(account.cash) - this.state.accountBaseline.cash + this.state.capital : summarize(this.state).cash;
      const available = Math.max(0, Math.min(strategyCash, number(account.cash)));
      const candidates = run.signals.filter((c) => !this.state.positions.some((p) => p.symbol === c.ticker));
      run.perStock = candidates.length ? available * 0.98 / candidates.length : 0;
      this.state.days[day] = run;
      await this.save();
    }
    if (run.complete) return;
    for (const signal of run.signals) {
      const symbol = signal.ticker;
      if (run.decisions[symbol]) continue;
      const observed = easternTime(this.now());
      if (observed.day !== day || observed.minute >= target + 10 || observed.minute < target) {
        run.decisions[symbol] = { status: "skipped", reason: "Morning entry window ended" };
        await this.save(); continue;
      }
      const id = `cm-buy-${day}-${symbol}`;
      // Recover an already persisted intent even if the process stopped before the broker response.
      if (this.state.intents[id]) {
        const recovered = await this.place(id, this.state.intents[id].body);
        run.decisions[symbol] = { status: recovered.status === "rejected" ? "rejected" : "submitted", orderId: id };
        await this.save(); continue;
      }
      if (this.state.positions.some((p) => p.symbol === symbol)) {
        run.decisions[symbol] = { status: "skipped", reason: "Already held" }; await this.save(); continue;
      }
      let asset;
      try { asset = await this.provider.asset(symbol); }
      catch (error) {
        if (error.status !== 404) throw error;
        run.decisions[symbol] = { status: "skipped", reason: "Symbol unavailable in paper account" };
        await this.save(); continue;
      }
      if (!asset.tradable || asset.status !== "active") {
        run.decisions[symbol] = { status: "skipped", reason: "Not tradable in the paper account" }; await this.save(); continue;
      }
      const quote = await this.provider.quote(symbol);
      if (!number(quote?.ap) || !this.fresh(quote?.t)) {
        run.decisions[symbol] = { status: "skipped", reason: "No fresh executable quote" }; await this.save(); continue;
      }
      // Whole shares support broker-hosted trailing stops. A capped limit order bounds
      // spending even if price jumps; leftover cash stays idle until tomorrow.
      const limit = Math.ceil(number(quote.ap) * 1.005 * 100) / 100;
      const qty = Math.floor(run.perStock / limit);
      if (qty < 1) {
        run.decisions[symbol] = { status: "skipped", reason: "Insufficient cash for one share" }; await this.save(); continue;
      }
      const beforeSubmit = easternTime(this.now());
      if (beforeSubmit.day !== day || beforeSubmit.minute >= target + 10) {
        run.decisions[symbol] = { status: "skipped", reason: "Morning entry window ended" };
        await this.save(); continue;
      }
      try {
        const order = await this.place(id, { client_order_id: id, symbol, qty: String(qty), side: "buy",
          type: "limit", limit_price: limit.toFixed(2), time_in_force: "day" });
        run.decisions[symbol] = { status: order.status === "rejected" ? "rejected" : "submitted", orderId: id };
      } catch (error) {
        if (![403, 422].includes(error.status)) throw error;
        // Don't classify ambiguous network errors as rejections. They are reconciled by ID.
        const recovered = await this.provider.order(id);
        if (recovered) this.record(recovered);
        else this.record({ ...this.state.intents[id].body, status: "rejected", created_at: this.now().toISOString() });
        run.decisions[symbol] = { status: recovered ? "submitted" : "rejected", reason: recovered ? undefined : error.message, orderId: id };
      }
      await this.save();
    }
    run.complete = true;
    await this.save();
  }
  async cancelLateEntries() {
    for (const order of this.state.orders.filter((o) => o.side === "buy" && !TERMINAL.has(o.status))) {
      try { await this.provider.cancel(order.id); }
      catch (error) { if (![404, 422].includes(error.status)) throw error; }
    }
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.state = await this.store.read();
      this.state.lastRunAt = this.now().toISOString();
      if (!this.enabled || !this.provider.configured) {
        this.state.status = "setup_required";
        this.state.message = !this.enabled ? "Automatic paper trading is disabled on this server."
          : "Connect Alpaca paper API credentials on the server to activate automation.";
        await this.save(); return;
      }
      const clock = await this.provider.clock();
      if (!this.fresh(clock.timestamp)) throw new Error("Paper-provider clock is stale; no orders submitted.");
      const { day, minute: current } = easternTime(new Date(clock.timestamp));
      if (!this.calendarCache || this.calendarCache.day !== day) {
        this.calendarCache = { day, sessions: await this.provider.calendar(day) };
      }
      const session = this.calendarCache.sessions[0];
      const [account, initialPositions, openOrders] = await Promise.all([
        this.provider.account(), this.provider.positions(), this.provider.openOrders(),
      ]);
      if (!this.state.accountId) {
        if (initialPositions.length || openOrders.length) throw new Error("Start with a dedicated paper account with no positions or open orders. Existing holdings will not be changed.");
        if (number(account.cash) < this.state.capital) throw new Error("The paper account needs at least $10,000 in simulated cash.");
        this.state.accountId = account.id;
        this.state.accountBaseline = { equity: number(account.equity || account.cash), cash: number(account.cash) };
        await this.save();
      }
      if (account.id !== this.state.accountId) throw new Error("Paper account changed. Restore the original paper-account credentials.");
      if (account.trading_blocked || account.account_blocked) throw new Error("Paper account is blocked by the provider.");
      const knownIds = new Set(Object.keys(this.state.intents));
      if (openOrders.some((o) => !knownIds.has(o.client_order_id))) throw new Error("Unexpected open order. This automation requires a dedicated paper account.");
      await this.syncOrders();
      const positions = await this.provider.positions();
      this.state.positions = positions.map((p) => ({ symbol: p.symbol, qty: p.qty, avg_entry_price: p.avg_entry_price,
        current_price: p.current_price, market_value: p.market_value, unrealized_pl: p.unrealized_pl }));
      // Protection and recovery run before scanning, including after restarts and outside entry hours.
      await this.protect(positions);
      const target = session ? minute(session.open) + 15 : null;
      const entryWindow = clock.is_open && session && current >= target && current < target + 10;
      if (clock.is_open && (this.state.startedAt || entryWindow)) {
        try { await this.benchmark(); }
        catch (error) {
          // Once invested, a missing benchmark must never prevent stop maintenance.
          if (!this.state.startedAt) throw error;
          this.state.benchmarkError = error.message;
        }
      }
      if (entryWindow) {
        if (!this.state.startedAt) {
          this.state.startedAt = this.now().toISOString();
          await this.save();
        }
        await this.scan(day, account, target);
        // Attach stops immediately if the paper broker filled entries synchronously.
        await this.syncOrders();
        const updated = await this.provider.positions();
        this.state.positions = updated.map((p) => ({ symbol: p.symbol, qty: p.qty, avg_entry_price: p.avg_entry_price,
          current_price: p.current_price, market_value: p.market_value, unrealized_pl: p.unrealized_pl }));
        await this.protect(updated);
      } else if (session && current >= target + 10) {
        await this.cancelLateEntries();
        if (this.state.days[day] && !this.state.days[day].complete) {
          const run = this.state.days[day];
          for (const signal of run.signals) {
            if (!run.decisions[signal.ticker]) run.decisions[signal.ticker] = { status: "skipped", reason: "Morning entry window ended" };
          }
          run.complete = true;
        }
        if (!this.state.days[day]) this.state.days[day] = { complete: true, missed: true,
          reason: "Worker was unavailable during the morning entry window; no historical signals invented.", signals: [], decisions: {} };
      }
      // A single account snapshot is the valuation source of truth. Separate fills
      // and position endpoints can briefly straddle a fill and fabricate a loss.
      const mark = await this.provider.account();
      if (mark.id !== this.state.accountId) throw new Error("Paper account identity changed during reconciliation.");
      this.state.accountMark = { equity: number(mark.equity || mark.cash), cash: number(mark.cash), at: this.now().toISOString() };
      const summary = summarize(this.state);
      this.state.equityPeak = Math.max(this.state.equityPeak || this.state.capital, summary.equity);
      this.state.maxDrawdownPercent = summary.maxDrawdownPercent;
      if (this.state.startedAt) {
        const point = { at: this.now().toISOString(), equity: summary.equity, benchmark: summary.benchmarkValue };
        // Retain hourly marks plus the latest minute of each hour; daily closing marks remain.
        const last = this.state.snapshots.at(-1);
        if (last && last.at.slice(0, 13) === point.at.slice(0, 13)) this.state.snapshots[this.state.snapshots.length - 1] = point;
        else this.state.snapshots.push(point);
      }
      this.state.status = clock.is_open ? "running" : "market_closed";
      this.state.message = clock.is_open ? "Automatic paper trading active. Morning entries; broker-hosted trailing stops."
        : "Market closed. Automation resumes next session; trailing stops trigger in regular hours.";
      this.state.nextOpen = clock.next_open;
      this.state.lastSuccessAt = this.now().toISOString();
      this.state.lastError = null;
      await this.save();
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "paper_worker_failed", message: error.message }));
      if (this.state) {
        this.state.status = "attention";
        this.state.message = "Automation encountered a problem and will retry automatically. Existing broker-hosted stops remain in place.";
        this.state.lastError = error.message;
        await this.save();
      }
    } finally { this.busy = false; }
  }
}
