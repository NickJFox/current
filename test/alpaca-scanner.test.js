import test from "node:test";
import assert from "node:assert/strict";
import { alpacaScan } from "../server/alpaca-scanner.js";

const now = new Date("2026-11-12T18:00:00Z");
const snapshot = (t = now.toISOString()) => ({ latestTrade: { p: 110, t }, prevDailyBar: { c: 100 }, dailyBar: { v: 1000000 } });
const history = Array.from({ length: 12 }, (_, index) => ({ t: `2026-10-${String(index + 1).padStart(2, "0")}T04:00:00Z`, v: 500000 }));

test("Alpaca fallback tolerates one unavailable discovery endpoint, follows history pages, and uses one feed", async () => {
  const paths = [];
  const result = await alpacaScan({ now, progress: 0.5, feed: "iex", request: async (path) => {
    paths.push(path);
    if (path.includes("most-actives")) throw new Error("Unavailable");
    if (path.includes("movers")) return { gainers: [{ symbol: "TEST" }, { symbol: "TEST" }, { symbol: "BAD/URL" }] };
    if (path.includes("snapshots")) return { TEST: snapshot() };
    const params = new URL(path, "https://data.alpaca.markets").searchParams;
    assert.equal(params.get("feed"), "iex");
    assert.equal(params.get("end"), "2026-11-12T00:00:00.000Z");
    if (!params.get("page_token")) return { bars: { TEST: history.slice(0, 6) }, next_page_token: "next" };
    return { bars: { TEST: [...history.slice(6), { t: "2026-11-12T04:00:00Z", v: 99999999 }] }, next_page_token: null };
  } });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].averageVolume, 500000);
  assert.equal(result.items[0].stock.volume, 1000000);
  assert.equal(result.sourceAt, now.toISOString());
  assert.equal(paths.length, 5);
  assert.ok(paths.every((path) => !path.includes("orders")));
});

test("stale prices and falling stocks yield an empty successful scan", async () => {
  const result = await alpacaScan({ now, progress: 0.5, request: async (path) => {
    if (path.includes("most-actives")) return { most_actives: [{ symbol: "STALE" }, { symbol: "DOWN" }] };
    if (path.includes("movers")) return {};
    if (path.includes("snapshots")) return { STALE: snapshot("2026-11-12T17:00:00Z"), DOWN: { ...snapshot(), prevDailyBar: { c: 120 } } };
    throw new Error("No historical lookup expected");
  } });
  assert.deepEqual(result.items, []);
});

test("missing discovery or historical baselines are errors rather than empty momentum results", async () => {
  await assert.rejects(alpacaScan({ now, progress: 0.5, request: async () => { throw new Error("Forbidden"); } }), /universe unavailable/);
  await assert.rejects(alpacaScan({ now, progress: 0.5, request: async (path) => {
    if (path.includes("most-actives")) return { most_actives: [{ symbol: "TEST" }] };
    if (path.includes("movers")) return {};
    if (path.includes("snapshots")) return { TEST: snapshot() };
    return { bars: {} };
  } }), /baselines unavailable/);
});
