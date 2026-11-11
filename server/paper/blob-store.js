import { randomUUID } from "node:crypto";
import { emptyState } from "./store.js";

const KEY = "portfolio-v1";
const LEASE_MS = 16 * 60_000; // Longer than Netlify's 15-minute background execution limit.

function validate(state) {
  if (!state || state.version !== 1 || !state.intents || !state.days || !Array.isArray(state.orders)) {
    throw new Error("Invalid portfolio ledger; refusing to replace existing history.");
  }
  return state;
}

// State and writer lease share one atomically conditional object. ETags fence off
// overlapping scheduled invocations and stale writers after a crash/lease expiry.
export class BlobStore {
  constructor(blobs, now = () => Date.now()) {
    this.blobs = blobs; this.now = now; this.owner = randomUUID(); this.envelope = null; this.etag = null;
  }
  async load() {
    const result = await this.blobs.getWithMetadata(KEY, { type: "json", consistency: "strong" });
    if (result) validate(result.data.state);
    return result;
  }
  async acquire() {
    const previous = await this.load();
    if (previous?.data.lease?.expiresAt > this.now()) return false;
    const envelope = { state: previous?.data.state || emptyState(), revision: randomUUID(),
      lease: { owner: this.owner, expiresAt: this.now() + LEASE_MS } };
    const result = await this.blobs.setJSON(KEY, envelope, previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
    if (!result.modified) return false;
    await this.verifyWrite(result, envelope);
    return true;
  }
  async verifyWrite(result, envelope) {
    // Also read back the value: do not treat a failed HTTP write or missing ETag
    // as durable success, even if an SDK reports modified=true.
    if (!result.etag) throw new Error("Durable write returned no ETag; no paper order submitted.");
    const confirmed = await this.load();
    if (!confirmed || confirmed.etag !== result.etag || confirmed.data.revision !== envelope.revision) {
      throw new Error("Portfolio write could not be verified; no paper order submitted.");
    }
    this.etag = confirmed.etag; this.envelope = confirmed.data;
  }
  assertLease() {
    if (!this.envelope || this.envelope.lease.owner !== this.owner || this.envelope.lease.expiresAt <= this.now()) {
      throw new Error("Portfolio writer lease expired; this invocation must stop.");
    }
  }
  async read() {
    if (this.envelope) { this.assertLease(); return structuredClone(this.envelope.state); }
    return structuredClone((await this.load())?.data.state || emptyState());
  }
  async write(state) {
    this.assertLease(); validate(state);
    const envelope = { ...this.envelope, state, revision: randomUUID() };
    const result = await this.blobs.setJSON(KEY, envelope, { onlyIfMatch: this.etag });
    if (!result.modified) throw new Error("Portfolio writer lost ownership; stopping this invocation.");
    await this.verifyWrite(result, envelope);
  }
  async release() {
    if (!this.envelope) return;
    this.assertLease();
    const envelope = { ...this.envelope, revision: randomUUID(), lease: { owner: this.owner, expiresAt: 0 } };
    const result = await this.blobs.setJSON(KEY, envelope, { onlyIfMatch: this.etag });
    if (result.modified) await this.verifyWrite(result, envelope);
    this.envelope = null;
  }
}
