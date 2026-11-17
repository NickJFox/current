import { getTrendingCompanies } from "../../server/market-data.js";

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

  try {
    const data = await getTrendingCompanies();
    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: event.httpMethod === "HEAD" ? "" : JSON.stringify(data),
    };
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      event: "netlify_trending_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    }));
    return {
      statusCode: 502,
      headers: { ...jsonHeaders, "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Live market data is temporarily unavailable." }),
    };
  }
}
