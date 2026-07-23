import { useCallback, useEffect, useMemo, useState } from "react";

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function BookmarkIcon({ filled = false }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={filled ? "is-filled" : ""}>
      <path d="M6.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v17L12 18l-5.5 3.5z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function App() {
  const [companies, setCompanies] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [saved, setSaved] = useState([]);
  const [selected, setSelected] = useState(null);
  const [news, setNews] = useState([]);
  const [newsStatus, setNewsStatus] = useState("idle");
  const [newsError, setNewsError] = useState("");

  const loadCompanies = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const response = await fetch("/api/trending");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load market data.");
      setCompanies(payload.companies);
      setUpdatedAt(payload.updatedAt);
      setStatus("ready");
    } catch (loadError) {
      setError(loadError.message);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  useEffect(() => {
    if (!selected) {
      setNews([]);
      setNewsStatus("idle");
      setNewsError("");
      return;
    }

    const controller = new AbortController();
    async function loadNews() {
      setNews([]);
      setNewsStatus("loading");
      setNewsError("");
      try {
        const response = await fetch(`/api/news/${encodeURIComponent(selected.ticker)}`, {
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load recent news.");
        setNews(payload.articles || []);
        setNewsStatus("ready");
      } catch (loadError) {
        if (loadError.name !== "AbortError") {
          setNewsError(loadError.message);
          setNewsStatus("error");
        }
      }
    }
    loadNews();
    return () => controller.abort();
  }, [selected]);

  const filters = useMemo(
    () => ["All", ...new Set(companies.map((company) => company.category))],
    [companies],
  );

  const visibleCompanies = useMemo(() => {
    const term = query.trim().toLowerCase();
    return companies.filter((company) => {
      const matchesFilter = filter === "All" || company.category === filter;
      const matchesSearch =
        !term ||
        [company.name, company.ticker, company.category, company.headline, company.reason]
          .join(" ")
          .toLowerCase()
          .includes(term);
      return matchesFilter && matchesSearch;
    });
  }, [companies, filter, query]);

  function toggleSaved(ticker) {
    setSaved((current) =>
      current.includes(ticker) ? current.filter((item) => item !== ticker) : [...current, ticker],
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Current home">
          <span className="brand-mark">C</span>
          <span>Current</span>
        </a>

        <nav aria-label="Primary navigation">
          <a className="active" href="#discover">Discover</a>
          <a href="#saved">Saved <span>{saved.length}</span></a>
        </nav>

        <p className="market-note">
          <i /> {updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Loading live market data"}
        </p>
      </header>

      <main id="top">
        <section className="hero" id="discover">
          <p className="kicker">Volume signals, without the noise</p>
          <h1>See what companies<br />people are talking about.</h1>
          <p className="hero-copy">
            Find companies rising while trading above their normal volume.
          </p>
        </section>

        <section className="feed-section">
          <div className="feed-head">
            <div>
              <p className="section-label">Relative volume now</p>
              <h2>Where positive momentum is building</h2>
            </div>
            <p>Positive price movers ranked by today’s volume pace versus their own daily average.</p>
          </div>

          {status === "loading" && (
            <div className="loading-state" role="status">
              <span className="loading-spinner" />
              Finding where trading attention is concentrating…
            </div>
          )}

          {status === "error" && (
            <div className="empty-state">
              <strong>Market data is unavailable</strong>
              <p>{error}</p>
              <button type="button" onClick={loadCompanies}>Try again</button>
            </div>
          )}

          {status === "ready" && <div className="company-grid">
            {visibleCompanies.map((company) => (
              <article className="company-card" key={company.ticker}>
                <div className="card-top">
                  <div className={`company-logo accent-${company.accent}`}>{company.mark}</div>
                  <button
                    className="bookmark-button"
                    type="button"
                    aria-label={`${saved.includes(company.ticker) ? "Remove" : "Save"} ${company.name}`}
                    onClick={() => toggleSaved(company.ticker)}
                  >
                    <BookmarkIcon filled={saved.includes(company.ticker)} />
                  </button>
                </div>

                <div className="company-title">
                  <div>
                    <h3>{company.name}</h3>
                    <span>{company.ticker} · {company.category}</span>
                  </div>
                  <span className="trend-tag"><i /> {company.momentum}</span>
                </div>

                <p className="headline">{company.headline}</p>

                <footer>
                  <span>{company.reason}</span>
                  <button type="button" onClick={() => setSelected(company)}>
                    Why now <ArrowIcon />
                  </button>
                </footer>
              </article>
            ))}
          </div>}

          {status === "ready" && visibleCompanies.length === 0 && (
            <div className="empty-state">
              <strong>No companies found</strong>
              <p>Try a different company, ticker, or topic.</p>
              <button type="button" onClick={() => { setQuery(""); setFilter("All"); }}>Clear search</button>
            </div>
          )}
        </section>

        <section className="footer-note">
          <p>Keep exploring.</p>
          <h2>Attention is a starting point,<br />not an answer.</h2>
          <span>Always do your own research before making financial decisions.</span>
        </section>
      </main>

      {selected && (
        <div className="detail-backdrop" role="presentation" onMouseDown={() => setSelected(null)}>
          <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label={`Why ${selected.name} is trending`} onMouseDown={(event) => event.stopPropagation()}>
            <button className="close-button" type="button" onClick={() => setSelected(null)} aria-label="Close">×</button>
            <div className={`company-logo accent-${selected.accent}`}>{selected.mark}</div>
            <p className="section-label">Why now</p>
            <h2>{selected.name}</h2>
            <span className="drawer-meta">{selected.ticker} · {selected.category} · {selected.momentum}</span>
            <p className="drawer-headline">{selected.headline}</p>
            <p className="drawer-context">{selected.context}</p>
            <div className="drawer-topic">
              <span>What’s driving attention</span>
              <strong>{selected.reason}</strong>
            </div>
            <section className="news-section" aria-labelledby="possible-catalysts">
              <div className="news-heading">
                <span id="possible-catalysts">Possible catalysts</span>
                <small>Recent coverage, not confirmed causes</small>
              </div>
              {newsStatus === "loading" && (
                <p className="news-message"><span className="loading-spinner" /> Loading recent stories…</p>
              )}
              {newsStatus === "error" && <p className="news-message">{newsError}</p>}
              {newsStatus === "ready" && news.length === 0 && (
                <p className="news-message">No recent related stories were found.</p>
              )}
              {newsStatus === "ready" && news.length > 0 && (
                <div className="news-list">
                  {news.map((article) => (
                    <a href={article.url} target="_blank" rel="noreferrer" key={article.id || article.url}>
                      <span>{article.publisher} · {article.ago || article.created}</span>
                      <strong>{article.title}</strong>
                      <ArrowIcon />
                    </a>
                  ))}
                </div>
              )}
            </section>
            <button className="save-company" type="button" onClick={() => toggleSaved(selected.ticker)}>
              <BookmarkIcon filled={saved.includes(selected.ticker)} />
              {saved.includes(selected.ticker) ? "Saved for later" : "Save for later"}
            </button>
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
