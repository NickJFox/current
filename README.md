# Current Market

A React momentum scanner that ranks positively moving companies by session-adjusted relative volume and provides recent Nasdaq coverage as possible catalyst context.

## Local development

Requires Node.js 20 or newer.

```bash
npm ci
npm run dev
```

Open `http://localhost:5173`. Vite proxies the same API handlers used by production.

## Production check

```bash
npm test
npm run build
npm start
```

Open `http://localhost:3000` and verify:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/api/trending
```

## Deployment

### Netlify

The repository includes `netlify.toml` and native functions for both API routes. Connect the GitHub repository in Netlify and use the detected settings:

- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

The redirects in `netlify.toml` must remain above the SPA fallback so `/api/trending` and `/api/news/:symbol` return JSON instead of `index.html`.

### Render

1. Push this directory to a Git repository.
2. In Render, create a Blueprint and select the repository.
3. Render detects `render.yaml`, builds the Docker image, checks `/healthz`, and provides an HTTPS URL.
4. Add a custom domain in the Render dashboard if desired.

### Any container host

```bash
docker build -t current-market .
docker run --read-only --tmpfs /tmp -p 3000:3000 current-market
```

The container serves both the frontend and API from one origin. The host must allow outbound HTTPS requests to `api.nasdaq.com`.

## Operations and limitations

- Market and news results are cached for five minutes; stale results can be served for up to thirty minutes during a temporary upstream failure.
- API clients are limited per instance. Use a shared rate limiter and cache if scaling beyond one instance.
- `/healthz` is intended for platform health checks.
- Logs are structured JSON and should be connected to the hosting provider’s alerts.
- Nasdaq’s public endpoints used here are undocumented. Before commercial use, confirm data-display rights and migrate `server/market-data.js` to a contracted provider with a documented SLA.
- Relative volume is adjusted linearly by elapsed regular-session time. Historical intraday volume curves would provide a more accurate opening-bell comparison.
- News is labeled as possible context, not a proven cause of price movement.
