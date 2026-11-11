import { PaperEngine } from "../../server/paper/engine.js";
import { AlpacaPaper } from "../../server/paper/alpaca.js";
import { getTrendingCompanies } from "../../server/market-data.js";
import { authorized, isProduction, netlifyEnabled, netlifyStore } from "../../server/paper/netlify.js";

export default async function worker(request) {
  if (request.method !== "POST" || !isProduction() || !authorized(request)) return new Response(null, { status: 403 });
  if (!netlifyEnabled()) return new Response(null, { status: 204 });
  const store = netlifyStore();
  if (!(await store.acquire())) return new Response(null, { status: 204 });
  try {
    const provider = new AlpacaPaper();
    // No trading request may outlive this invocation's durable ownership lease.
    const requestProvider = provider.request.bind(provider);
    provider.request = (...args) => { store.assertLease(); return requestProvider(...args); };
    const engine = new PaperEngine({ store, provider,
      scanner: () => getTrendingCompanies({ forceRefresh: true }) });
    await engine.tick();
    // One immediate follow-up reconciles asynchronous fills and attaches stops.
    // The next scheduled run recovers anything still pending; accepted stops run at Alpaca.
    if (engine.state?.status === "running") await engine.tick();
  } finally { await store.release(); }
  return new Response(null, { status: 204 });
}

export const config = { background: true };
