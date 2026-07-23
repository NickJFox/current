import { getCompanyNews } from "../../server/market-data.js";

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=60, stale-while-revalidate=240",
};

export async function handler(event) {
  if (event.httpMethod !== "GET" && event.httpMethod !== "HEAD") {
    return {
      statusCode: 405,
      headers: { ...jsonHeaders, Allow: "GET, HEAD" },
      body: JSON.stringify({ error: "Method not allowed." }),
    };
  }

  const symbol = event.path.split("/").filter(Boolean).at(-1)?.toUpperCase() || "";
  if (!/^[A-Z0-9.-]{1,10}$/.test(symbol)) {
    return {
      statusCode: 400,
      headers: { ...jsonHeaders, "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Invalid stock symbol." }),
    };
  }

  try {
    const data = await getCompanyNews(symbol);
    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: event.httpMethod === "HEAD" ? "" : JSON.stringify(data),
    };
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "netlify_news_failed",
      symbol,
      message: error instanceof Error ? error.message : "Unknown error",
    }));
    return {
      statusCode: 502,
      headers: { ...jsonHeaders, "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Recent news is temporarily unavailable." }),
    };
  }
}
