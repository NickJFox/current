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

The repository includes `netlify.toml` and native functions for the market-data and portfolio API routes. Connect the GitHub repository in Netlify and use the detected settings:

- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

The redirects in `netlify.toml` must remain above the SPA fallback so `/api/trending`, `/api/news/:symbol`, and `/api/portfolio` return JSON instead of `index.html`.

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
- When Nasdaq omits average volume from quote summaries, the scanner averages up to 30 completed daily sessions (at least 10 required), excluding today. This baseline is cached per symbol for the Eastern calendar day.
- Nasdaq scans have a 12-second total budget and fetch daily history directly, avoiding redundant quote-summary requests. If Nasdaq fails and Alpaca credentials are configured, a read-only Alpaca market-data fallback uses the union of its 100 most-active stocks and 50 top gainers. It ranks positive movers using current volume and up to 30 completed daily bars from the same configured feed (IEX by default). This fallback retains the $2 price and 500K feed-share minimums, but cannot apply Nasdaq's market-cap screen. The scanner displays its source and universe, and each paper scan records them. Data entitlements can affect fallback availability.
- A valid scan with no qualifying stocks returns an empty result, distinct from provider errors. The browser refreshes the scanner every five minutes. Cached results are labeled stale and cannot trigger paper entries.
- News is labeled as possible context, not a proven cause of price movement.

## Automated paper portfolio

The **Performance** section shows a $10,000 virtual strategy sleeve in a dedicated
Alpaca paper account, open positions, trailing stops, orders, saved intraday signals,
observed drawdown, and a SPY benchmark. It refreshes every 30 seconds while open.
The background worker runs independently of visitors; no daily buttons or browser
sessions are required.

### One-time activation on Netlify

Keep the existing Netlify site and Git repository connection. The new functions
are deployed with the website; no Render service, cron service, or browser session
is needed. Netlify must support Background Functions on the site's plan (supported
on credit-based plans, including Free; check older legacy plans before deployment).
Scheduled/background function execution consumes your plan's usage credits.

In **Netlify > Project configuration > Environment variables**, add these secrets
with **Functions** scope in the **Production** context, then redeploy:

- `ALPACA_API_KEY`: a dedicated **paper** account's key.
- `ALPACA_API_SECRET`: that paper key's secret.

Never put secrets in Git or chat. Paper trading enables itself when these keys are
available, unless `PAPER_TRADING_ENABLED=false` is explicitly set. Preview and branch
deployments cannot run the trading worker. `ALPACA_DATA_FEED` defaults to `iex`.
Netlify provisions access to the site-wide Blobs store automatically; no database
credentials are needed. Deploying code and entering account credentials are
one-time activation steps; no daily action is required.

`paper-schedule` runs every minute during the weekday US market window, using UTC
cron coverage for both daylight-saving offsets and an Eastern-time guard. It
starts the signed `paper-worker-background` function, which can outlive the
scheduled function's shorter execution limit. Alpaca's calendar/clock filters
holidays and early closes. A durable writer lease prevents overlapping invocations.
The broker continues managing accepted stops between function runs.

The account must initially have no holdings or open orders and at least $10,000
simulated cash. Alpaca commonly initializes paper accounts with $100,000; the
strategy uses a $10,000 sleeve and leaves the surplus idle. Do not trade manually,
use another bot, reset, or change this account while the experiment runs: account
equity changes are the source of truth for portfolio value. The code fixes the
trading URL to `https://paper-api.alpaca.markets` and has no live-money endpoint.

After deployment with credentials, check `/api/portfolio`. `lastSuccessAt` must
advance during the scheduled window, and `status` should be `running` or
`market_closed`. Before credentials are supplied, the dashboard reports activation
required and never substitutes fake results. Broker integration and unattended
cloud execution must be verified with real paper credentials after deployment.

### Optional Node / Render hosting

The existing standalone Node server also supports the worker, with
`PAPER_TRADING_ENABLED=true` and a durable `PAPER_STATE_PATH`. `render.yaml` declares
an always-on service and a persistent disk at `/app/data`. Run exactly one worker
against a paper account: **never enable Netlify and Render/local workers against
the same account**. They use different ledgers and cannot coordinate ownership.
Keep the disk across deployments. Optional paid hosting and disks incur charges.

### Strategy rules (version 2: all-day paper trading)

- Use Alpaca's clock and exchange calendar for holidays, DST, and shortened days.
- Run a fresh momentum scan every five minutes starting 15 minutes after the
  regular session opens, until 10 minutes before the exchange closes (normally
  9:45 through 15:45 New York, with entries ending at 15:50). Temporary failures
  retry within their five-minute slot. Missed slots are never backfilled; a worker
  recovering in the afternoon can use the current slot's fresh signals.
- Save the ranked list, relative volume, scan time, source time, and each decision.
  Each intraday scan records strategy version 2; the 3% stop stays unchanged.
  Earlier morning-only history is preserved.
- Split 98% of available strategy cash equally across stocks not already held or attempted that day.
  Reserve outstanding buy commitments before sizing the next scan.
  Buy whole shares with a day limit at most 0.5% above a fresh ask, rounded up to a
  cent. Unsupported symbols, stale quotes, or an allocation smaller than one share
  are recorded as skips. Spare cash and sale proceeds are eligible next scan.
  No borrowing or pyramiding. Unfilled entries are canceled at the end of their
  five-minute scan window; uncertain orders remain reserved until reconciled.
- Reconcile fills each scheduled minute (15 seconds on the optional standalone
  server). Attach a 3% GTC trailing
  sell-stop after a fill. Cancel a partial entry's remainder before sizing its
  protective exit. Stop protection begins when the broker accepts the stop,
  so a fill can remain unprotected until the next successful reconciliation.
  Netlify performs an immediate second reconciliation after the entry cycle.
- Keep positions overnight. Stops trigger during regular trading hours only;
  overnight gaps can produce larger losses. Once accepted, the broker manages
  the trailing stop even if this server is down. Expired/canceled stops are
  recreated automatically. A definitively rejected stop triggers an automatic
  paper market-exit attempt on the next cycle.
- A stock can be purchased again on a later trading day, at most one entry attempt per symbol per
  day across all scans. Already-held stocks are skipped. Proceeds become eligible
  at the next scan; simulated cash limitations can leave later signals unpurchased.
- SPY is a **price-return proxy** for the S&P 500, with fractional shadow shares,
  the same $10,000 starting capital, and a fresh bid at experiment start. It stays
  fully invested even while the strategy holds cash. Both reported returns exclude
  dividends and additional transaction costs; this is not an index total-return
  comparison or proof of achievable live profits. Alpaca paper fills have their
  own fill assumptions and do not model every real trading cost.
  On version 2 activation, save current sleeve equity and a fresh SPY price as
  a separate comparison baseline. The dashboard reports both returns and their
  percentage-point difference since that moment, excluding earlier strategy
  returns. Existing holdings carry into the new period; lifetime metrics and
  the lifetime chart retain the full history.
- IEX quotes are the default and represent one venue, while Nasdaq supplies scanner
  data with Alpaca market data as a fallback during Nasdaq failures. The fallback
  compares IEX volume only with IEX historical volume (or SIP with SIP).
  Set `ALPACA_DATA_FEED=sip` only with the appropriate Alpaca entitlement.
  The UI displays the benchmark quote timestamp and delayed updates.

### Reliability and storage

Netlify uses the site-wide `momentum-paper-portfolio` Blobs store, preserving history
across deploys. Strong reads, conditional ETag writes, and readback verification
protect saved state. A 16-minute lease outlives the 15-minute Background Functions
execution limit, so an invocation killed by Netlify recovers automatically after
lease expiry. Normal runs release their lease immediately. A crash can therefore
miss intraday scan slots; accepted broker stops remain independent of it.
The schedule is production-only and the background writer requires a signed,
time-limited request. The public portfolio endpoint is read-only and excludes
account IDs and secrets; it exposes simulated performance to website visitors.


Order intents are durably saved before submission. Deterministic client order IDs
allow recovery from a lost response without placing duplicate orders. Restarts
reconcile known orders before scanning or attaching missing protection. Unexpected
accounts, holdings, or open orders stop new activity and appear as dashboard
errors. All errors retry automatically; there is no guarantee that a provider or
credential failure can resolve itself. Existing accepted broker stops remain at
the broker when the app cannot reach it.

On standalone Node hosts, the ledger is atomically replaced and file-synced. A process lock prevents two
local workers from sharing it. Preserve and back up the disk; do not delete or
restore the ledger independently of the paper account. A corrupt ledger fails
closed instead of silently starting a new experiment. Render offers disk snapshots;
restoring an old ledger requires reconciling orders created since that snapshot.
Hourly chart marks and the running maximum observed drawdown are retained; marks
missed during downtime cannot be reconstructed from a live-only ledger.

For local development, set the variables in the launching shell (or use Node's
`--env-file` support). Vite does not load server secrets from `.env` into
`process.env` automatically. `npm run dev` starts the worker only when explicitly
enabled. Stop the local worker before starting production against the same account.
Running only on a laptop is not unattended cloud hosting.

Provider references: [Netlify scheduling](https://docs.netlify.com/build/functions/scheduled-functions/),
[background execution](https://docs.netlify.com/build/functions/background-functions/),
[durable storage](https://docs.netlify.com/build/data-and-storage/netlify-blobs/), and
[Alpaca paper fill limitations](https://docs.alpaca.markets/us/docs/paper-trading).
