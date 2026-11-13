import { AlpacaPaper } from "./paper/alpaca.js";

const MINUTE = 60000;
let cached, pending;

// Compare complete clock-minute windows, never today's accumulated volume.
export function measureMomentum(rows, now = new Date()) {
  const end = Math.floor(now.getTime() / MINUTE) * MINUTE;
  const bars = [...new Map((rows || []).map((bar) => [Date.parse(bar.t), bar])).entries()]
    .filter(([t, b]) => t >= end - 25 * MINUTE && t < end && Number(b.v) > 0
      && Number(b.o) > 0 && Number(b.c) > 0)
    .sort((a, b) => a[0] - b[0]);
  const prior = bars.filter(([t]) => t < end - 5 * MINUTE);
  const recent = bars.filter(([t]) => t >= end - 5 * MINUTE);
  // Sparse or stale feeds must not masquerade as a current surge.
  if (prior.length < 10 || recent.length < 3 || recent.at(-1)[0] < end - 2 * MINUTE) return null;
  const volume = recent.reduce((sum, [, b]) => sum + Number(b.v), 0);
  const baseline = prior.reduce((sum, [, b]) => sum + Number(b.v), 0) / 4;
  const acceleration = volume / baseline;
  const price = Number(recent.at(-1)[1].c);
  const change = (price / Number(recent[0][1].o) - 1) * 100;
  const lastChange = (price / Number(recent.at(-1)[1].o) - 1) * 100;
  if (price < 2 || volume * price < 50000 || acceleration < 2 || change < 0.5 || lastChange < 0) return null;
  return { price, volume, acceleration, change, windowEnd: new Date(end).toISOString(),
    signalAt: new Date(recent.at(-1)[0] + MINUTE).toISOString() };
}

export async function scanLiveMomentum({ request, feed, now = new Date() }) {
  const discovery = await Promise.allSettled([
    request("/v1beta1/screener/stocks/most-actives?by=volume&top=100"),
    request("/v1beta1/screener/stocks/movers?top=50"),
  ]);
  const symbols = [...new Set(discovery.flatMap((r, i) => r.status === "fulfilled"
    ? (i === 0 ? r.value.most_actives || [] : r.value.gainers || []) : [])
    .map((s) => s.symbol).filter((s) => /^[A-Z0-9.-]{1,10}$/.test(s)))];
  if (!symbols.length) throw new Error("Current scanner universe unavailable.");
  const end = Math.floor(now.getTime() / MINUTE) * MINUTE;
  const params = new URLSearchParams({ symbols: symbols.join(","), timeframe: "1Min", feed,
    start: new Date(end - 25 * MINUTE).toISOString(), end: new Date(end).toISOString(),
    limit: "10000", sort: "asc", adjustment: "raw" });
  const bars = {};
  let token;
  const seen = new Set();
  do {
    if (token) params.set("page_token", token);
    const page = await request(`/v2/stocks/bars?${params}`);
    for (const [symbol, rows] of Object.entries(page.bars || {})) (bars[symbol] ||= []).push(...rows);
    token = page.next_page_token;
    if (token && seen.has(token)) throw new Error("Repeated market-data page.");
    seen.add(token);
  } while (token);
  const companies = symbols.flatMap((ticker) => {
    const signal = measureMomentum(bars[ticker], now);
    if (!signal) return [];
    return [{ ticker, name: ticker, category: "Live activity", mark: ticker.slice(0, 2), accent: "lime",
      momentum: "Accelerating now", ...signal,
      headline: `+${signal.change.toFixed(2)}% in five minutes · ${signal.acceleration.toFixed(1)}× volume acceleration`,
      reason: `${signal.volume.toLocaleString("en-US")} shares in five minutes`,
      context: `The latest five completed minutes traded ${signal.acceleration.toFixed(1)}× the five-minute pace of the preceding 20 minutes. Latest bar ended ${signal.signalAt}. A rising last minute is required; no minimum daily gain or accumulated daily volume is required.` }];
  }).sort((a, b) => b.acceleration - a.acceleration || b.change - a.change).slice(0, 12);
  const newest = Object.values(bars).flat().map((b) => Date.parse(b.t))
    .filter((t) => Number.isFinite(t) && t < end && t >= end - 2 * MINUTE);
  return { companies, updatedAt: newest.length ? new Date(Math.max(...newest) + MINUTE).toISOString() : null,
    fetchedAt: now.toISOString(), source: `Alpaca (${feed.toUpperCase()})`, stale: false,
    universe: "Most-active and top-gainer discovery only; may miss emerging stocks outside that universe. Five-minute price gain ≥0.5%, volume acceleration ≥2×, recent turnover ≥$50K. Includes pre/post-market when feed bars are available. IEX covers one exchange; SIP requires entitlement. No fresh bars means no current signals. Checks every 30 seconds; completed minute bars, not tick streaming." };
}

export async function getLiveMomentum() {
  if (cached && Date.now() - cached.at < 15000) return cached.data;
  if (pending) return pending;
  const provider = new AlpacaPaper();
  if (!provider.configured) throw new Error("Live momentum requires Alpaca market-data credentials.");
  if (!["iex", "sip"].includes(provider.feed)) throw new Error("Live momentum requires an undelayed IEX or SIP feed.");
  const signal = AbortSignal.timeout(20000);
  pending = scanLiveMomentum({ feed: provider.feed,
    request: (path) => provider.request(path, { data: true, signal }) })
    .then((data) => { cached = { at: Date.now(), data }; return data; })
    .finally(() => { pending = null; });
  return pending;
}
