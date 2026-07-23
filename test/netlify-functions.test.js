import test from "node:test";
import assert from "node:assert/strict";
import { handler as newsHandler } from "../netlify/functions/news.js";
import { handler as trendingHandler } from "../netlify/functions/trending.js";

test("Netlify functions reject unsupported methods with JSON", async () => {
  const result = await trendingHandler({ httpMethod: "POST" });
  assert.equal(result.statusCode, 405);
  assert.equal(result.headers["Content-Type"], "application/json; charset=utf-8");
  assert.doesNotThrow(() => JSON.parse(result.body));
});
test("Netlify news function validates symbols before fetching", async () => {
  const result = await newsHandler({ httpMethod: "GET", path: "/api/news/not_valid!" });
  assert.equal(result.statusCode, 400);
  assert.match(JSON.parse(result.body).error, /symbol/i);
});
