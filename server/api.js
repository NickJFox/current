import { getCompanyNews, getTrendingCompanies } from "./market-data.js";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_PER_MINUTE || 90);
const clients = new Map();

function clientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  return String(Array.isArray(forwarded) ? forwarded[0] : forwarded || request.socket?.remoteAddress || "")
    .split(",")[0]
    .trim();
}

function isRateLimited(request) {
  const now = Date.now();
  if (clients.size > 10_000) {
    for (const [key, value] of clients) {
      if (now - value.startedAt >= WINDOW_MS) clients.delete(key);
    }
  }
  const ip = clientIp(request);
  const entry = clients.get(ip);
  if (!entry || now - entry.startedAt >= WINDOW_MS) {
    clients.set(ip, { count: 1, startedAt: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_REQUESTS;
}

function sendJson(response, status, data, cacheControl = "no-store") {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", cacheControl);
  response.end(JSON.stringify(data));
}

export async function handleApiRequest(request, response) {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (!pathname.startsWith("/api/")) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendJson(response, 405, { error: "Method not allowed." });
    return true;
  }
  if (isRateLimited(request)) {
    response.setHeader("Retry-After", "60");
    sendJson(response, 429, { error: "Too many requests. Please try again shortly." });
    return true;
  }

  try {
    let data;
    if (pathname === "/api/trending") {
      data = await getTrendingCompanies();
    } else {
      const match = pathname.match(/^\/api\/news\/([A-Za-z0-9.-]{1,10})$/);
      if (!match) {
        sendJson(response, 404, { error: "Not found." });
        return true;
      }
      data = await getCompanyNews(match[1]);
    }
    sendJson(response, 200, request.method === "HEAD" ? {} : data, "public, max-age=60, stale-while-revalidate=240");
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "api_request_failed",
      path: pathname,
      message: error instanceof Error ? error.message : "Unknown error",
    }));
    sendJson(response, 502, {
      error: pathname.startsWith("/api/news/")
        ? "Recent news is temporarily unavailable."
        : "Live market data is temporarily unavailable.",
    });
  }
  return true;
}
