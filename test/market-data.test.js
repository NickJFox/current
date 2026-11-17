import test from "node:test";
import assert from "node:assert/strict";
import { parseNumber, regularSessionProgress } from "../server/market-data.js";
import { handler as trendingHandler } from "../netlify/functions/trending.js";

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

test("trending uses Nasdaq historical volume when quote summaries lack an average", async (t) => {
  const stock = {
    symbol: "TEST",
    name: "Test Company",
    sector: "Technology",
    pctchange: "3%",
    volume: "2,000,000",
    marketCap: "500,000,000",
    lastsale: "$10",
  };
  const fetch = t.mock.method(globalThis, "fetch", async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/screener/stocks")) {
      return Response.json({ data: { rows: [stock] } });
    }
    if (pathname.endsWith("/quote/TEST/historical")) {
      const end = Date.parse(searchParams.get("todate"));
      const rows = Array.from({ length: 30 }, (_, index) => ({
        date: new Date(end - index * 86_400_000).toISOString().slice(0, 10),
        volume: "1,000,000",
      }));
      return Response.json({ data: { tradesTable: { rows } } });
    }
    return Response.json({ data: { summaryData: {} } });
  });

  const response = await trendingHandler({ httpMethod: "GET" });
  assert.equal(response.statusCode, 200);
  const { companies, source } = JSON.parse(response.body);
  assert.equal(source, "Nasdaq");
  assert.equal(companies.length, 1);
  assert.equal(companies[0].ticker, "TEST");
  assert.equal(companies[0].averageVolume, 1_000_000);
  assert.equal(fetch.mock.callCount(), 2);
});
