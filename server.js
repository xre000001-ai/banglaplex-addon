#!/usr/bin/env node
// BanglaPlex Stremio Addon — zero-dependency Node.js (18+)
// Streams go DIRECTLY to BanglaPlex servers → zero video bandwidth on host.
// User provides their own TMDB key via /configure page → key encoded in URL.
//
// URL pattern: /{tmdbKey}/manifest.json  (or /manifest.json for key-less mode)
//
// Env:
//   PORT             — HTTP port (default 7000)
//   BANGLAPLEX_URL   — override BanglaPlex domain (auto-detected if unset)

'use strict';

const http = require('node:http');
const { URL } = require('node:url');

// ─── Config ───────────────────────────────────────────────────────────────────

const CODE_VERSION = '1.0.0';
const PORT = parseInt(process.env.PORT, 10) || 7000;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_SPACING_MS = 300;

// BanglaPlex domains to try (first alive one wins)
const BP_DOMAINS = [
  'https://banglaplex.biz',
  'https://banglaplex.me',
  'https://banglaplex.space',
  'https://banglaplex.life',
];
const BP_OVERRIDE = process.env.BANGLAPLEX_URL || '';

// ─── State ────────────────────────────────────────────────────────────────────

let BP_BASE = '';

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

function htmlPage(res, body, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.5' },
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
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ─── TMDb — per-user key ─────────────────────────────────────────────────────

// Per-key rate limiter: { key → { lastReq, penaltyUntil } }
const tmdbState = new Map();

function getTmdbState(key) {
  if (!tmdbState.has(key)) tmdbState.set(key, { lastReq: 0, penaltyUntil: 0 });
  return tmdbState.get(key);
}

async function tmdbFetch(path, key) {
  if (!key) return null;
  const st = getTmdbState(key);
  const now = Date.now();
  if (now < st.penaltyUntil) return null;
  const wait = st.lastReq + TMDB_SPACING_MS - now;
  if (wait > 0) await sleep(wait);
  st.lastReq = Date.now();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${TMDB_BASE}${path}${sep}api_key=${encodeURIComponent(key)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'banglaplex-stremio/1.0' } });
    if (r.status === 401 || r.status === 403) {
      st.penaltyUntil = Date.now() + 24 * 60 * 60 * 1000;
      console.warn(`TMDb rejected key ending ...${key.slice(-4)} (HTTP ${r.status})`);
      return null;
    }
    if (!r.ok) { st.penaltyUntil = Date.now() + 60000; return null; }
    return await r.json();
  } catch { st.penaltyUntil = Date.now() + 60000; return null; }
  finally { clearTimeout(t); }
}

// Validate a TMDB key with a lightweight probe
async function validateTmdbKey(key) {
  if (!key || key.length < 20) return false;
  const data = await tmdbFetch('/movie/550', key); // Fight Club — tiny probe
  return !!(data && data.id === 550);
}

// Resolve tt-id → { title, year }
async function tmdbMeta(type, ttId, key) {
  if (!key) return null;
  const mediaType = type === 'series' ? 'tv' : 'movie';
  const data = await tmdbFetch(`/find/${ttId}?external_source=imdb_id`, key);
  if (!data) return null;
  const results = data[`${mediaType}_results`] || [];
  if (!results.length) return null;
  const m = results[0];
  const title = m.title || m.name || '';
  const year = String(m.release_date || m.first_air_date || '').slice(0, 4);
  return { title, year, tmdbId: m.id };
}

// Search TMDB by title → best match with IMDB id
async function tmdbSearch(type, title, year, key) {
  if (!key) return null;
  const mediaType = type === 'series' ? 'tv' : 'movie';
  const yearParam = year ? `&year=${year}` : '';
  const data = await tmdbFetch(`/search/${mediaType}?query=${encodeURIComponent(title)}${yearParam}`, key);
  if (!data || !data.results || !data.results.length) return null;
  const normTitle = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = normTitle(title);
  const dateField = mediaType === 'movie' ? 'release_date' : 'first_air_date';
  let best = null;
  let bestScore = -1;
  for (const m of data.results) {
    const mName = normTitle(m.title || m.name || '');
    const mYear = String(m[dateField] || '').slice(0, 4);
    let score = 0;
    if (mName === target) score = 100;
    else if (mName.includes(target) || target.includes(mName)) score = 50;
    if (year && mYear === year) score += 10;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (!best) return null;
  const extData = await tmdbFetch(`/${mediaType}/${best.id}/external_ids`, key);
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
    if (html && (html.includes('BanglaPlex') || html.includes('banglaplex'))) {
      const canon = html.match(/canonical.*?href="([^"]+)"/);
      BP_BASE = canon ? new URL(canon[1]).origin : d;
      console.log(`BanglaPlex domain: ${BP_BASE}`);
      return;
    }
  }
  BP_BASE = BP_DOMAINS[0];
  console.warn('BanglaPlex: no domain responded; using', BP_BASE);
}

// ─── BanglaPlex scraper ──────────────────────────────────────────────────────

function parseMovieList(html) {
  const movies = [];
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

function parseWatchPage(html, url) {
  const titleM = html.match(/<title>([^<]+)/);
  const fullTitle = titleM ? he(titleM[1].replace(/\s*[–\-].*$/, '').trim()) : '';
  const metaM = fullTitle.match(/^(.+?)\s*\((\d{4})\)/);
  const title = metaM ? metaM[1].trim() : fullTitle;
  const year = metaM ? metaM[2] : '';
  const posterM = html.match(/og:image.*?content="([^"]+)"/);
  const poster = posterM ? posterM[1] : '';
  const genreMatches = [...html.matchAll(/genre\/[^"]*">([^<]+)/g)].map((g) => he(g[1]));
  const dirM = html.match(/Director:<\/strong>\s*<a[^>]*>([^<]+)/);
  const director = dirM ? he(dirM[1]) : '';
  const qualParts = [];
  const resM = fullTitle.match(/(4K|2160p|1080p|720p|480p|UHD)/i);
  if (resM) qualParts.push(resM[1].toUpperCase());
  const srcM = fullTitle.match(/(AMZN|Netflix|DSNP|ATVP|HMAX|WEB-DL|BluRay|HDRip|WEBRip|HDTC|HDTS|CAM)/i);
  if (srcM) qualParts.push(srcM[1]);
  const quality = qualParts.join(' ') || 'HD';
  const embedM = html.match(/iframe[^>]*src="(https?:\/\/[^"]*embed[^"]*)"/i);
  const embedM2 = html.match(/video-embed-container[\s\S]*?iframe[^>]*src="([^"]+)"/);
  const embedUrl = embedM ? embedM[1] : (embedM2 ? embedM2[1] : '');
  const dlM = html.match(/download-btn[^>]*href="([^"]+)"/);
  const downloadUrl = dlM ? dlM[1] : '';
  return { title, year, poster, genre: genreMatches, director, quality, embedUrl, downloadUrl, watchUrl: url, fullTitle };
}

function he(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ─── Embed chain resolver ────────────────────────────────────────────────────

async function resolveEmbed(embedUrl) {
  if (!embedUrl) return null;
  const html = await fetchText(embedUrl, 15000);
  if (!html) return null;
  const servers = [];
  const serverRe = /(?:changeServer|src)\s*[\(=]?\s*['"]?(https?:\/\/[^'")\s]+)/g;
  let m;
  while ((m = serverRe.exec(html))) {
    const u = m[1];
    if (u && !u.includes('gstatic') && !u.includes('google') && !u.includes('cloudflare') && !u.includes('recaptcha'))
      servers.push(u);
  }
  const iframeRe = /iframe[^>]*src="(https?:\/\/[^"]+)"/g;
  while ((m = iframeRe.exec(html))) {
    const u = m[1];
    if (!u.includes('gstatic') && !u.includes('google') && !u.includes('cloudflare') && !u.includes('recaptcha'))
      servers.push(u);
  }
  // Deduplicate
  return [...new Set(servers)];
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

// ─── Catalog ─────────────────────────────────────────────────────────────────

const catalogCache = new Map(); // tmdbKey → { data, at }
const CATALOG_TTL = 60 * 60 * 1000;

async function buildCatalog(tmdbKey) {
  const cacheKey = tmdbKey || '_nokey';
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CATALOG_TTL) return cached.data;
  if (!BP_BASE) return [];
  const html = await fetchText(BP_BASE + '/', 15000);
  if (!html) return [];
  const movies = parseMovieList(html);
  const mapped = [];
  for (const m of movies.slice(0, 25)) {
    let id = `bp_${Buffer.from(m.url).toString('base64url').slice(0, 20)}`;
    if (tmdbKey) {
      const meta = await tmdbSearch('movie', m.title, m.year, tmdbKey);
      if (meta && meta.imdbId) id = meta.imdbId;
    }
    mapped.push({
      id, type: 'movie',
      name: m.title,
      year: m.year ? parseInt(m.year, 10) : undefined,
      poster: m.poster || undefined,
      posterShape: 'poster',
      description: m.quality ? `[ ${m.quality} ]` : undefined,
      _bpUrl: m.url,
      _quality: m.quality || '',
    });
  }
  catalogCache.set(cacheKey, { data: mapped, at: Date.now() });
  return mapped;
}

// ─── Stream resolution ────────────────────────────────────────────────────────

async function resolveStream(type, id, tmdbKey) {
  // bp_ id → direct from catalog cache
  if (id.startsWith('bp_')) {
    const cacheKey = tmdbKey || '_nokey';
    const cached = catalogCache.get(cacheKey);
    if (cached) {
      const item = cached.data.find((c) => c.id === id);
      if (item) return [buildStreamEntry(item._bpUrl, item.name, item.year, item._quality, item.poster, id)];
    }
    return [];
  }

  // tt-id → resolve title → search BanglaPlex
  let title = '', year = '';
  if (id.startsWith('tt')) {
    // Try TMDB first (if key provided)
    if (tmdbKey) {
      const meta = await tmdbMeta(type, id, tmdbKey);
      if (meta) { title = meta.title; year = meta.year; }
    }
    // Fallback: Cinemeta (free, no key needed)
    if (!title) {
      const cm = await fetchJSON(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`, 8000);
      if (cm && cm.meta) { title = cm.meta.name || ''; year = String(cm.meta.year || '').slice(0, 4); }
    }
  }
  if (!title) return [];

  // Search BanglaPlex
  const results = await searchBanglaPlex(title);
  if (!results.length) return [];

  // Best match
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(title);
  let best = null;
  for (const r of results) {
    const rNorm = norm(r.title);
    if (rNorm === target || rNorm.includes(target) || target.includes(rNorm)) {
      best = r; break;
    }
  }
  if (!best) best = results[0];

  // Fetch watch page
  const watchHtml = await fetchText(best.url, 15000);
  if (!watchHtml) return [buildStreamEntry(best.url, best.title, '', '', best.image, id)];
  const info = parseWatchPage(watchHtml, best.url);

  // Resolve embed chain
  const servers = await resolveEmbed(info.embedUrl);
  if (servers && servers.length) {
    return servers.map((url) => ({
      name: `[ BanglaPlex ] ${info.quality}`,
      title: `${info.title} (${info.year || '?'})${info.director ? ' · ' + info.director : ''}`,
      url,
      poster: info.poster || undefined,
      behaviorHints: { notWebReady: false, bingeGroup: `banglaplex-${id}` },
    }));
  }

  return [buildStreamEntry(info.watchUrl, info.title, info.year, info.quality, info.poster, id)];
}

function buildStreamEntry(url, name, year, quality, poster, id) {
  return {
    name: `[ BanglaPlex ] ${quality || 'HD'}`,
    title: `${name} (${year || '?'})`,
    url,
    poster: poster || undefined,
    behaviorHints: { notWebReady: false, bingeGroup: `banglaplex-${id || 'default'}` },
  };
}

// ─── Stremio manifest ─────────────────────────────────────────────────────────

function manifest(tmdbKey) {
  return {
    id: 'community.banglaplex' + (tmdbKey ? '' : '.lite'),
    version: CODE_VERSION,
    name: 'BanglaPlex' + (tmdbKey ? '' : ' (Lite)'),
    description: tmdbKey
      ? 'Bengali, Bollywood, South Indian & Hollywood streams from BanglaPlex. Streams appear on Cinemeta catalogs.'
      : 'BanglaPlex streams — IMDB catalog mapping requires a TMDB key (free at themoviedb.org).',
    resources: [
      'stream',
      ...(tmdbKey ? [{ name: 'catalog', type: 'movie', id: 'banglaplex' }] : []),
    ],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'bp_'],
    catalogs: tmdbKey ? [{
      id: 'banglaplex', type: 'movie', name: 'BanglaPlex — Latest',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre', isRequired: false, options: ['bengali-movies', 'bollywood-movies', 'south-indian-movies', 'hollywood-movies', 'dual-audio-movies', 'bengali-web-series'] },
      ],
    }] : [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}

// ─── Catalog handler ──────────────────────────────────────────────────────────

async function handleCatalog(type, id, extra, tmdbKey) {
  if (type !== 'movie' || id !== 'banglaplex') return { metas: [] };
  if (!tmdbKey) return { metas: [] };

  if (extra && extra.search) {
    const results = await searchBanglaPlex(extra.search);
    const metas = [];
    for (const r of results.slice(0, 20)) {
      const meta = await tmdbSearch('movie', r.title, '', tmdbKey);
      const mId = (meta && meta.imdbId) ? meta.imdbId : `bp_${Buffer.from(r.url).toString('base64url').slice(0, 20)}`;
      metas.push({ id: mId, type: 'movie', name: r.title, poster: r.image || undefined, posterShape: 'poster' });
    }
    return { metas };
  }

  const genre = extra && extra.genre;
  let url = BP_BASE + '/';
  if (genre) url = `${BP_BASE}/genre/${genre}.html`;

  const html = await fetchText(url, 15000);
  if (!html) return { metas: [] };
  const movies = parseMovieList(html);
  const metas = [];
  for (const m of movies.slice(0, 20)) {
    const meta = await tmdbSearch('movie', m.title, m.year, tmdbKey);
    const mId = (meta && meta.imdbId) ? meta.imdbId : `bp_${Buffer.from(m.url).toString('base64url').slice(0, 20)}`;
    metas.push({
      id: mId, type: 'movie', name: m.title,
      year: m.year ? parseInt(m.year, 10) : undefined,
      poster: m.poster || undefined, posterShape: 'poster',
      description: m.quality ? `[ ${m.quality} ]` : undefined,
    });
  }
  return { metas };
}

// ─── Configure page ───────────────────────────────────────────────────────────

function configurePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BanglaPlex — Configure Addon</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0b;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#16161a;border:1px solid #2a2a30;border-radius:16px;padding:40px;max-width:520px;width:90%}
h1{font-size:28px;margin-bottom:4px;color:#ff277d}
h2{font-size:14px;color:#888;font-weight:400;margin-bottom:24px}
label{display:block;font-size:13px;color:#aaa;margin-bottom:6px;margin-top:16px}
input[type=text]{width:100%;padding:12px 16px;border-radius:8px;border:1px solid #2a2a30;background:#0a0a0b;color:#fff;font-size:15px;outline:none}
input:focus{border-color:#ff277d}
.hint{font-size:12px;color:#666;margin-top:6px;line-height:1.4}
.hint a{color:#ff277d}
.btn{display:block;width:100%;background:#ff277d;color:#fff;padding:14px;border-radius:8px;font-size:16px;font-weight:600;margin-top:24px;cursor:pointer;border:none;text-align:center}
.btn:hover{background:#e0106a}
.btn:disabled{background:#333;cursor:not-allowed}
.or{display:flex;align-items:center;gap:12px;margin:20px 0;color:#555;font-size:13px}
.or::before,.or::after{content:'';flex:1;height:1px;background:#2a2a30}
.status{margin-top:12px;padding:10px;border-radius:8px;font-size:13px;display:none}
.status.ok{display:block;background:#0d2818;border:1px solid #1a5c2e;color:#4ade80}
.status.err{display:block;background:#2d0a0a;border:1px solid #5c1a1a;color:#f87171}
.install-url{width:100%;padding:10px;border-radius:8px;background:#0a0a0b;border:1px solid #2a2a30;color:#4ade80;font-size:12px;font-family:monospace;word-break:break-all;margin-top:8px;cursor:pointer}
.install-url:hover{border-color:#ff277d}
.badge{display:inline-block;background:#ff277d;color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;margin:2px}
.footer{margin-top:20px;text-align:center;font-size:12px;color:#444}
</style>
</head>
<body>
<div class="card">
  <h1>🎬 BanglaPlex</h1>
  <h2>Stremio Addon Configuration</h2>

  <div style="margin-bottom:16px">
    <span class="badge">Movies</span>
    <span class="badge">Series</span>
    <span class="badge">Bengali</span>
    <span class="badge">Bollywood</span>
    <span class="badge">HD</span>
  </div>

  <label for="tmdbKey">TMDb API Key <span style="color:#ff277d">*</span></label>
  <input type="text" id="tmdbKey" placeholder="e.g. 8265bd1679663a7ea12ac168da84d2e8" autocomplete="off" spellcheck="false">
  <div class="hint">
    Get your <strong>free</strong> key at <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org/settings/api</a>
    — it takes 2 minutes. The key is encoded in the addon URL and <strong>never stored on the server</strong>.
  </div>

  <button class="btn" id="installBtn" onclick="installAddon()">Install in Stremio</button>

  <div id="status" class="status"></div>

  <div id="manualSection" style="display:none">
    <div class="or">or copy this URL</div>
    <input class="install-url" id="installUrl" readonly onclick="this.select()">
    <div class="hint">Paste this URL in Stremio → Addons → Add Addon → URL</div>
  </div>

  <div class="or">or skip (limited mode)</div>
  <button class="btn" style="background:#2a2a30" onclick="installNoKey()">Install without TMDB key</button>
  <div class="hint">Without a TMDB key, streams still work for known tt-ids, but catalog browsing and IMDB mapping won't be available.</div>

  <div class="footer">Domain: ${BP_BASE || 'auto-detecting...'} · v${CODE_VERSION}</div>
</div>

<script>
const host = location.origin;

function showStatus(type, msg) {
  const el = document.getElementById('status');
  el.className = 'status ' + type;
  el.textContent = msg;
  el.style.display = 'block';
}

async function installAddon() {
  const key = document.getElementById('tmdbKey').value.trim();
  if (!key || key.length < 20) {
    showStatus('err', 'Please enter a valid TMDB API key (at least 20 characters).');
    return;
  }
  const btn = document.getElementById('installBtn');
  btn.disabled = true;
  btn.textContent = 'Validating key...';
  try {
    const r = await fetch(host + '/validate-key?key=' + encodeURIComponent(key));
    const d = await r.json();
    if (!d.valid) {
      showStatus('err', 'TMDB key is invalid. Please check your key at themoviedb.org.');
      btn.disabled = false;
      btn.textContent = 'Install in Stremio';
      return;
    }
  } catch {
    showStatus('err', 'Could not validate key. Check your connection.');
    btn.disabled = false;
    btn.textContent = 'Install in Stremio';
    return;
  }
  btn.textContent = 'Installing...';
  const url = host + '/' + encodeURIComponent(key) + '/manifest.json';
  try {
    window.location.href = 'stremio://' + url.replace(/^https?:\\/\\//, '');
    showStatus('ok', 'Opening Stremio... If it doesn\\'t open, copy the URL below.');
  } catch {}
  document.getElementById('manualSection').style.display = 'block';
  document.getElementById('installUrl').value = url;
  btn.disabled = false;
  btn.textContent = 'Install in Stremio';
}

function installNoKey() {
  const url = host + '/manifest.json';
  try {
    window.location.href = 'stremio://' + url.replace(/^https?:\\/\\//, '');
  } catch {}
  document.getElementById('manualSection').style.display = 'block';
  document.getElementById('installUrl').value = url;
}

// Auto-fill from URL hash if present
if (location.hash) {
  const k = decodeURIComponent(location.hash.slice(1));
  if (k.length > 20) document.getElementById('tmdbKey').value = k;
}
</script>
</body>
</html>`;
}

// ─── HTTP router ──────────────────────────────────────────────────────────────

async function route(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rawPath = u.pathname || '/';
  const p = rawPath.replace(/\/+$/, '') || '/';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ─── Configure page ───
    if (p === '/configure' || p === '/config' || p === '/setup') {
      return htmlPage(res, configurePage());
    }

    // ─── Validate TMDB key (AJAX from configure page) ───
    if (p === '/validate-key') {
      const key = u.searchParams.get('key') || '';
      const valid = await validateTmdbKey(key);
      return json(res, { valid });
    }

    // ─── Dynamic URL: /:tmdbKey/... ───
    // Detect if first path segment looks like a TMDB key (32 hex chars or URL-encoded)
    const segments = rawPath.split('/').filter(Boolean);
    let tmdbKey = '';
    let pathWithoutKey = p;

    if (segments.length >= 1) {
      const first = decodeURIComponent(segments[0]);
      // TMDB keys are 32 hex chars
      if (/^[a-f0-9]{32}$/i.test(first)) {
        tmdbKey = first;
        pathWithoutKey = '/' + segments.slice(1).join('/');
      }
    }

    // ─── Manifest ───
    if (pathWithoutKey === '/manifest.json' || pathWithoutKey === '/manifest') {
      return json(res, manifest(tmdbKey));
    }

    // ─── Catalog ───
    const catM = pathWithoutKey.match(/^\/catalog\/([^/]+)\/([^/]+)\.json$/);
    if (catM) {
      const extra = {};
      for (const [k, v] of u.searchParams) extra[k] = v;
      const result = await handleCatalog(catM[1], catM[2], extra, tmdbKey);
      return json(res, result);
    }

    // ─── Stream ───
    const strmM = pathWithoutKey.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (strmM) {
      const type = strmM[1];
      const id = strmM[2];
      const streams = await resolveStream(type, id, tmdbKey);
      return json(res, { streams });
    }

    // ─── Health ───
    if (pathWithoutKey === '/health') {
      return json(res, {
        status: 'ok',
        version: CODE_VERSION,
        banglaplex: BP_BASE || 'not detected',
        mode: tmdbKey ? 'full (user TMDB key)' : 'lite (no TMDB key)',
        uptime: Math.round(process.uptime()),
      });
    }

    // ─── Landing page ───
    if (p === '/' || p === '') {
      return htmlPage(res, `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BanglaPlex Stremio Addon</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0b;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#16161a;border:1px solid #2a2a30;border-radius:16px;padding:40px;max-width:480px;text-align:center}
h1{font-size:28px;margin-bottom:8px;color:#ff277d}
p{color:#888;margin-bottom:16px;line-height:1.5}
.badge{display:inline-block;background:#ff277d;color:#fff;padding:4px 12px;border-radius:20px;font-size:13px;margin:4px}
a.btn{display:inline-block;background:#ff277d;color:#fff;padding:12px 32px;border-radius:8px;font-size:16px;font-weight:600;margin-top:16px;cursor:pointer;border:none;text-decoration:none}
a.btn:hover{background:#e0106a;text-decoration:none}
a.btn2{display:inline-block;background:#2a2a30;color:#fff;padding:12px 32px;border-radius:8px;font-size:14px;margin-top:12px;cursor:pointer;border:none;text-decoration:none}
a.btn2:hover{background:#3a3a40;text-decoration:none}
pre{background:#1a1a20;padding:12px;border-radius:8px;text-align:left;font-size:13px;overflow-x:auto;margin-top:16px;color:#aaa}
</style></head><body>
<div class="card">
<h1>🎬 BanglaPlex</h1>
<p>Stremio addon for Bengali, Bollywood, South Indian &amp; Hollywood streams</p>
<div><span class="badge">Movies</span><span class="badge">Series</span><span class="badge">Bengali</span><span class="badge">HD</span></div>
<br>
<a class="btn" href="/configure">⚙️ Configure &amp; Install</a>
<br>
<a class="btn2" href="${BP_BASE || '#'}" target="_blank">Visit BanglaPlex →</a>
<pre>Domain: ${BP_BASE || 'detecting...'}
Mode:   Configure to set TMDB key
Version: ${CODE_VERSION}</pre>
</div></body></html>`);
    }

    jsonErr(res, 404, 'not found');
  } catch (err) {
    console.error('Route error:', err.message || err);
    jsonErr(res, 500, 'internal error');
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  await detectDomain();
  console.log(`BanglaPlex addon v${CODE_VERSION} on port ${PORT}`);
  console.log(`Domain: ${BP_BASE}`);
  console.log(`Configure at: http://localhost:${PORT}/configure`);
  const server = http.createServer(route);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Listening on http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
