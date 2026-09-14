# BanglaPlex Stremio Addon

Stremio addon for **BanglaPlex** — Bengali, Bollywood, South Indian & Hollywood movies and web series.

## Features

- 🎬 **Movies & Web Series** from BanglaPlex
- 🔍 **IMDb integration** — streams appear on Cinemeta catalogs (tt-ids)
- 📺 **Catalog browsing** — browse BanglaPlex directly in Stremio
- 🔎 **Search** — search BanglaPlex from Stremio
- 🏷️ **Quality badges** — 4K, 1080p, 720p, AMZN WEB-DL etc.
- 🌐 **Auto-domain detection** — works across BanglaPlex domain changes
- ⚡ **Zero dependencies** — pure Node.js (18+)

## Install

### 1. Configure (Recommended)

Open `http://YOUR_SERVER:7000/configure` in your browser:

1. Enter your **free TMDB API key** (get one at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) — 2 minutes)
2. Click **Install in Stremio**
3. Done! The key is encoded in the addon URL — **never stored on the server**.

### Deploy to Render

1. Fork/clone this repo
2. Connect to Render as a **Web Service**
3. Set `PORT=7000` (or leave default)
4. Deploy!
5. Open `https://YOUR_APP.onrender.com/configure` and enter your TMDB key

### Deploy anywhere

```bash
git clone https://github.com/YOUR_USERNAME/banglaplex-addon.git
cd banglaplex-addon

# No config needed — users provide their own TMDB key via /configure page
node server.js
# → http://localhost:7000/configure
```

### How the key works

The TMDB key is encoded in the addon URL: `https://YOUR_SERVER/TMDB_KEY/manifest.json`

- **Full mode** (with key): catalog browsing + IMDB mapping for Cinemeta integration
- **Lite mode** (no key): streams work for known tt-ids via Cinemeta fallback, no catalog

Each user provides their own key → **zero TMDB cost on the server**.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `7000` | HTTP server port |
| `BANGLAPLEX_URL` | No | auto-detected | Override BanglaPlex domain |

**Note:** TMDB keys are user-provided via `/configure` page. No server-side TMDB key needed.

## How It Works

1. **Stream request** — Stremio sends a tt-id (IMDb) for a movie/series
2. **3-way race** — IMDb Suggestion API vs TMDB (if key) vs Cinemeta → first valid result wins
3. **BanglaPlex search** — Autocomplete API finds matching content
4. **Stream extraction** — Watch page → embed chain → direct playable URL
5. **Stremio displays** — Stream entry with quality badge + metadata

### Race Architecture (v1.1.0)

```
Title Resolution:
  ┌─ IMDb Suggestion API (free, ~200ms) ──── fastest?
  ├─ TMDB (user key, ~300ms) ─────────────── fastest?
  └─ Cinemeta (free, ~400ms) ─────────────── fastest?
  → First valid result wins. Others abandoned.

Catalog IMDB Mapping:
  ┌─ IMDb Suggestion API (free) ──────────── 19/20 mapped!
  └─ TMDB (if key provided) ──────────────── service badges
  → Works WITHOUT TMDB key (IMDb covers almost everything)
```

### Stream URLs

Stream URLs from BanglaPlex are **NOT IP-bound**:
- `abyssplayer.com/bY4p5uiA2` — static URL, no token/expiry/IP params
- Works from any client (server, user device, proxy)

## API

| Endpoint | Description |
|----------|-------------|
| `GET /manifest.json` | Stremio manifest |
| `GET /stream/{type}/{id}.json` | Stream for tt-id or bp_-id |
| `GET /catalog/movie/banglaplex.json` | Catalog (browse) |
| `GET /catalog/movie/banglaplex.json?search=QUERY` | Catalog search |
| `GET /catalog/movie/banglaplex.json?genre=GENRE` | Genre filter |
| `GET /health` | Health check |

## Genre Options

- `bengali-movies` — Bengali Movies
- `bollywood-movies` — Bollywood Movies
- `south-indian-movies` — South Indian Movies
- `hollywood-movies` — Hollywood Movies
- `dual-audio-movies` — Dual Audio Movies
- `bengali-web-series` — Bengali Web Series

## Limitations

- **Stream availability** depends on BanglaPlex being online
- **IMDb mapping** requires a TMDB API key (free)
- **Very new titles** may not be in TMDB yet
- **Series support** is basic — BanglaPlex's series structure varies

## License

MIT
