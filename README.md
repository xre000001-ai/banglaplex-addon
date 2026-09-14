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

### Deploy to Render

1. Fork/clone this repo
2. Connect to Render as a **Web Service**
3. Set environment variable `TMDB_KEY` (get free key from [themoviedb.org](https://www.themoviedb.org/settings/api))
4. Deploy!

### Deploy anywhere

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/banglaplex-addon.git
cd banglaplex-addon

# Set TMDB key (optional but recommended for IMDB mapping)
export TMDB_KEY=your_tmdb_api_key_here

# Run
node server.js
# → http://localhost:7000
```

### Add to Stremio

Open `http://localhost:7000` in your browser and click **"Add to Stremio"**.

Or manually: `stremio://localhost:7000/manifest.json`

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TMDB_KEY` | Recommended | — | TMDb v3 API key (free at themoviedb.org) |
| `PORT` | No | `7000` | HTTP server port |
| `BANGLAPLEX_URL` | No | auto-detected | Override BanglaPlex domain |
| `TMDB_REGION` | No | `US` | ISO 3166-1 region for streaming service badges |
| `TMDB_SPACING_MS` | No | `300` | TMDb request spacing (rate limit) |

## How It Works

1. **Stream request** — Stremio sends a tt-id (IMDb) for a movie/series
2. **Title resolution** — TMDB (priority) or Cinemeta (fallback) resolves tt-id → title + year
3. **BanglaPlex search** — Autocomplete API finds matching content
4. **Stream extraction** — Watch page → embed chain → direct playable URL
5. **Stremio displays** — Stream entry with quality badge + metadata

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
