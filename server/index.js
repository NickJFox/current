import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApiRequest } from "./api.js";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function securityHeaders(response) {
  response.setHeader("Content-Security-Policy",
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (process.env.NODE_ENV === "production") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function serveFile(request, response, path) {
  response.statusCode = 200;
  response.setHeader("Content-Type", mime[extname(path)] || "application/octet-stream");
  response.setHeader(
    "Cache-Control",
    extname(path) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  );
  if (request.method === "HEAD") return response.end();
  createReadStream(path).pipe(response);
}

const server = createServer(async (request, response) => {
  securityHeaders(response);

  if (request.url === "/healthz") {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (await handleApiRequest(request, response)) return;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.end("Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.statusCode = 400;
    response.end("Bad request");
    return;
  }
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const requested = join(root, safePath);
  if (requested.startsWith(root) && existsSync(requested) && statSync(requested).isFile()) {
    serveFile(request, response, requested);
    return;
  }
  serveFile(request, response, join(root, "index.html"));
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ level: "info", event: "server_started", host, port }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ level: "info", event: "server_stopping", signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
