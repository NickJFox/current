import test from "node:test";
import assert from "node:assert/strict";
import { parseNumber, regularSessionProgress, historicalAverageVolume } from "../server/market-data.js";

test("historical average excludes the current session and requires sufficient history", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ date: `10/${index + 1}/2026`, volume: "1,000" }));
  rows.push({ date: "11/12/2026", volume: "900,000" }, { date: "invalid", volume: "5,000" });
  assert.equal(historicalAverageVolume(rows, "2026-11-12"), 1000);
  assert.equal(historicalAverageVolume(rows.slice(0, 9), "2026-11-12"), 0);
});

test("parseNumber handles market-data formats", () => {
  assert.equal(parseNumber("$1,234.50"), 1234.5);
  assert.equal(parseNumber("2.5M"), 2_500_000);
  assert.equal(parseNumber("3.2%"), 3.2);
  assert.equal(parseNumber("N/A"), 0);
});
test("regularSessionProgress returns one outside the regular session", () => {
  assert.equal(regularSessionProgress(new Date("2026-07-25T16:00:00Z")), 1);
  assert.equal(regularSessionProgress(new Date("2026-07-23T12:00:00Z")), 1);
});

test("regularSessionProgress adjusts during the regular session", () => {
  const halfway = regularSessionProgress(new Date("2026-07-23T16:45:00Z"));
  assert.ok(Math.abs(halfway - 0.5) < 0.001);
});

test("opening volume pace uses elapsed minutes rather than a 10% floor", () => {
  assert.equal(regularSessionProgress(new Date("2026-11-11T14:30:00Z")), 1 / 390);
  assert.equal(regularSessionProgress(new Date("2026-11-11T14:45:00Z")), 15 / 390);
});

test("scanner falls back from invalid Nasdaq data to authenticated Alpaca market data", async (t) => {
  const previous = { key: process.env.ALPACA_API_KEY, secret: process.env.ALPACA_API_SECRET, feed: process.env.ALPACA_DATA_FEED };
  process.env.ALPACA_API_KEY = "test-key"; process.env.ALPACA_API_SECRET = "test-secret"; process.env.ALPACA_DATA_FEED = "iex";
  t.after(() => {
    for (const [name, value] of [["ALPACA_API_KEY", previous.key], ["ALPACA_API_SECRET", previous.secret], ["ALPACA_DATA_FEED", previous.feed]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const now = new Date(), paths = [];
  const history = Array.from({ length: 15 }, (_, index) => ({ t: new Date(now.getTime() - (index + 2) * 86400000).toISOString(), v: 250000 }));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const parsed = new URL(url); paths.push(parsed.pathname);
    let data;
    if (parsed.hostname === "api.nasdaq.com") data = { data: null };
    else {
      assert.equal(parsed.hostname, "data.alpaca.markets");
      assert.equal(options.method, "GET");
      assert.equal(options.headers["APCA-API-KEY-ID"], "test-key");
      if (parsed.pathname.includes("most-actives")) data = { most_actives: [{ symbol: "TEST" }] };
      else if (parsed.pathname.includes("movers")) data = { gainers: [] };
      else if (parsed.pathname.includes("snapshots")) data = { TEST: { latestTrade: { p: 110, t: now.toISOString() }, prevDailyBar: { c: 100 }, dailyBar: { v: 1000000 } } };
      else if (parsed.pathname.includes("bars")) data = { bars: { TEST: history }, next_page_token: null };
      else assert.fail(`Unexpected market-data path: ${parsed.pathname}`);
    }
    return Response.json(data);
  });
  const { getTrendingCompanies } = await import("../server/market-data.js?fallback-test");
  const scan = await getTrendingCompanies({ forceRefresh: true });
  assert.equal(scan.source, "Alpaca (IEX)");
  assert.equal(scan.companies.length, 1);
  assert.equal(scan.companies[0].ticker, "TEST");
  assert.equal(scan.companies[0].averageVolume, 250000);
  assert.ok(scan.companies[0].relativeVolume >= 4);
  assert.equal(scan.updatedAt, now.toISOString());
  assert.equal(scan.stale, false);
  assert.equal(paths.length, 5);
  assert.ok(!JSON.stringify(scan).includes("test-secret"));
});

test("a valid empty Nasdaq screener is a successful scan, not an upstream failure", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { rows: [] } }));
  const { getTrendingCompanies } = await import("../server/market-data.js?empty-test");
  const scan = await getTrendingCompanies({ forceRefresh: true });
  assert.deepEqual(scan.companies, []);
  assert.equal(scan.source, "Nasdaq");
  assert.equal(scan.stale, false);
});

test("Nasdaq history is fetched directly without depending on absent summary fields", async (t) => {
  const paths = [], now = new Date();
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = new URL(url).pathname; paths.push(path);
    if (path.includes("screener")) return Response.json({ data: { rows: [{ symbol: "TEST", name: "Test Common Stock", sector: "Technology", volume: "1000000", marketCap: "1000000000", lastsale: "$100", pctchange: "2%" }] } });
    assert.ok(path.includes("historical"));
    const rows = Array.from({ length: 15 }, (_, index) => ({ date: new Date(now.getTime() - (index + 2) * 86400000).toISOString(), volume: "250000" }));
    return Response.json({ data: { tradesTable: { rows } } });
  });
  const { getTrendingCompanies } = await import("../server/market-data.js?history-test");
  const scan = await getTrendingCompanies({ forceRefresh: true });
  assert.equal(scan.companies.length, 1);
  assert.equal(scan.source, "Nasdaq");
  assert.equal(paths.length, 2);
});
