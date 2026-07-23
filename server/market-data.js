const NASDAQ_BASE = "https://api.nasdaq.com/api";
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const STALE_TTL = Number(process.env.STALE_TTL_MS || 30 * 60 * 1000);
const REQUEST_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS || 8_000);
const USER_AGENT = process.env.UPSTREAM_USER_AGENT || "CurrentMarketApp/1.0";

const state = {
  trending: null,
  trendingAt: 0,
  trendingRequest: null,
  news: new Map(),
};

export function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (!value || value === "N/A") return 0;
  const normalized = String(value).replace(/[$,%\s,]/g, "");
  const suffix = normalized.slice(-1).toUpperCase();
  const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed * (multipliers[suffix] || 1) : 0;
}
async function fetchJson(url, attempts = 2) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        headers: {
          accept: "application/json, text/plain, */*",
          "user-agent": USER_AGENT,
        },
      });
      if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

function categoryFor(sector = "") {
  const categories = {
    Technology: "Technology",
    "Health Care": "Health",
    "Consumer Discretionary": "Consumer",
    "Consumer Staples": "Consumer",
    Financials: "Finance",
    Energy: "Energy",
    Utilities: "Energy",
    Industrials: "Industrial",
    Telecommunications: "Communications",
    "Real Estate": "Real Estate",
  };
  return categories[sector] || sector || "Other";
}

function momentumLabel(relativeVolume) {
  if (relativeVolume >= 5) return "Exceptional volume";
  if (relativeVolume >= 3) return "Volume surge";
  if (relativeVolume >= 2) return "Unusual activity";
  return "Above normal";
}

function formatVolume(volume) {
  if (volume >= 1e9) return `${(volume / 1e9).toFixed(1)}B`;
  if (volume >= 1e6) return `${(volume / 1e6).toFixed(1)}M`;
  if (volume >= 1e3) return `${(volume / 1e3).toFixed(0)}K`;
  return String(volume);
}

export function regularSessionProgress(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  if (["Sat", "Sun"].includes(value("weekday"))) return 1;
  const minutes = Number(value("hour")) * 60 + Number(value("minute"));
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  if (minutes <= open || minutes >= close) return 1;
  return Math.max((minutes - open) / (close - open), 0.1);
}

function toCompany(stock, index, relativeVolume, averageVolume) {
  const change = parseNumber(stock.pctchange);
  const price = parseNumber(stock.lastsale);
  const volume = parseNumber(stock.volume);
  const category = categoryFor(stock.sector);
  const industry = stock.industry && stock.industry !== "N/A" ? stock.industry : category;
  const accents = ["lime", "violet", "coral", "blue", "green", "yellow", "slate", "orange"];
  const shortName = stock.name.replace(/\s+(Common Stock|Ordinary Shares|Class [A-Z])$/i, "").trim();
  return {
    ticker: stock.symbol,
    name: shortName,
    category,
    momentum: momentumLabel(relativeVolume),
    accent: accents[index % accents.length],
    mark: stock.symbol.slice(0, 2),
    headline: `${formatVolume(volume)} shares have traded today, running at ${relativeVolume.toFixed(1)}× the stock’s normal volume pace.`,
    context: `The recent average is ${formatVolume(averageVolume)} shares per full trading day. The stock last traded at $${price.toFixed(2)}, up ${change.toFixed(2)}%. Relative volume is adjusted for how much of today’s regular session has elapsed.`,
    reason: `${relativeVolume.toFixed(1)}× relative volume · ${formatVolume(volume)} today · ${industry}`,
    change,
    price,
    volume,
    relativeVolume,
    averageVolume,
  };
}

async function addAverageVolume(item) {
  try {
    const payload = await fetchJson(
      `${NASDAQ_BASE}/quote/${encodeURIComponent(item.stock.symbol)}/summary?assetclass=stocks`,
      1,
    );
    const averageVolume = parseNumber(payload?.data?.summaryData?.AverageVolume?.value);
    return averageVolume ? { ...item, averageVolume } : null;
  } catch {
    return null;
  }
}

async function enrichInBatches(items, batchSize = 8) {
  const enriched = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = await Promise.all(items.slice(index, index + batchSize).map(addAverageVolume));
    enriched.push(...batch.filter(Boolean));
  }
  return enriched;
}

async function refreshTrending() {
  const payload = await fetchJson(
    `${NASDAQ_BASE}/screener/stocks?tableonly=true&limit=25&offset=0&download=true`,
  );
  const rows = payload?.data?.rows;
  if (!Array.isArray(rows)) throw new Error("Invalid screener response");

  const eligible = rows
    .map((stock) => ({
      stock,
      change: parseNumber(stock.pctchange),
      volume: parseNumber(stock.volume),
      marketCap: parseNumber(stock.marketCap),
      price: parseNumber(stock.lastsale),
    }))
    .filter(({ stock, volume, marketCap, price }) =>
      stock?.symbol &&
      stock?.name &&
      stock?.sector &&
      volume >= 500_000 &&
      marketCap >= 300_000_000 &&
      price >= 2,
    )
    .map((item) => ({ ...item, turnover: (item.volume * item.price) / item.marketCap }))
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, 40);

  const sessionProgress = regularSessionProgress();
  const enriched = await enrichInBatches(eligible);
  const companies = enriched
    .map((item) => ({
      ...item,
      relativeVolume: item.volume / (item.averageVolume * sessionProgress),
    }))
    .filter((item) => item.relativeVolume >= 1 && item.change > 0)
    .sort((a, b) => b.relativeVolume - a.relativeVolume)
    .slice(0, 12)
    .map(({ stock, relativeVolume, averageVolume }, index) =>
      toCompany(stock, index, relativeVolume, averageVolume),
    );
  if (!companies.length) throw new Error("No qualifying companies returned");

  return {
    companies,
    updatedAt: new Date().toISOString(),
    source: "Nasdaq",
    sessionAdjusted: sessionProgress < 1,
    stale: false,
  };
}

export async function getTrendingCompanies() {
  const age = Date.now() - state.trendingAt;
  if (state.trending && age < CACHE_TTL) return state.trending;
  if (state.trendingRequest) return state.trendingRequest;

  state.trendingRequest = refreshTrending()
    .then((data) => {
      state.trending = data;
      state.trendingAt = Date.now();
      return data;
    })
    .catch((error) => {
      if (state.trending && age < STALE_TTL) return { ...state.trending, stale: true };
      throw error;
    })
    .finally(() => {
      state.trendingRequest = null;
    });
  return state.trendingRequest;
}

export async function getCompanyNews(symbol) {
  const normalized = symbol.toUpperCase();
  if (!/^[A-Z0-9.-]{1,10}$/.test(normalized)) throw new Error("Invalid symbol");
  const cached = state.news.get(normalized);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) return cached.data;

  try {
    const payload = await fetchJson(
      `${NASDAQ_BASE}/news/topic/articlebysymbol?q=${encodeURIComponent(`${normalized}|stocks`)}&offset=0&limit=5`,
    );
    const rows = payload?.data?.rows;
    if (!Array.isArray(rows)) throw new Error("Invalid news response");
    const articles = rows.slice(0, 5).map((article) => ({
      id: article.id,
      title: String(article.title || ""),
      description: String(article.description || ""),
      publisher: String(article.publisher || "Nasdaq"),
      created: String(article.created || ""),
      ago: String(article.ago || ""),
      url: article.url?.startsWith("http")
        ? article.url
        : `https://www.nasdaq.com${article.url || ""}`,
    })).filter((article) => article.title && article.url);
    const data = { symbol: normalized, articles, updatedAt: new Date().toISOString(), stale: false };
    state.news.set(normalized, { data, cachedAt: Date.now() });
    return data;
  } catch (error) {
    if (cached && Date.now() - cached.cachedAt < STALE_TTL) {
      return { ...cached.data, stale: true };
    }
    throw error;
  }
}
