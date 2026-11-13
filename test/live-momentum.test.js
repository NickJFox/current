import test from "node:test";
import assert from "node:assert/strict";
import { measureMomentum, scanLiveMomentum } from "../server/live-momentum.js";
const now = new Date("2026-11-12T13:00:20Z"); // Premarket.
const rows = () => Array.from({ length: 25 }, (_, i) => ({
  t: new Date(Date.parse("2026-11-12T12:35:00Z") + i * 60000).toISOString(),
  o: i < 20 ? 10 : 10 + (i - 20) * 0.02,
  c: i < 20 ? 10 : 10 + (i - 19) * 0.02,
  v: i < 20 ? 1000 : 4000,
}));
test("detects a fresh premarket acceleration without daily volume or a daily gain gate", () => {
  const signal = measureMomentum(rows(), now);
  assert.equal(signal.acceleration, 4);
  assert.equal(signal.volume, 20000);
  assert.ok(signal.change >= 0.5);
});
test("rejects an old spike, stale bars, falling latest minute and insufficient baselines", () => {
  assert.equal(measureMomentum(rows().map((b, i) => ({ ...b, v: i < 20 ? 10000 : 1000 })), now), null);
  assert.equal(measureMomentum(rows(), new Date(now.getTime() + 15 * 60000)), null);
  const falling = rows(); falling.at(-1).c = 10.07;
  assert.equal(measureMomentum(falling, now), null);
  assert.equal(measureMomentum(rows().slice(18), now), null);
});
test("ignores future and incomplete bars", () => {
  const bars = rows();
  const expected = measureMomentum(bars, now);
  bars.push({ t: "2026-11-12T13:00:00Z", o: 10, c: 50, v: 9999999 });
  assert.deepEqual(measureMomentum(bars, now), expected);
});
test("live scan follows pages, tolerates partial discovery and preserves feed", async () => {
  const result = await scanLiveMomentum({ now, feed: "iex", request: async (path) => {
    if (path.includes("most-actives")) throw new Error("Unavailable");
    if (path.includes("movers")) return { gainers: [{ symbol: "EARLY" }] };
    const params = new URL(path, "https://example.com").searchParams;
    assert.equal(params.get("timeframe"), "1Min");
    assert.equal(params.get("feed"), "iex");
    return params.has("page_token") ? { bars: { EARLY: rows().slice(20) } }
      : { bars: { EARLY: rows().slice(0, 20) }, next_page_token: "next" };
  } });
  assert.equal(result.companies[0].ticker, "EARLY");
  assert.equal(result.updatedAt, "2026-11-12T13:00:00.000Z");
});
test("no fresh bars yields no signals or fabricated market timestamp", async () => {
  const result = await scanLiveMomentum({ now, feed: "iex", request: async (path) =>
    path.includes("most-actives") ? { most_actives: [{ symbol: "OLD" }] } : path.includes("movers") ? {} : { bars: {} } });
  assert.deepEqual(result.companies, []);
  assert.equal(result.updatedAt, null);
});
