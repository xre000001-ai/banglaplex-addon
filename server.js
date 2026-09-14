#!/usr/bin/env node
// BanglaPlex Stremio Addon — zero-dependency Node.js (18+)
// Shows Bengali, Bollywood, South Indian, Hollywood streams from BanglaPlex
// in Stremio's Cinemeta catalogs (IMDb tt-ids).
//
// How it works:
//  1. Stremio asks for streams for a tt-id (e.g. tt0111161 Shawshank).
//  2. We resolve the tt-id to title+year via TMDB (top priority) or Cinemeta (fallback).
//  3. We search BanglaPlex for that title via their autocomplete API.
//  4. We fetch the watch page and resolve the embed chain → direct playable URL.
//  5. We return it as a stream entry with quality badge + metadata.
//
// Catalog (browse): scrapes BanglaPlex homepage → IMDB-mapped items via TMDB.
//
// Env/config:
//  TMDB_KEY        — TMDb v3 API key (for title resolution + catalog mapping)
//  TMDB_REGION      — ISO 3166-1 region for streaming-service badge (default US)
//  PORT             — HTTP port (default 7000)
//  BANGLAPLEX_URL   — override BanglaPlex domain (auto-detected if unset)

'use strict';

const http = require('node:http');
const { URL } = require('node:url');

// ─── Config ───────────────────────────────────────────────────────────────────

const CODE_VERSION = '1.0.0';
const PORT = parseInt(process.env.PORT, 10) || 7000;

const TMDB_KEY = process.env.TMDB_KEY || '';
const TMDB_REGION = process.env.TMDB_REGION || 'US';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_SPACING_MS = Math.max(0, parseInt(process.env.TMDB_SPACING_MS, 10) || 300);

// BanglaPlex domains to try (first alive one wins)
const BP_DOMAINS = [
  'https://banglaplex.biz',
  'https://banglaplex.me',
  'https://banglaplex.space',
  'https://banglaplex.life',
];
const BP_OVERRIDE = process.env.BANGLAPLEX_URL || '';

// ─── State ────────────────────────────────────────────────────────────────────

let BP_BASE = '';            // resolved BanglaPlex domain
let tmdbLastReq = 0;
let tmdbPenaltyUntil = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function jsonErr(res, status, msg) { return json(res, { error: msg }, status); }

// ─── HTTP client ──────────────────────────────────────────────────────────────

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function fetchJSON(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'banglaplex-stremio/1.0' },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ─── TMDb ─────────────────────────────────────────────────────────────────────

function tmdbReady() { return Date.now() >= tmdbPenaltyUntil; }
function tmdbPenalize(ms) {
  const until = Date.now() + ms;
  if (until > tmdbPenaltyUntil) tmdbPenaltyUntil = until;
}

async function tmdbFetch(path) {
  if (!TMDB_KEY) return null;
  if (!tmdbReady()) return null;
  const wait = tmdbLastReq + TMDB_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  tmdbLastReq = Date.now();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${TMDB_BASE}${path}${sep}api_key=${encodeURIComponent(TMDB_KEY)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'banglaplex-stremio/1.0' } });
    if (r.status === 401 || r.status === 403) {
      tmdbPenalize(24 * 60 * 60 * 1000);
      console.error('TMDb rejected the api key (HTTP ' + r.status + ') — paused for 24h.');
      return null;
    }
    if (!r.ok) { tmdbPenalize(60000); return null; }
    return await r.json();
  } catch { tmdbPenalize(60000); return null; }
  finally { clearTimeout(t); }
}

// Resolve tt-id → { title, year, imdbId }
async function tmdbMeta(type, ttId) {
  const mediaType = type === 'series' ? 'tv' : 'movie';
  const data = await tmdbFetch(`/find/${ttId}?external_source=imdb_id`);
  if (!data) return null;
  const results = data[`${mediaType}_results`] || [];
  if (!results.length) return null;
  const m = results[0];
  const title = m.title || m.name || '';
  const year = String(m.release_date || m.first_air_date || '').slice(0, 4);
  return { title, year, tmdbId: m.id, imdbId: ttId };
}

// Search TMDB by title → best match
async function tmdbSearch(type, title, year) {
  const mediaType = type === 'series' ? 'tv' : 'movie';
  const yearParam = year ? `&year=${year}` : '';
  const data = await tmdbFetch(`/search/${mediaType}?query=${encodeURIComponent(title)}${yearParam}`);
  if (!data || !data.results || !data.results.length) return null;
  // Pick best match by title similarity + year
  const normTitle = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = normTitle(title);
  const dateField = mediaType === 'movie' ? 'release_date' : 'first_air_date';
  let best = null;
  let bestScore = -1;
  for (const m of data.results) {
    const mName = normTitle(m.title || m.name || '');
    const mYear = String(m[dateField] || '').slice(0, 4);
    // Score: exact match = 100, partial = 50, year match = +10
    let score = 0;
    if (mName === target) score = 100;
    else if (mName.includes(target) || target.includes(mName)) score = 50;
    if (year && mYear === year) score += 10;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (!best) return null;
  // Get external IDs for IMDB
  const extData = await tmdbFetch(`/${mediaType}/${best.id}/external_ids`);
  const imdbId = extData && extData.imdb_id ? extData.imdb_id : null;
  return {
    title: best.title || best.name || '',
    year: String(best[dateField] || '').slice(0, 4),
    tmdbId: best.id,
    imdbId,
  };
}

// ─── BanglaPlex domain detection ─────────────────────────────────────────────

async function detectDomain() {
  if (BP_OVERRIDE) { BP_BASE = BP_OVERRIDE.replace(/\/+$/, ''); return; }
  for (const d of BP_DOMAINS) {
    const html = await fetchText(d + '/', 8000);
    if (html && html.includes('BanglaPlex')) {
      // Follow redirect if space→me etc.
      const canon = html.match(/canonical.*?href="([^"]+)"/);
      BP_BASE = canon ? new URL(canon[1]).origin : d;
      console.log(`BanglaPlex domain: ${BP_BASE}`);
      return;
    }
  }
  // Fallback
  BP_BASE = BP_DOMAINS[0];
  console.warn('BanglaPlex: no domain responded; using', BP_BASE);
}

// ─── BanglaPlex scraper ──────────────────────────────────────────────────────

// Scrape movie list from homepage or paginated page
function parseMovieList(html) {
  const movies = [];
  // Pattern: <a href="...watch/slug.html" ...><img src="...thumb/ID.jpg" alt="Title" /></a>
  // Plus: video_quality_movie, video_year_movie, movie-title
  const re = /<a\s+href="(https?:\/\/[^"]*\/watch\/[^"]+)"[^>]*>[\s\S]*?<img\s+src="([^"]*)"[^>]*alt="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    const poster = m[2];
    const title = he(m[3]);
    if (title && !movies.some((x) => x.url === url)) {
      movies.push({ title, url, poster });
    }
  }
  // Extract year and quality from movie-container blocks
  const blocks = html.split(/class="movie-container"/);
  for (let i = 1; i < blocks.length && i - 1 < movies.length; i++) {
    const block = blocks[i];
    const yearM = block.match(/video_year_movie[^>]*>[\s\S]*?(\d{4})/);
    const qualM = block.match(/video_quality_movie[^>]*>[\s\S]*?>([^<]+)</);
    if (yearM) movies[i - 1].year = yearM[1];
    if (qualM) movies[i - 1].quality = qualM[1].trim();
  }
  return movies;
}

// Parse watch page for full metadata
function parseWatchPage(html, url) {
  const titleM = html.match(/<title>([^<]+)/);
  const fullTitle = titleM ? he(titleM[1].replace(/\s*[–\-].*$/, '').trim()) : '';
  // Title pattern: "Movie Name (2025) Bengali AMZN WEB-DL | 1080p x264"
  const metaM = fullTitle.match(/^(.+?)\s*\((\d{4})\)/);
  const title = metaM ? metaM[1].trim() : fullTitle;
  const year = metaM ? metaM[2] : '';
  // Poster
  const posterM = html.match(/og:image.*?content="([^"]+)"/);
  const poster = posterM ? posterM[1] : '';
  // Genre
  const genreMatches = [...html.matchAll(/genre\/[^"]*">([^<]+)/g)].map((g) => he(g[1]));
  // Director
  const dirM = html.match(/Director:<\/strong>\s*<a[^>]*>([^<]+)/);
  const director = dirM ? he(dirM[1]) : '';
  // Quality from title — try to get both resolution and source
  const qualParts = [];
  const resM = fullTitle.match(/(4K|2160p|1080p|720p|480p|UHD)/i);
  if (resM) qualParts.push(resM[1].toUpperCase());
  const srcM = fullTitle.match(/(AMZN|Netflix|DSNP|ATVP|HMAX|WEB-DL|BluRay|HDRip|WEBRip|HDTC|HDTS|CAM)/i);
  if (srcM) qualParts.push(srcM[1]);
  const quality = qualParts.join(' ') || 'HD';
  // Embed iframe src
  const embedM = html.match(/iframe[^>]*src="(https?:\/\/[^"]*embed[^"]*)"/i);
  const embedUrl = embedM ? embedM[1] : '';
  // Alternative: video-embed-container
  const embedM2 = html.match(/video-embed-container[\s\S]*?iframe[^>]*src="([^"]+)"/);
  const embedUrl2 = embedM2 ? embedM2[1] : '';
  // Download link
  const dlM = html.match(/download-btn[^>]*href="([^"]+)"/);
  const downloadUrl = dlM ? dlM[1] : '';
  return {
    title, year, poster, genre: genreMatches, director, quality,
    embedUrl: embedUrl || embedUrl2, downloadUrl, watchUrl: url,
  };
}

// Extract quality label from title string
function extractQuality(s) {
  if (!s) return '';
  const m = s.match(/(4K|2160p|1080p|720p|480p|HD|FHD|UHD|HDTC|HDTS|CAM|WEBRip|WEB-DL|BluRay|BRRip|DVDRip|HDRip|AMZN|Netflix|DSNP|ATVP|HMAX)/i);
  return m ? m[1].toUpperCase() : '';
}

// Decode HTML entities
function he(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ─── Embed chain resolver ────────────────────────────────────────────────────

// Resolve plextream → abyssplayer → final URL
async function resolveEmbed(embedUrl) {
  if (!embedUrl) return null;
  const html = await fetchText(embedUrl, 15000);
  if (!html) return null;
  // Look for server URLs in the embed page
  // Pattern: changeServer('https://abyssplayer.com/XXXX', this)
  const servers = [];
  const serverRe = /(?:changeServer|src)\s*[\(=]?\s*['"]?(https?:\/\/[^'")\s]+)/g;
  let m;
  while ((m = serverRe.exec(html))) {
    if (m[1] && !m[1].includes('gstatic') && !m[1].includes('google') && !m[1].includes('cloudflare'))
      servers.push(m[1]);
  }
  // Also check iframe src
  const iframeRe = /iframe[^>]*src="(https?:\/\/[^"]+)"/g;
  while ((m = iframeRe.exec(html))) {
    if (!m[1].includes('gstatic') && !m[1].includes('google') && !m[1].includes('cloudflare'))
      servers.push(m[1]);
  }
  // Return all resolved servers; Stremio will try them
  return servers.length ? servers : null;
}

// ─── BanglaPlex search (autocomplete API) ─────────────────────────────────────

async function searchBanglaPlex(query) {
  if (!BP_BASE) return [];
  const url = `${BP_BASE}//home/autocompleteajax?term=${encodeURIComponent(query)}`;
  const data = await fetchJSON(url, 8000);
  if (!Array.isArray(data)) return [];
  return data.map((item) => ({
    title: item.title || '',
    type: item.type || 'Movie',
    image: item.image || '',
    url: item.url || '',
  }));
}

// ─── Catalog: scrape BanglaPlex + map to IMDB via TMDB ───────────────────────

let catalogCache = null;
let catalogCacheAt = 0;
const CATALOG_TTL = 60 * 60 * 1000; // 1 hour

async function buildCatalog() {
  if (catalogCache && Date.now() - catalogCacheAt < CATALOG_TTL) return catalogCache;
  if (!BP_BASE) { catalogCache = []; return []; }
  // Scrape homepage
  const html = await fetchText(BP_BASE + '/', 15000);
  if (!html) { catalogCache = []; return []; }
  const movies = parseMovieList(html);
  // Map to TMDB/IMDB IDs (rate-limited)
  const mapped = [];
  for (const m of movies.slice(0, 20)) { // Top 20 only to avoid TMDB rate limit
    const meta = await tmdbSearch('movie', m.title, m.year);
    if (meta && meta.imdbId) {
      mapped.push({
        id: meta.imdbId,
        type: 'movie',
        name: meta.title,
        year: meta.year,
        poster: m.poster || '',
        banglaplexUrl: m.url,
        quality: m.quality || '',
      });
    } else {
      // No TMDB match — still include with internal id
      mapped.push({
        id: `bp_${Buffer.from(m.url).toString('base64url').slice(0, 20)}`,
        type: 'movie',
        name: m.title,
        year: m.year || '',
        poster: m.poster || '',
        banglaplexUrl: m.url,
        quality: m.quality || '',
        noImdb: true,
      });
    }
  }
  catalogCache = mapped;
  catalogCacheAt = Date.now();
  return mapped;
}

// ─── Stream resolution ────────────────────────────────────────────────────────

async function resolveStream(type, id) {
  // Try to find the stream on BanglaPlex
  // Step 1: Get title+year from TMDB or Cinemeta
  let title = '', year = '';
  if (id.startsWith('tt')) {
    const meta = await tmdbMeta(type, id);
    if (meta) { title = meta.title; year = meta.year; }
    else {
      // Fallback: try Cinemeta
      const cm = await fetchJSON(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, 8000);
      if (cm && cm.meta) { title = cm.meta.name || ''; year = String(cm.meta.year || '').slice(0, 4); }
    }
  } else if (id.startsWith('bp_')) {
    // Internal id — find in catalog cache
    const item = catalogCache && catalogCache.find((c) => c.id === id);
    if (item) return buildStreamFromItem(item);
    return [];
  }
  if (!title) return [];
  // Step 2: Search BanglaPlex for the title
  const results = await searchBanglaPlex(title);
  if (!results.length) return [];
  // Pick best match
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(title);
  let best = null;
  for (const r of results) {
    const rNorm = norm(r.title);
    if (rNorm === target || rNorm.includes(target) || target.includes(rNorm)) {
      best = r; break;
    }
  }
  if (!best) best = results[0]; // Fallback to first result
  // Step 3: Fetch watch page
  const watchHtml = await fetchText(best.url, 15000);
  if (!watchHtml) return buildFallbackStream(best.url, best.title, best.image);
  const info = parseWatchPage(watchHtml, best.url);
  const fullTitle = `${info.title} ${info.year} ${info.quality}`;
  // Step 4: Resolve embed chain (deduplicated)
  const servers = await resolveEmbed(info.embedUrl);
  if (servers && servers.length) {
    const seen = new Set();
    const streams = [];
    for (const url of servers) {
      if (seen.has(url)) continue;
      seen.add(url);
      const label = info.quality || extractQuality(fullTitle || info.title) || 'HD';
      streams.push({
        name: `[ BanglaPlex ] ${label}`,
        title: `${info.title} (${info.year || '?'})${info.director ? ' · ' + info.director : ''}`,
        url,
        poster: info.poster || undefined,
        behaviorHints: { notWebReady: false, bingeGroup: `banglaplex-${id}` },
      });
    }
    return streams;
  }
  // Fallback: return the watch page URL itself
  return buildFallbackStream(info.watchUrl, info.title, info.poster, info.quality);
}

function buildStreamFromItem(item) {
  return [{
    name: `[ BanglaPlex ] ${item.quality || 'HD'}`,
    title: `${item.name} (${item.year || '?'})`,
    url: item.banglaplexUrl,
    poster: item.poster || undefined,
    behaviorHints: { notWebReady: false, bingeGroup: `banglaplex-${item.id}` },
  }];
}

function buildFallbackStream(url, title, poster, quality) {
  return [{
    name: `[ BanglaPlex ] ${quality || 'HD'}`,
    title: title || 'BanglaPlex Stream',
    url,
    poster: poster || undefined,
    behaviorHints: { notWebReady: false, bingeGroup: 'banglaplex' },
  }];
}

// ─── Stremio manifest ─────────────────────────────────────────────────────────

function manifest() {
  return {
    id: 'community.banglaplex',
    version: CODE_VERSION,
    name: 'BanglaPlex',
    description: 'Bengali, Bollywood, South Indian & Hollywood movies and web series from BanglaPlex — HD streams with quality badges.',
    resources: [
      'stream',
      { name: 'catalog', type: 'movie', id: 'banglaplex' },
    ],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'bp_'],
    catalogs: [
      {
        id: 'banglaplex',
        type: 'movie',
        name: 'BanglaPlex — Latest',
        extra: [
          { name: 'search', isRequired: false },
          { name: 'genre', isRequired: false, options: ['bengali-movies', 'bollywood-movies', 'south-indian-movies', 'hollywood-movies', 'dual-audio-movies', 'bengali-web-series'] },
        ],
      },
    ],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}

// ─── Catalog handler ──────────────────────────────────────────────────────────

async function handleCatalog(type, id, extra) {
  if (type !== 'movie' || id !== 'banglaplex') return { metas: [] };

  // Search mode
  if (extra && extra.search) {
    const results = await searchBanglaPlex(extra.search);
    const metas = [];
    for (const r of results.slice(0, 20)) {
      // Try to get IMDB ID
      const meta = await tmdbSearch('movie', r.title, '');
      const mId = (meta && meta.imdbId) ? meta.imdbId : `bp_${Buffer.from(r.url).toString('base64url').slice(0, 20)}`;
      metas.push({
        id: mId,
        type: 'movie',
        name: r.title,
        poster: r.image || undefined,
        posterShape: 'poster',
      });
    }
    return { metas };
  }

  // Genre filter
  const genre = extra && extra.genre;
  let url = BP_BASE + '/';
  if (genre) url = `${BP_BASE}/genre/${genre}.html`;

  const html = await fetchText(url, 15000);
  if (!html) return { metas: [] };
  const movies = parseMovieList(html);
  const metas = [];
  for (const m of movies.slice(0, 20)) {
    const meta = await tmdbSearch('movie', m.title, m.year);
    const mId = (meta && meta.imdbId) ? meta.imdbId : `bp_${Buffer.from(m.url).toString('base64url').slice(0, 20)}`;
    metas.push({
      id: mId,
      type: 'movie',
      name: m.title,
      year: m.year ? parseInt(m.year, 10) : undefined,
      poster: m.poster || undefined,
      posterShape: 'poster',
      description: m.quality ? `[${m.quality}]` : undefined,
    });
  }
  return { metas };
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

async function route(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = (u.pathname || '/').replace(/\/+$/, '') || '/';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // Manifest
    if (p === '/manifest.json' || p === '/manifest') {
      return json(res, manifest());
    }

    // Catalog
    const catM = p.match(/^\/catalog\/([^/]+)\/([^/]+)\.json$/);
    if (catM) {
      const extra = {};
      for (const [k, v] of u.searchParams) extra[k] = v;
      const result = await handleCatalog(catM[1], catM[2], extra);
      return json(res, result);
    }

    // Stream
    const strmM = p.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (strmM) {
      const type = strmM[1];
      const id = strmM[2];
      const streams = await resolveStream(type, id);
      return json(res, { streams });
    }

    // Health
    if (p === '/health') {
      return json(res, {
        status: 'ok',
        version: CODE_VERSION,
        banglaplex: BP_BASE || 'not detected',
        tmdb: TMDB_KEY ? 'configured' : 'not configured',
        uptime: Math.round(process.uptime()),
      });
    }

    // Landing page
    if (p === '/' || p === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BanglaPlex Stremio Addon</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0b;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#16161a;border:1px solid #2a2a30;border-radius:16px;padding:40px;max-width:480px;text-align:center}
h1{font-size:28px;margin-bottom:8px;color:#ff277d}
p{color:#888;margin-bottom:16px;line-height:1.5}
.badge{display:inline-block;background:#ff277d;color:#fff;padding:4px 12px;border-radius:20px;font-size:13px;margin:4px}
a{color:#ff277d;text-decoration:none}
a:hover{text-decoration:underline}
.btn{display:inline-block;background:#ff277d;color:#fff;padding:12px 32px;border-radius:8px;font-size:16px;font-weight:600;margin-top:16px;cursor:pointer;border:none}
.btn:hover{background:#e0106a}
pre{background:#1a1a20;padding:12px;border-radius:8px;text-align:left;font-size:13px;overflow-x:auto;margin-top:16px;color:#aaa}
</style></head><body>
<div class="card">
<h1>🎬 BanglaPlex</h1>
<p>Stremio addon for Bengali, Bollywood, South Indian &amp; Hollywood streams</p>
<div><span class="badge">Movies</span><span class="badge">Series</span><span class="badge">HD</span></div>
<br><a class="btn" href="stremio://banglaplex-addon/manifest.json">Add to Stremio</a>
<pre>Domain: ${BP_BASE || 'detecting...'}
TMDB:   ${TMDB_KEY ? '✓ Configured' : '✗ Not configured (IMDB mapping limited)'}
Version: ${CODE_VERSION}</pre>
</div></body></html>`);
      return;
    }

    jsonErr(res, 404, 'not found');
  } catch (err) {
    console.error('Route error:', err);
    jsonErr(res, 500, 'internal error');
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  await detectDomain();
  console.log(`BanglaPlex addon v${CODE_VERSION} starting on port ${PORT}`);
  console.log(`Domain: ${BP_BASE}`);
  console.log(`TMDB: ${TMDB_KEY ? 'configured' : 'not configured — IMDB mapping will be limited'}`);

  const server = http.createServer(route);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Listening on http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
