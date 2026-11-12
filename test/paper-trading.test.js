import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperEngine, easternTime, summarize } from "../server/paper/engine.js";
import { FileStore, emptyState } from "../server/paper/store.js";
import { AlpacaPaper } from "../server/paper/alpaca.js";

const AT = "2026-11-11T14:46:00.000Z";
function fixture() {
  let current = new Date(AT), scans = 0;
  let signals = [{ ticker: "TEST", price: 100, relativeVolume: 3 }];
  const data = emptyState();
  const store = { data, async read() { return structuredClone(this.data); }, async write(s) { this.data = structuredClone(s); } };
  const orders = new Map(); let holdings = [];
  const submitted = [], canceled = [];
  const provider = {
    configured: true,
    async clock() { return { timestamp: current.toISOString(), is_open: true, next_open: "2026-11-12T14:30:00Z" }; },
    async calendar() { return [{ open: "09:30", close: "16:00" }]; },
    async account() {
      const cash = 100000 + [...orders.values()].reduce((sum, o) => sum + (o.side === "buy" ? -1 : 1) * Number(o.filled_qty || 0) * Number(o.filled_avg_price || 0), 0);
      const market = holdings.reduce((sum, p) => sum + Number(p.market_value || 0), 0);
      return { id: "paper-test", cash: String(cash), equity: String(cash + market) };
    },
    async positions() { return structuredClone(holdings); },
    async openOrders() { return [...orders.values()].filter((o) => o.status === "new"); },
    async order(id) { return orders.get(id) || null; },
    async asset() { return { tradable: true, status: "active" }; },
    async quote() { return { ap: 100, bp: 99.9, t: current.toISOString() }; },
    async cancel(id) { canceled.push(id); for (const order of orders.values()) if (order.id === id) order.status = "canceled"; },
    async submit(body) {
      submitted.push(body);
      const order = { ...body, id: body.client_order_id, status: body.side === "buy" ? "filled" : "new",
        filled_qty: body.side === "buy" ? body.qty : "0", filled_avg_price: body.side === "buy" ? "100" : null,
        filled_at: body.side === "buy" ? current.toISOString() : null, created_at: current.toISOString(), stop_price: body.side === "sell" ? "97" : null };
      orders.set(body.client_order_id, order);
      if (body.side === "buy") holdings.push({ symbol: body.symbol, qty: body.qty, avg_entry_price: "100", current_price: "100", market_value: String(Number(body.qty) * 100), unrealized_pl: "0" });
      return order;
    },
  };
  const scanner = async () => { scans++; return { stale: false, updatedAt: current.toISOString(), companies: structuredClone(signals) }; };
  const make = () => new PaperEngine({ store, provider, scanner, now: () => current });
  return { store, provider, orders, submitted, canceled, make, scans: () => scans,
    setSignals: (value) => { signals = value; },
    setTime: (at) => { current = new Date(at); }, setHoldings: (positions) => { holdings = positions; } };
}

test("morning run buys with cash, attaches a broker-hosted trailing stop, and is idempotent after restart", async () => {
  const f = fixture(); await f.make().tick();
  assert.equal(f.store.data.status, "running");
  assert.equal(f.scans(), 1);
  assert.equal(f.submitted.length, 2);
  assert.equal(f.submitted[0].type, "limit");
  assert.ok(Number(f.submitted[0].qty) * Number(f.submitted[0].limit_price) <= 10_000);
  assert.equal(f.submitted[1].type, "trailing_stop");
  assert.equal(f.submitted[1].trail_percent, "3");
  assert.equal(f.submitted[1].time_in_force, "gtc");
  assert.equal(summarize(f.store.data).equity, 10_000);
  await f.make().tick();
  assert.equal(f.scans(), 1); assert.equal(f.submitted.length, 2);
});

test("a lost buy response is reconciled by the same client ID without duplicate purchases", async () => {
  const f = fixture(); const send = f.provider.submit;
  let lost = false;
  f.provider.submit = async (body) => {
    const result = await send(body);
    if (body.side === "buy" && !lost) { lost = true; throw new Error("Simulated lost response"); }
    return result;
  };
  await f.make().tick();
  assert.equal(f.store.data.status, "attention");
  await f.make().tick();
  assert.equal(f.submitted.filter((o) => o.side === "buy").length, 1);
  assert.equal(f.submitted.filter((o) => o.type === "trailing_stop").length, 1);
  assert.equal(f.store.data.status, "running");
});

test("missing credentials and disabled automation cannot submit orders", async () => {
  const f = fixture(); f.provider.configured = false;
  await f.make().tick(); assert.equal(f.store.data.status, "setup_required");
  assert.equal(f.submitted.length, 0);
  f.provider.configured = true;
  const engine = f.make(); engine.enabled = false; await engine.tick();
  assert.equal(f.submitted.length, 0);
});

test("stale signals are rejected and retried without buys", async () => {
  const f = fixture(); const engine = f.make();
  engine.scanner = async () => ({ stale: true, updatedAt: AT, companies: [{ ticker: "TEST" }] });
  await engine.tick(); assert.equal(f.submitted.length, 0); assert.equal(f.store.data.status, "attention");
  await f.make().tick(); assert.equal(f.submitted.length, 2);
});

test("holidays do not scan; afternoon recovery scans fresh signals", async () => {
  const f = fixture(); f.provider.calendar = async () => [];
  f.provider.clock = async () => ({ timestamp: AT, is_open: false });
  await f.make().tick(); assert.equal(f.scans(), 0); assert.equal(f.submitted.length, 0);
  const late = fixture(); late.setTime("2026-11-11T15:10:00Z");
  await late.make().tick(); assert.equal(late.scans(), 1); assert.equal(late.submitted.filter((o) => o.side === "buy").length, 1);
  assert.deepEqual(Object.keys(late.store.data.days["2026-11-11"].scans), ["610"]);
});

test("first activation refuses existing holdings without changing them", async () => {
  const f = fixture(); f.setHoldings([{ symbol: "OTHER", qty: "5" }]);
  await f.make().tick(); assert.equal(f.store.data.status, "attention"); assert.equal(f.submitted.length, 0);
});

test("a canceled stop is automatically replaced, including outside the morning window", async () => {
  const f = fixture(); await f.make().tick();
  const stop = [...f.orders.values()].find((o) => o.side === "sell"); stop.status = "canceled";
  f.setTime("2026-11-11T18:00:00Z"); await f.make().tick();
  assert.equal(f.submitted.filter((o) => o.type === "trailing_stop").length, 2);
  assert.equal(f.scans(), 2);
});

test("definitively rejected protection triggers a paper market exit next cycle", async () => {
  const f = fixture(); const send = f.provider.submit;
  f.provider.submit = async (body) => {
    if (body.type === "trailing_stop") { const error = new Error("Stop rejected"); error.status = 422; throw error; }
    return send(body);
  };
  await f.make().tick(); assert.equal(f.store.data.status, "attention");
  await f.make().tick();
  assert.ok(f.submitted.some((o) => o.side === "sell" && o.type === "market"));
});

test("partial fills are canceled before protection is sized to actual holdings", async () => {
  const f = fixture(); const send = f.provider.submit;
  f.provider.submit = async (body) => {
    const order = await send(body);
    if (body.side === "buy") {
      order.status = "partially_filled"; order.filled_qty = "4";
      f.setHoldings([{ symbol: body.symbol, qty: "4", market_value: "400", unrealized_pl: "0" }]);
    }
    return order;
  };
  await f.make().tick();
  assert.equal(f.canceled.length, 1);
  assert.equal(f.submitted.find((o) => o.side === "sell").qty, "4");
});

test("cash, realized profit, unrealized profit and SPY use the same $10k base", () => {
  const state = emptyState();
  state.orders = [
    { side: "buy", symbol: "A", filled_qty: "10", filled_avg_price: "100", filled_at: AT },
    { side: "sell", symbol: "A", filled_qty: "5", filled_avg_price: "110", filled_at: "2026-11-11T15:00:00Z" },
  ];
  state.positions = [{ market_value: "550", unrealized_pl: "50" }];
  state.benchmark = { entryPrice: 100, lastPrice: 102 };
  const m = summarize(state);
  assert.equal(m.cash, 9550); assert.equal(m.equity, 10100);
  assert.equal(m.realizedProfit, 50); assert.equal(m.unrealizedProfit, 50);
  assert.equal(m.returnPercent, 1); assert.ok(Math.abs(m.benchmarkReturnPercent - 2) < 1e-8);
});

test("Eastern scheduling follows daylight saving and early session starts", () => {
  assert.deepEqual(easternTime(new Date(AT)), { day: "2026-11-11", minute: 586 });
  assert.deepEqual(easternTime(new Date("2026-07-23T13:46:00Z")), { day: "2026-07-23", minute: 586 });
});

test("the provider hardcodes paper execution even if a live URL is set elsewhere", async () => {
  const calls = [];
  const provider = new AlpacaPaper({ key: "test", secret: "test", fetcher: async (url) => {
    calls.push(url); return { ok: true, status: 200, json: async () => ({}) };
  } });
  await provider.submit({ symbol: "TEST" });
  assert.equal(calls[0], "https://paper-api.alpaca.markets/v2/orders");
});

test("disk persistence survives restart and refuses to overwrite a corrupt ledger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paper-ledger-"));
  try {
    const path = join(dir, "ledger.json");
    const store = new FileStore(path); const state = await store.read(); state.capital = 12345;
    await store.write(state);
    assert.equal((await new FileStore(path).read()).capital, 12345);
    await writeFile(path, "broken");
    await assert.rejects(new FileStore(path).read());
    assert.equal(await readFile(path, "utf8"), "broken");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("new equity highs do not retroactively create drawdowns", () => {
  const state = emptyState(); state.snapshots = [{ equity: 10000 }, { equity: 11000 }];
  state.equityPeak = 11000;
  state.accountBaseline = { equity: 100000, cash: 100000 };
  state.accountMark = { equity: 101000, cash: 100000 };
  assert.equal(summarize(state).maxDrawdownPercent, 0);
  state.accountMark.equity = 100000;
  assert.ok(Math.abs(summarize(state).maxDrawdownPercent - 100 / 11) < 1e-8);
});

test("a slow scan that finishes after the entry window cannot submit late buys", async () => {
  const f = fixture(), engine = f.make(), scan = engine.scanner;
  engine.scanner = async () => {
    f.setTime("2026-11-11T14:50:00Z");
    return scan();
  };
  await engine.tick();
  assert.equal(f.submitted.length, 0);
  assert.equal(f.store.data.days["2026-11-11"].scans["585"].decisions.TEST.reason, "Scan entry window ended");
});

test("provider account marks prevent a fill/position timing race from fabricating drawdown", () => {
  const state = emptyState();
  state.orders = [{ side: "buy", filled_qty: "100", filled_avg_price: "100" }];
  state.positions = []; // Position endpoint has already seen an exit, order endpoint has not.
  state.accountBaseline = { equity: 100000, cash: 100000 };
  state.accountMark = { equity: 100100, cash: 100100 };
  assert.equal(summarize(state).equity, 10100);
  assert.equal(summarize(state).maxDrawdownPercent, 0);
});

test("five-minute scans survive restarts and can buy new afternoon signals", async () => {
  const f = fixture(); await f.make().tick();
  f.setTime("2026-11-11T14:49:00Z"); await f.make().tick();
  assert.equal(f.scans(), 1);
  f.setSignals([{ ticker: "NEW", price: 100, relativeVolume: 2 }]);
  f.setTime("2026-11-11T18:00:00Z"); await f.make().tick();
  assert.equal(f.scans(), 2);
  assert.equal(f.submitted.filter((o) => o.side === "buy").length, 2);
  assert.equal(f.submitted.filter((o) => o.type === "trailing_stop").length, 2);
  assert.ok(f.submitted.some((o) => o.symbol === "NEW" && o.side === "buy"));
  const scans = f.store.data.days["2026-11-11"].scans;
  assert.deepEqual(Object.keys(scans), ["585", "780"]);
  assert.equal(scans["780"].strategyVersion, 2);
});

test("a stopped-out symbol cannot be bought again by a later same-day scan", async () => {
  const f = fixture(); await f.make().tick();
  const stop = [...f.orders.values()].find((o) => o.side === "sell");
  stop.status = "filled"; stop.filled_qty = stop.qty; stop.filled_avg_price = "97";
  f.setHoldings([]);
  f.setTime("2026-11-11T14:51:00Z"); await f.make().tick();
  assert.equal(f.scans(), 2);
  assert.equal(f.submitted.filter((o) => o.side === "buy").length, 1);
  assert.equal(f.store.data.days["2026-11-11"].scans["590"].decisions.TEST.reason, "Already attempted today");
});

test("open entries expire at the next slot and cannot be recreated by later scans", async () => {
  const f = fixture(), submit = f.provider.submit;
  f.provider.submit = async (body) => {
    const order = await submit(body);
    if (body.side === "buy") {
      order.status = "new"; order.filled_qty = "0"; order.filled_avg_price = null;
      f.setHoldings([]);
    }
    return order;
  };
  await f.make().tick();
  f.setTime("2026-11-11T14:49:00Z"); await f.make().tick();
  assert.equal(f.canceled.length, 0);
  f.setTime("2026-11-11T14:50:00Z"); await f.make().tick();
  assert.equal(f.canceled.length, 1);
  assert.equal(f.submitted.filter((o) => o.side === "buy").length, 1);
});

test("cancel-pending entry commitments remain reserved for subsequent scans", async () => {
  const f = fixture(), submit = f.provider.submit;
  f.provider.submit = async (body) => {
    const order = await submit(body);
    if (body.side === "buy") {
      order.status = "new"; order.filled_qty = "0"; order.filled_avg_price = null;
      f.setHoldings([]);
    }
    return order;
  };
  f.provider.cancel = async (id) => { f.canceled.push(id); }; // cancellation not yet acknowledged
  await f.make().tick();
  f.setSignals([{ ticker: "NEW", price: 100, relativeVolume: 2 }]);
  f.setTime("2026-11-11T14:50:00Z"); await f.make().tick();
  const buys = f.submitted.filter((o) => o.side === "buy");
  assert.equal(buys.length, 2);
  assert.ok(buys.reduce((sum, o) => sum + Number(o.qty) * Number(o.limit_price), 0) <= 10000);
});

test("entries stop ten minutes before regular or early close; protection still runs", async () => {
  for (const [close, at] of [["16:00", "2026-11-11T20:50:00Z"], ["13:00", "2026-11-11T17:50:00Z"]]) {
    const f = fixture();
    f.provider.calendar = async () => [{ open: "09:30", close }];
    await f.make().tick();
    const stop = [...f.orders.values()].find((o) => o.side === "sell"); stop.status = "canceled";
    f.setTime(at); await f.make().tick();
    assert.equal(f.scans(), 1);
    assert.equal(f.submitted.filter((o) => o.type === "trailing_stop").length, 2);
    assert.equal(f.store.data.days["2026-11-11"].complete, true);
  }
});

test("all-day comparison starts at current equity and SPY without resetting lifetime history", async () => {
  const f = fixture();
  Object.assign(f.store.data, {
    startedAt: "2026-11-10T14:45:00Z", accountId: "paper-test",
    accountBaseline: { equity: 99000, cash: 99000 },
    benchmark: { entryPrice: 90, lastPrice: 99.9 },
    snapshots: [{ at: "2026-11-10T15:00:00Z", equity: 10500, benchmark: 10500 }],
  });
  await f.make().tick();
  const experiment = f.store.data.intradayExperiment;
  assert.equal(experiment.startEquity, 11000);
  assert.equal(experiment.spyEntryPrice, 99.9);
  assert.equal(f.store.data.benchmark.entryPrice, 90);
  assert.equal(f.store.data.startedAt, "2026-11-10T14:45:00Z");
  const state = structuredClone(f.store.data);
  state.accountMark.equity = 100220; // sleeve grows from 11,000 to 11,220: +2%
  state.benchmark.lastPrice = 100.899; // SPY +1%
  const metrics = summarize(state);
  assert.ok(Math.abs(metrics.intradayReturnPercent - 2) < 1e-8);
  assert.ok(Math.abs(metrics.intradayBenchmarkReturnPercent - 1) < 1e-8);
  assert.ok(Math.abs(metrics.intradayExcessReturnPercent - 1) < 1e-8);
});

test("a slow order lookup crossing the scan boundary cannot submit a late buy", async () => {
  const f = fixture(), lookup = f.provider.order;
  f.provider.order = async (id) => {
    if (id.startsWith("cm-buy-")) f.setTime("2026-11-11T14:50:00Z");
    return lookup(id);
  };
  await f.make().tick();
  assert.equal(f.submitted.length, 0);
  assert.match(f.store.data.lastError, /Entry scan window ended before submission/);
  await f.make().tick(); // next slot sees the intent; it must never recreate it
  assert.equal(f.submitted.length, 0);
});

test("new strategy preserves a legacy missed morning and can scan that afternoon", async () => {
  const f = fixture();
  f.store.data.days["2026-11-11"] = { missed: true, complete: true, reason: "Legacy missed entry", signals: [], decisions: {} };
  f.setTime("2026-11-11T18:01:00Z"); await f.make().tick();
  const daily = f.store.data.days["2026-11-11"];
  assert.equal(daily.reason, "Legacy missed entry");
  assert.ok(daily.scans["780"]);
  assert.equal(f.submitted.filter((o) => o.side === "buy").length, 1);
});

test("failed SPY refresh cannot block protective stops once the comparison has started", async () => {
  const f = fixture(); await f.make().tick();
  const stop = [...f.orders.values()].find((o) => o.side === "sell"); stop.status = "canceled";
  const quote = f.provider.quote;
  f.provider.quote = async (symbol) => { if (symbol === "SPY") throw new Error("SPY unavailable"); return quote(symbol); };
  f.setTime("2026-11-11T18:00:00Z"); await f.make().tick();
  assert.equal(f.submitted.filter((o) => o.type === "trailing_stop").length, 2);
  assert.equal(f.store.data.benchmarkError, "SPY unavailable");
  assert.equal(f.store.data.status, "running");
});
