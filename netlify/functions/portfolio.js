import { netlifyStore, isProduction, netlifyEnabled } from "../../server/paper/netlify.js";
import { portfolioView } from "../../server/paper/view.js";

export default async function portfolio(request, context) {
  const headers = { "Cache-Control": "no-store" };
  if (!["GET", "HEAD"].includes(request.method)) return Response.json({ error: "Method not allowed." }, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
  if (request.method === "HEAD") return new Response(null, { headers });
  try {
    const state = await netlifyStore().read();
    const configured = isProduction(context) && netlifyEnabled() && Boolean(process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET);
    const seen = state.lastRunAt !== null;
    const view = portfolioView(state, {
      status: !configured ? "setup_required" : !seen ? "waiting" : state.status,
      message: !configured ? "Add Alpaca paper API credentials in Netlify’s Functions environment and deploy to production to activate the schedule."
        : !seen ? "Configured. Waiting for the next scheduled trading-day check." : state.message,
      workerRunning: configured && seen,
    });
    return Response.json(view, { headers });
  } catch {
    return Response.json({ error: "Durable portfolio storage is unavailable. Check Netlify Blobs and function logs." }, { status: 503, headers });
  }
}
