import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { BlobStore } from "./blob-store.js";

export function netlifyStore() {
  return new BlobStore(getStore({ name: "momentum-paper-portfolio", consistency: "strong" }));
}
export function isProduction() { return process.env.CONTEXT === "production"; }
export function netlifyEnabled() { return process.env.PAPER_TRADING_ENABLED !== "false"; }
export function signature(timestamp, secret = process.env.ALPACA_API_SECRET) {
  return createHmac("sha256", secret).update(`momentum-paper-worker:v1:${timestamp}`).digest("hex");
}
export function authorized(request, now = Date.now(), secret = process.env.ALPACA_API_SECRET) {
  const timestamp = request.headers.get("x-paper-timestamp");
  const supplied = request.headers.get("x-paper-signature") || "";
  if (!secret || !/^\d{13}$/.test(timestamp || "") || Math.abs(now - Number(timestamp)) > 5 * 60_000 || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(signature(timestamp, secret), "hex"), Buffer.from(supplied, "hex"));
}
