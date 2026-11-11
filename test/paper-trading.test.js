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
  const scanner = async () => { scans++; return { stale: false, updatedAt: current.toISOString(), companies: [{ ticker: "TEST", price: 100, relativeVolume: 3 }] }; };
  const make = () => new PaperEngine({ store, provider, scanner, now: () => current });
  return { store, provider, orders, submitted, canceled, make, scans: () => scans,
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

test("holidays and missed entry windows do not invent historical signals", async () => {
  const f = fixture(); f.provider.calendar = async () => [];
  f.provider.clock = async () => ({ timestamp: AT, is_open: false });
  await f.make().tick(); assert.equal(f.scans(), 0); assert.equal(f.submitted.length, 0);
  const late = fixture(); late.setTime("2026-11-11T15:10:00Z");
  await late.make().tick(); assert.equal(late.scans(), 0); assert.equal(late.store.data.days["2026-11-11"].missed, true);
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
  assert.equal(f.scans(), 1);
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
    f.setTime("2026-11-11T15:00:00Z");
    return scan();
  };
  await engine.tick();
  assert.equal(f.submitted.length, 0);
  assert.equal(f.store.data.days["2026-11-11"].decisions.TEST.reason, "Morning entry window ended");
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
