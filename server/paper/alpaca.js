const PAPER = "https://paper-api.alpaca.markets";
const DATA = "https://data.alpaca.markets";

export class ProviderError extends Error {
  constructor(status, operation) {
    super(`Paper provider ${operation} returned HTTP ${status}.`);
    this.status = status;
  }
}

export class AlpacaPaper {
  constructor({ key = process.env.ALPACA_API_KEY, secret = process.env.ALPACA_API_SECRET,
    feed = process.env.ALPACA_DATA_FEED || "iex", fetcher = fetch } = {}) {
    this.key = key; this.secret = secret; this.feed = feed; this.fetcher = fetcher;
  }
  get configured() { return Boolean(this.key && this.secret); }
  async request(path, { method = "GET", body, data = false, signal } = {}) {
    // Trading origin is deliberately fixed: this code cannot place live-money orders.
    const response = await this.fetcher(`${data ? DATA : PAPER}${path}`, {
      method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
      headers: { "APCA-API-KEY-ID": this.key, "APCA-API-SECRET-KEY": this.secret,
        "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new ProviderError(response.status, path.split("?")[0]);
    return response.status === 204 ? null : response.json();
  }
  account() { return this.request("/v2/account"); }
  clock() { return this.request("/v2/clock"); }
  calendar(day) { return this.request(`/v2/calendar?start=${day}&end=${day}`); }
  positions() { return this.request("/v2/positions"); }
  openOrders() { return this.request("/v2/orders?status=open&limit=500"); }
  async order(clientId) {
    try { return await this.request(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientId)}`); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  submit(body) { return this.request("/v2/orders", { method: "POST", body }); }
  cancel(id) { return this.request(`/v2/orders/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  asset(symbol) { return this.request(`/v2/assets/${encodeURIComponent(symbol)}`); }
  async quote(symbol) {
    const result = await this.request(`/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=${this.feed}`, { data: true });
    return result.quote;
  }
}
