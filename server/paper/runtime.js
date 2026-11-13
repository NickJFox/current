import { open, readFile, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { FileStore } from "./store.js";
import { AlpacaPaper } from "./alpaca.js";
import { PaperEngine } from "./engine.js";
import { getLiveMomentum } from "../live-momentum.js";

import { portfolioView } from "./view.js";

const store = new FileStore();
const enabled = process.env.PAPER_TRADING_ENABLED === "true";
let running = false, starting = false, timer = null, release = null, runtimeError = null;
// Stable across module reloads, unique across process/container restarts.
const epochKey = Symbol.for("current-market.paper-process-epoch");
const epoch = globalThis[epochKey] ||= randomUUID();
const engine = new PaperEngine({ store, provider: new AlpacaPaper(), enabled,
  scanner: () => getLiveMomentum() });

async function acquireLock() {
  const path = `${store.path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const token = JSON.stringify({ pid: process.pid, host: hostname(), epoch, token: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(token); await file.close();
      return async () => {
        if (await readFile(path, "utf8").catch(() => null) === token) await unlink(path);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(await readFile(path, "utf8")); }
      catch { throw new Error("Worker lock is incomplete; refusing to start a second worker."); }
      const pid = Number(owner.pid);
      if (!pid) throw new Error("Worker lock is incomplete; refusing to start a second worker.");
      // Render detaches its single-writer disk before a replacement container starts.
      // A new container may reuse PID 1; kill(pid, 0) alone would falsely block it.
      if (owner.host !== hostname() || (pid === process.pid && owner.epoch !== epoch)) {
        await unlink(path); continue;
      }
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code === "ESRCH") { await unlink(path); continue; }
        throw error;
      }
      throw new Error("Another paper worker already owns this data directory.");
    }
  }
  throw new Error("Could not acquire the paper worker lock.");
}

export async function startPaperWorker() {
  if (running || starting) return;
  if (!enabled) return;
  starting = true;
  try {
    release = await acquireLock();
    await store.read(); // Never trade if the ledger is unreadable.
    running = true;
    const loop = async () => {
      if (!running) return;
      try { await engine.tick(); }
      catch { runtimeError = "Portfolio storage failed. Check the persistent disk."; }
      if (running) timer = setTimeout(loop, ["running", "attention", "resetting"].includes(engine.state?.status) ? 15_000 : 60_000);
      timer?.unref();
    };
    await loop();
  } catch (error) {
    runtimeError = error.message;
    console.error(JSON.stringify({ level: "error", event: "paper_worker_start_failed", message: error.message }));
    if (release) { await release(); release = null; }
  } finally { starting = false; }
}

export async function stopPaperWorker() {
  running = false;
  clearTimeout(timer);
  // The server waits for any in-flight cycle before releasing its writer lock.
  while (engine.busy) await new Promise((resolve) => setTimeout(resolve, 100));
  if (release) await release();
  release = null;
}

export async function getPaperPortfolio() {
  const state = await store.read();
  return portfolioView(state, {
    status: runtimeError ? "attention" : !running ? "setup_required" : state.status,
    message: runtimeError || (!running ? "The local paper worker is not active. Your Netlify deployment runs its own scheduled worker." : state.message),
    workerRunning: running, lastError: runtimeError,
  });
}
