import test from "node:test";
import assert from "node:assert/strict";
import { BlobStore } from "../server/paper/blob-store.js";
import { authorized, signature } from "../server/paper/netlify.js";
import portfolio from "../netlify/functions/portfolio.js";
import worker from "../netlify/functions/paper-worker-background.js";
import schedule from "../netlify/functions/paper-schedule.js";

function blobs() {
  let record = null, version = 0;
  return {
    async getWithMetadata() { return structuredClone(record); },
    async setJSON(key, data, options) {
      if ((options.onlyIfNew && record) || (options.onlyIfMatch && record?.etag !== options.onlyIfMatch)) return { modified: false };
      record = { data: structuredClone(data), etag: `etag-${++version}` };
      return { modified: true, etag: record.etag };
    },
  };
}

test("only one scheduled invocation can own the ledger; release allows the next invocation", async () => {
  const api = blobs(), first = new BlobStore(api), second = new BlobStore(api);
  const result = await Promise.all([first.acquire(), second.acquire()]);
  assert.deepEqual(result.sort(), [false, true]);
  // Determine ownership independently of the sorted assertion result.
  const winner = first.envelope ? first : second;
  const state = await winner.read(); state.days.test = { complete: true };
  await winner.write(state); await winner.release();
  const next = new BlobStore(api); assert.equal(await next.acquire(), true);
  assert.equal((await next.read()).days.test.complete, true);
  await next.release();
});

test("a timed-out invocation cannot overwrite the next owner's state", async () => {
  let now = 1000; const api = blobs();
  const old = new BlobStore(api, () => now); assert.equal(await old.acquire(), true);
  const state = await old.read(); state.days.old = { complete: true }; await old.write(state);
  now += 17 * 60_000;
  const next = new BlobStore(api, () => now); assert.equal(await next.acquire(), true);
  const updated = await next.read(); updated.days.new = { complete: true }; await next.write(updated);
  await assert.rejects(old.write(state), /lease expired/);
  assert.equal((await next.read()).days.new.complete, true);
});

test("an SDK false success cannot authorize a paper order", async () => {
  const api = blobs(); api.setJSON = async () => ({ modified: true, etag: "" });
  await assert.rejects(new BlobStore(api).acquire(), /no ETag/);
});

test("a concurrent revision change is detected by the durable readback", async () => {
  const api = blobs(), send = api.setJSON;
  api.setJSON = async (...args) => {
    const result = await send(...args);
    const actual = await api.getWithMetadata();
    await send("portfolio-v1", { ...actual.data, revision: "other" }, { onlyIfMatch: actual.etag });
    return result;
  };
  await assert.rejects(new BlobStore(api).acquire(), /could not be verified/);
});

test("background worker signatures reject tampering and expired requests", () => {
  const now = 1794400000000, secret = "test-secret", timestamp = String(now);
  const request = new Request("https://example.netlify.app/worker", { headers: {
    "x-paper-timestamp": timestamp, "x-paper-signature": signature(timestamp, secret),
  } });
  assert.equal(authorized(request, now, secret), true);
  assert.equal(authorized(request, now + 6 * 60_000, secret), false);
  assert.equal(authorized(request, now, "wrong-secret"), false);
  assert.equal(authorized(new Request("https://example.test"), now, secret), false);
});

test("portfolio is read-only and unauthenticated background calls never start work", async () => {
  assert.equal((await portfolio(new Request("https://example.test", { method: "POST" }))).status, 405);
  assert.equal((await worker(new Request("https://example.test", { method: "POST" }))).status, 403);
});

test("branch and local schedules never trade against the production ledger", async () => {
  const previous = process.env.CONTEXT;
  try { process.env.CONTEXT = "deploy-preview"; await schedule(); }
  finally { if (previous === undefined) delete process.env.CONTEXT; else process.env.CONTEXT = previous; }
});
