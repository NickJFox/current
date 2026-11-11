import { easternTime } from "../../server/paper/engine.js";
import { isProduction, netlifyEnabled, signature } from "../../server/paper/netlify.js";

// Scheduled functions have a short timeout: dispatch to a signed background job.
export default async function schedule() {
  if (!isProduction() || !netlifyEnabled() || !process.env.ALPACA_API_KEY || !process.env.ALPACA_API_SECRET) return;
  const now = new Date();
  const { minute } = easternTime(now);
  if (minute < 9 * 60 + 25 || minute > 16 * 60 + 10) return;
  const origin = new URL(process.env.URL);
  if (origin.protocol !== "https:") throw new Error("A production HTTPS site URL is required.");
  const timestamp = String(now.getTime());
  const response = await fetch(new URL("/.netlify/functions/paper-worker-background", origin), {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { "x-paper-timestamp": timestamp, "x-paper-signature": signature(timestamp) },
  });
  if (response.status !== 202) throw new Error(`Background worker dispatch failed: HTTP ${response.status}`);
}

export const config = { schedule: "* 13-21 * * 1-5" };
