import { PaperEngine } from "../../server/paper/engine.js";
import { AlpacaPaper } from "../../server/paper/alpaca.js";
import { getLiveMomentum } from "../../server/live-momentum.js";
import { authorized, isProduction, netlifyEnabled, netlifyStore } from "../../server/paper/netlify.js";

export default async function worker(request, context) {
  if (request.method !== "POST" || !isProduction(context) || !authorized(request)) return new Response(null, { status: 403 });
  if (!netlifyEnabled()) return new Response(null, { status: 204 });
  const store = netlifyStore();
  if (!(await store.acquire())) return new Response(null, { status: 204 });
  try {
    const provider = new AlpacaPaper();
    // No trading request may outlive this invocation's durable ownership lease.
    const requestProvider = provider.request.bind(provider);
    provider.request = (...args) => { store.assertLease(); return requestProvider(...args); };
    const engine = new PaperEngine({ store, provider,
      scanner: () => getLiveMomentum() });
    await engine.tick();
    // Reconcile immediately after each scan, then check the next half-minute slot.
    // The scheduled minute job recovers pending work; accepted stops run at Alpaca.
    if (engine.state?.status === "running") {
      await engine.tick();
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      await engine.tick();
      await engine.tick();
    }
  } finally { await store.release(); }
  return new Response(null, { status: 204 });
}

export const config = { background: true };
