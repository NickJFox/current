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

The container serves both the frontend and API from one origin. The host must allow outbound HTTPS requests to `data.alpaca.markets`, `paper-api.alpaca.markets`, and `api.nasdaq.com`.

## Operations and limitations

- The live scanner refreshes every 30 seconds, uses a 15-second server cache and returns no-store responses. It never falls back to stale daily-volume signals. News and the legacy `/api/trending` endpoint retain their five-minute caches and up-to-thirty-minute stale fallback.
- API clients are limited per instance. Use a shared rate limiter and cache if scaling beyond one instance.
- `/healthz` is intended for platform health checks. Logs are structured JSON.
- The live scanner and paper strategy require Alpaca credentials and an undelayed IEX or entitled SIP feed. Discovery is limited to most-active/top-gainer lists. IEX represents one exchange, and sparse trading can prevent a signal from qualifying.
- The legacy daily-volume endpoint remains available without `mode=live`; it uses Nasdaq with Alpaca fallback. It does not drive the displayed scanner or paper entries.
- A valid scan with no qualifying stocks returns an empty result, distinct from provider errors. Only fresh signals may trigger paper entries.
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

### Strategy rules (version 3: live momentum)

- Paper trading and the discovery screen both use `getLiveMomentum`, with the
  same five-minute price gain and volume-acceleration filters described below.
  Daily-volume rankings are no longer used for paper entries.
- Scan approximately every 30 seconds from the regular open until 10 minutes
  before the exchange closes. The exchange calendar handles shortened sessions.
  The scanner can display extended-hours activity; paper entries are regular-hours
  only because the existing broker-hosted trailing stops do not trigger outside
  regular hours. No delayed signals or missed scan slots are backfilled.
- Save rank, acceleration, five-minute gain, bar timestamp, source and each
  purchase decision. New entry windows expire after 30 seconds. Whole shares,
  cash-only sizing, a limit cap 0.5% above a fresh ask, and one entry attempt per
  symbol per day remain in effect. Split 98% of available strategy cash across
  eligible candidates, reserving unresolved buy commitments. Already-held stocks
  are skipped. Sale proceeds can be used at the next scan.
- Reconcile fills and attach 3% GTC trailing stops immediately when possible.
  The standalone worker checks every 15 seconds. The Netlify minute schedule
  starts a background worker that reconciles immediately, then again after
  30 seconds. Slow requests, scheduling delays or an active writer lease can
  delay checks. Cancel partial entry remainders before attaching stops. Positions
  may remain overnight; stops trigger in regular hours and can fill below their
  trigger after a gap. Definitively rejected protection triggers a market-exit
  attempt on the next cycle.
- On the first enabled worker cycle after upgrading from an older strategy, a
  one-time reset cancels known legacy orders and closes known legacy paper
  holdings in regular market hours. It waits for cancellations and exits before
  deleting portfolio history. Unexpected holdings/orders or a different account
  stop the reset. Durable exit IDs recover interrupted or uncertain submissions.
- After the account is flat, replace the old app ledger with a fresh $10,000
  strategy sleeve, new order-ID namespace, no trades/history/drawdown, and a new
  account baseline. The next eligible scan starts the SPY comparison at the same
  $10,000. Old performance does not carry forward. This resets app tracking;
  Alpaca's own account activity remains in its broker history and its cash balance
  is not reset. At least $10,000 simulated cash must remain after liquidation.
- SPY is a price-return proxy. Dividends and additional transaction costs are
  excluded. IEX covers one exchange; SIP requires the appropriate entitlement.
  Paper fills are simulations. Discovery coverage remains limited to the
  provider's most-active and top-gainer universe.

### Reliability and storage

Netlify uses the site-wide `momentum-paper-portfolio` Blobs store, preserving the current strategy history
across deploys. The version 3 migration clears the prior strategy after liquidation. Strong reads, conditional ETag writes, and readback verification
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

### Happening-now scanner

The discovery screen requests `/api/trending?mode=live` every 30 seconds. This
scanner is shared by the version 3 paper strategy.
It compares the latest five completed one-minute bars with the preceding 20
clock minutes, requiring ≥2× volume acceleration, ≥0.5% five-minute price gain,
a non-falling last minute, price ≥$2, and ≥$50K recent dollar volume. It does
not require 500K accumulated shares or a positive change from yesterday.
Signals expire when recent bars stop arriving; stale daily data is never used
as a live fallback. A minimum of 10 baseline bars and three recent bars is
required, so sparse feeds and the first minutes of a session can be excluded.

Requires `ALPACA_API_KEY`, `ALPACA_API_SECRET`, and an undelayed
`ALPACA_DATA_FEED=iex` or entitled `sip`. IEX represents one exchange.
Premarket/after-hours bars are evaluated when available; overnight coverage
is not provided. Discovery is limited to the provider's most-active/top-gainer
universe and can miss emerging symbols. This is minute-bar polling, not a
market-wide streaming alert service. API responses use no-store and the server
coalesces requests with a 15-second cache. No old signals are served on failure.
