// Read-only market-data fallback. All volume comparisons use the same feed.
export async function alpacaScan({ request, feed = "iex", now = new Date(), progress }) {
  const [active, movers] = await Promise.allSettled([
    request("/v1beta1/screener/stocks/most-actives?by=volume&top=100"),
    request("/v1beta1/screener/stocks/movers?top=50"),
  ]);
  const symbols = [...new Set([
    ...(active.status === "fulfilled" ? active.value.most_actives || [] : []),
    ...(movers.status === "fulfilled" ? movers.value.gainers || [] : []),
  ].map((row) => row.symbol).filter((symbol) => /^[A-Z0-9.-]{1,10}$/.test(symbol)))];
  if (!symbols.length) throw new Error("Alpaca scanner universe unavailable; check market-data permissions.");
  const snapshots = await request(`/v2/stocks/snapshots?${new URLSearchParams({ symbols: symbols.join(","), feed })}`);
  const eligible = symbols.map((symbol) => {
    const snapshot = snapshots[symbol];
    const price = Number(snapshot?.latestTrade?.p), previous = Number(snapshot?.prevDailyBar?.c);
    const volume = Number(snapshot?.dailyBar?.v);
    const timestamp = snapshot?.latestTrade?.t;
    const age = now.getTime() - Date.parse(timestamp);
    return { symbol, price, previous, volume, timestamp, age };
  }).filter((item) => item.price >= 2 && item.previous > 0 && item.price > item.previous
    && item.volume >= 500000 && Number.isFinite(item.age) && item.age >= -5000
    && (progress === 1 || item.age <= 90000))
    .sort((a, b) => b.volume * b.price - a.volume * a.price).slice(0, 40);
  if (!eligible.length) return { items: [], sourceAt: now.toISOString() };
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const end = new Date(`${day}T00:00:00Z`);
  const start = new Date(end.getTime() - 65 * 86400000);
  const params = new URLSearchParams({ symbols: eligible.map((s) => s.symbol).join(","),
    timeframe: "1Day", start: start.toISOString(), end: end.toISOString(),
    adjustment: "all", feed, limit: "10000", sort: "desc" });
  const bars = {};
  let pageToken;
  // Historical results are grouped by symbol; follow pages so later symbols
  // cannot silently lose their baselines. Never average today's partial bar.
  do {
    if (pageToken) params.set("page_token", pageToken);
    const page = await request(`/v2/stocks/bars?${params}`);
    for (const [symbol, rows] of Object.entries(page.bars || {})) (bars[symbol] ||= []).push(...rows);
    pageToken = page.next_page_token;
  } while (pageToken);
  let baselines = 0;
  const items = eligible.flatMap((item) => {
    const history = (bars[item.symbol] || []).filter((bar) => bar.t < end.toISOString() && Number(bar.v) > 0)
      .sort((a, b) => b.t.localeCompare(a.t)).slice(0, 30);
    if (history.length < 10) return [];
    baselines++;
    const averageVolume = history.reduce((sum, bar) => sum + Number(bar.v), 0) / history.length;
    return [{ stock: { symbol: item.symbol, name: item.symbol, sector: "Other", industry: `Alpaca ${feed.toUpperCase()} feed`,
      lastsale: item.price, volume: item.volume, pctchange: (item.price / item.previous - 1) * 100 },
      averageVolume, timestamp: item.timestamp }];
  });
  if (!baselines) throw new Error("Alpaca historical volume baselines unavailable.");
  return { items, sourceAt: items.map((item) => item.timestamp).sort()[0] };
}
