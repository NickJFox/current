import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function emptyState() {
  return { version: 1, startedAt: null, accountId: null, capital: 10_000, trailPercent: 3,
    days: {}, intents: {}, orders: [], positions: [], snapshots: [], benchmark: null,
    status: "waiting", message: "Waiting for the automated worker.", lastRunAt: null,
    lastSuccessAt: null, lastError: null };
}

// One worker owns this file. Atomic replacement prevents truncated state after a crash.
export class FileStore {
  constructor(path = process.env.PAPER_STATE_PATH || "./data/paper-portfolio.json") {
    this.path = resolve(path);
    this.state = null;
  }
  async read() {
    if (this.state) return structuredClone(this.state);
    try {
      const state = JSON.parse(await readFile(this.path, "utf8"));
      if (state.version !== 1 || !state.intents || !state.days || !Array.isArray(state.orders)) {
        throw new Error("Invalid portfolio state; refusing to initialize over existing data.");
      }
      this.state = state;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = emptyState();
    }
    return structuredClone(this.state);
  }
  async write(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, this.path);
    this.state = structuredClone(state);
  }
}
