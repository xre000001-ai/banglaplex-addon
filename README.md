# BanglaPlex Stremio Addon

Zero server bandwidth — video plays directly from BanglaPlex CDN.

## How It Works

```
Stremio → Server resolves title (tiny JSON ~200B)
       → Server fetches BanglaPlex embed chain (~50KB)
       → Returns DIRECT video URL to Stremio
       → Video plays from BanglaPlex CDN → user
       → Server bandwidth = 0
```

## Deploy to Render

1. **Fork** this repo
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your fork
4. Settings:
   - **Build Command:** _(leave empty)_
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. **Environment Variables** (optional):
   - `PROXY_POOL` — comma-separated HTTP proxies for IP-flagged fallback
     - e.g. `http://proxy1:8080,http://proxy2:3128`
     - Only used if direct fetch fails (IP blocked)
6. **Deploy!**
7. Open `https://YOUR_APP.onrender.com/configure`
8. Enter TMDB key (optional) → **Install in Stremio**

## Features

- 🎬 **Movies & Series** from BanglaPlex (Bengali, Bollywood, South Indian, Hollywood)
- 📡 **Zero bandwidth** — video plays directly from source CDN
- 🛡️ **IP protection** — proxy pool fallback if server IP flagged
- 🔍 **3-way race** — IMDb Suggestion + TMDB + Cinemeta (fastest wins)
- 📺 **Catalog** — browse BanglaPlex in Stremio (19/20 items IMDB-mapped)
- ⚙️ **User TMDB key** — via `/configure` page, never stored on server
- ⚡ **Zero dependencies** — pure Node.js 18+

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7000` | HTTP port |
| `BANGLAPLEX_URL` | auto-detect | Override BanglaPlex domain |
| `PROXY_POOL` | _(none)_ | Comma-separated HTTP proxies for fallback |

**Note:** No TMDB key on server — users provide their own via `/configure`.

## License

MIT
