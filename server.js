#!/usr/bin/env node
// BanglaPlex Stremio Addon v2.0.0 — zero-dependency Node.js (18+)
//
// Architecture (ZERO bandwidth on host):
//   1. Stremio asks for stream for tt-id
//   2. Server resolves title (IMDb race + TMDB + Cinemeta) — ~200 bytes
//   3. Server fetches BanglaPlex watch page + embed chain — ~50KB
//   4. Server extracts DIRECT video URL (abyssplayer/CDN)
//   5. Returns direct URL to Stremio → video plays DIRECTLY from BanglaPlex CDN
//   6. Render bandwidth = 0 (only tiny JSON/HTML API calls)
//
// IP Protection:
//   - If direct fetch fails (IP blocked) → tries proxy pool
//   - PROXY_POOL env var: comma-separated HTTP proxies
//   - Server only resolves URLs, never proxies video
//
// Env:
//   PORT             — HTTP port (default 7000)
//   BANGLAPLEX_URL   — override BanglaPlex domain
//   PROXY_POOL       — comma-separated HTTP proxies for IP-flagged fallback

'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const CODE_VERSION = '2.0.0';
const PORT = parseInt(process.env.PORT, 10) || 7000;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_SPACING_MS = 300;

const BP_DOMAINS = ['https://banglaplex.biz', 'https://banglaplex.me', 'https://banglaplex.space', 'https://banglaplex.life'];
const BP_OVERRIDE = process.env.BANGLAPLEX_URL || '';
const PROXY_POOL = (process.env.PROXY_POOL || '').split(',').map(s => s.trim()).filter(Boolean);

let BP_BASE = '';
const resolveCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function jsonErr(res, s, m) { return json(res, { error: m }, s); }
function htmlPage(res, body) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(body); }

// ─── HTTP client (with proxy fallback) ────────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function fetchWithFallback(url, timeoutMs = 12000) {
  // Try direct first
  const result = await doFetch(url, null, timeoutMs);
  if (result) return result;
  // If blocked, try each proxy in pool
  for (const proxy of PROXY_POOL) {
    const r = await doFetch(url, proxy, timeoutMs);
    if (r) return r;
  }
  return null;
}

async function doFetch(url, proxy, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const fetchUrl = proxy ? `${proxy}/${encodeURIComponent(url)}` : url;
    const r = await fetch(fetchUrl, {
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

// ─── TMDb (per-user key) ─────────────────────────────────────────────────────

const tmdbState = new Map();
function getTmdbSt(k) { if (!tmdbState.has(k)) tmdbState.set(k, { last: 0, pen: 0 }); return tmdbState.get(k); }

async function tmdbFetch(path, key) {
  if (!key) return null;
  const st = getTmdbSt(key);
  const now = Date.now();
  if (now < st.pen) return null;
  const wait = st.last + TMDB_SPACING_MS - now;
  if (wait > 0) await sleep(wait);
  st.last = Date.now();
  const sep = path.includes('?') ? '&' : '?';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${TMDB_BASE}${path}${sep}api_key=${encodeURIComponent(key)}`, { signal: ctrl.signal, headers: { 'User-Agent': 'banglaplex/2.0' } });
    if (r.status === 401 || r.status === 403) { st.pen = Date.now() + 86400000; return null; }
    if (!r.ok) { st.pen = Date.now() + 60000; return null; }
    return await r.json();
  } catch { st.pen = Date.now() + 60000; return null; }
  finally { clearTimeout(t); }
}

async function validateKey(k) { if (!k || k.length < 20) return false; const d = await tmdbFetch('/movie/550', k); return !!(d && d.id === 550); }

async function tmdbMeta(type, tt, key) {
  const mt = type === 'series' ? 'tv' : 'movie';
  const d = await tmdbFetch(`/find/${tt}?external_source=imdb_id`, key);
  if (!d) return null;
  const r = (d[`${mt}_results`] || [])[0];
  return r ? { title: r.title || r.name || '', year: String(r.release_date || r.first_air_date || '').slice(0, 4), tmdbId: r.id } : null;
}

async function tmdbSearch(type, title, year, key) {
  const mt = type === 'series' ? 'tv' : 'movie';
  const d = await tmdbFetch(`/search/${mt}?query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`, key);
  if (!d || !d.results || !d.results.length) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(title);
  const df = mt === 'movie' ? 'release_date' : 'first_air_date';
  let best = null, bs = -1;
  for (const m of d.results) {
    const mn = norm(m.title || m.name || '');
    let sc = mn === target ? 100 : (mn.includes(target) || target.includes(mn)) ? 50 : 0;
    if (year && String(m[df] || '').slice(0, 4) === year) sc += 10;
    if (sc > bs) { bs = sc; best = m; }
  }
  if (!best) return null;
  const ext = await tmdbFetch(`/${mt}/${best.id}/external_ids`, key);
  return { title: best.title || best.name || '', year: String(best[df] || '').slice(0, 4), imdbId: ext?.imdb_id || null };
}

// ─── IMDb Suggestion (free, no auth) ─────────────────────────────────────────

async function imdbSuggest(q) {
  if (!q) return null;
  const l = q.toLowerCase().replace(/[^a-z0-9]/g, '').charAt(0) || 'x';
  const d = await fetchJSON(`https://v2.sg.media-imdb.com/suggestion/${l}/${encodeURIComponent(q)}.json`, 6000);
  if (!d || !Array.isArray(d.d) || !d.d.length) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(q);
  for (const r of d.d) {
    if (!r.id?.startsWith('tt')) continue;
    const rn = norm(r.l || '');
    if (rn === t || rn.includes(t) || t.includes(rn)) return { imdbId: r.id, title: r.l || '', year: String(r.y || '') };
  }
  const f = d.d.find(r => r.id?.startsWith('tt'));
  return f ? { imdbId: f.id, title: f.l || '', year: String(f.y || '') } : null;
}

// ─── 3-way Race ──────────────────────────────────────────────────────────────

async function raceResolve(type, tt, key) {
  const p = [];
  if (key) p.push(tmdbMeta(type, tt, key).then(m => m ? { s: 'tmdb', ...m } : null));
  p.push(fetchJSON(`https://v3-cinemeta.strem.io/meta/${type}/${tt}.json`, 8000).then(c => c?.meta?.name ? { s: 'cinemeta', title: c.meta.name, year: String(c.meta.year || '').slice(0, 4) } : null));
  p.push(imdbSuggest(tt).then(r => r ? { s: 'imdb', ...r } : null));
  try { return await Promise.any(p.filter(Boolean)); } catch { return null; }
}

async function raceSearch(type, title, year, key) {
  const p = [imdbSuggest(title).then(r => r?.imdbId ? { s: 'imdb', ...r } : null)];
  if (key) p.push(tmdbSearch(type, title, year, key).then(m => m ? { s: 'tmdb', ...m } : null));
  try { return await Promise.any(p.filter(Boolean)); } catch { return null; }
}

// ─── BanglaPlex domain detection ─────────────────────────────────────────────

async function detectDomain() {
  if (BP_OVERRIDE) { BP_BASE = BP_OVERRIDE.replace(/\/+$/, ''); return; }
  for (const d of BP_DOMAINS) {
    const h = await fetchWithFallback(d + '/', 8000);
    if (h && (h.includes('BanglaPlex') || h.includes('banglaplex'))) {
      const c = h.match(/canonical.*?href="([^"]+)"/);
      BP_BASE = c ? new URL(c[1]).origin : d;
      console.log(`BanglaPlex: ${BP_BASE}`);
      return;
    }
  }
  BP_BASE = BP_DOMAINS[0];
}

// ─── BanglaPlex scraper ──────────────────────────────────────────────────────

function parseMovieList(html) {
  const movies = [];
  const re = /<a\s+href="(https?:\/\/[^"]*\/watch\/[^"]+)"[^>]*>[\s\S]*?<img\s+src="([^"]*)"[^>]*alt="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const t = he(m[3]);
    if (t && !movies.some(x => x.url === m[1])) movies.push({ title: t, url: m[1], poster: m[2] });
  }
  const blocks = html.split(/class="movie-container"/);
  for (let i = 1; i < blocks.length && i - 1 < movies.length; i++) {
    const ym = blocks[i].match(/video_year_movie[^>]*>[\s\S]*?(\d{4})/);
    const qm = blocks[i].match(/video_quality_movie[^>]*>[\s\S]*?>([^<]+)</);
    if (ym) movies[i - 1].year = ym[1];
    if (qm) movies[i - 1].quality = qm[1].trim();
  }
  return movies;
}

function parseWatch(html, url) {
  const tm = html.match(/<title>([^<]+)/);
  const ft = tm ? he(tm[1].replace(/\s*[–\-].*$/, '').trim()) : '';
  const mm = ft.match(/^(.+?)\s*\((\d{4})\)/);
  const pm = html.match(/og:image.*?content="([^"]+)"/);
  const dm = html.match(/Director:<\/strong>\s*<a[^>]*>([^<]+)/);
  const qp = [];
  const rm = ft.match(/(4K|2160p|1080p|720p|480p|UHD)/i);
  if (rm) qp.push(rm[1].toUpperCase());
  const sm = ft.match(/(AMZN|Netflix|DSNP|ATVP|HMAX|WEB-DL|BluRay|HDRip|WEBRip|HDTC)/i);
  if (sm) qp.push(sm[1]);
  const em = html.match(/iframe[^>]*src="(https?:\/\/[^"]*embed[^"]*)"/i) || html.match(/video-embed-container[\s\S]*?iframe[^>]*src="([^"]+)"/);
  return { title: mm ? mm[1].trim() : ft, year: mm ? mm[2] : '', poster: pm?.[1] || '', quality: qp.join(' ') || 'HD', director: dm ? he(dm[1]) : '', embedUrl: em?.[1] || '', watchUrl: url };
}

function he(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n, 10)); }

// ─── Embed chain resolver (with proxy fallback) ──────────────────────────────

async function resolveEmbed(embedUrl) {
  if (!embedUrl) return [];
  const html = await fetchWithFallback(embedUrl, 15000);
  if (!html) return [];
  const servers = [];
  const re = /(?:changeServer|src)\s*[\(=]?\s*['"]?(https?:\/\/[^'")\s]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    if (u && !/gstatic|google|cloudflare|recaptcha/.test(u)) servers.push(u);
  }
  const ir = /iframe[^>]*src="(https?:\/\/[^"]+)"/g;
  while ((m = ir.exec(html))) {
    if (!/gstatic|google|cloudflare|recaptcha/.test(m[1])) servers.push(m[1]);
  }
  return [...new Set(servers)];
}

// ─── BanglaPlex search ───────────────────────────────────────────────────────

async function searchBP(q) {
  if (!BP_BASE) return [];
  const d = await fetchJSON(`${BP_BASE}//home/autocompleteajax?term=${encodeURIComponent(q)}`, 8000);
  return Array.isArray(d) ? d.map(i => ({ title: i.title || '', type: i.type || 'Movie', image: i.image || '', url: i.url || '' })) : [];
}

// ─── Stream resolver (returns DIRECT URLs, zero bandwidth) ───────────────────

async function resolveStream(type, id, tmdbKey) {
  const cached = resolveCache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.streams;

  let title = '', year = '';
  if (id.startsWith('tt')) {
    const w = await raceResolve(type, id, tmdbKey);
    if (w) { title = w.title; year = w.year; }
  } else if (id.startsWith('bp_')) {
    const cat = catalogCache.get(tmdbKey || '_');
    const item = cat?.data?.find(c => c.id === id);
    if (item) {
      const streams = [{ name: `[ BanglaPlex ] ${item._q}`, title: `${item.name} (${item.year || '?'})`, url: item._u }];
      resolveCache.set(id, { streams, at: Date.now() });
      return streams;
    }
    return [];
  }
  if (!title) return [];

  const results = await searchBP(title);
  if (!results.length) return [];

  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(title);
  let best = results.find(r => { const rn = norm(r.title); return rn === t || rn.includes(t) || t.includes(rn); }) || results[0];

  // Fetch watch page (with proxy fallback if IP flagged)
  const wh = await fetchWithFallback(best.url, 15000);
  if (!wh) {
    const streams = [{ name: '[ BanglaPlex ] HD', title: `${best.title}`, url: best.url }];
    resolveCache.set(id, { streams, at: Date.now() });
    return streams;
  }
  const info = parseWatch(wh, best.url);

  // Resolve embed chain → DIRECT video URLs (with proxy fallback)
  const servers = await resolveEmbed(info.embedUrl);
  const streams = (servers.length ? servers : [info.watchUrl]).map((url, i) => ({
    name: `[ BanglaPlex ] ${info.quality}`,
    title: `${info.title} (${info.year || '?'})${info.director ? ' · ' + info.director : ''}${servers.length > 1 ? ` [S${i + 1}]` : ''}`,
    url, // DIRECT URL — Stremio fetches from BanglaPlex CDN, not from us
    poster: info.poster || undefined,
    behaviorHints: { notWebReady: false, bingeGroup: `bp-${id}` },
  }));

  resolveCache.set(id, { streams, at: Date.now() });
  return streams;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

const catalogCache = new Map();
const CAT_TTL = 3600000;

async function buildCatalog(key) {
  const ck = key || '_';
  const c = catalogCache.get(ck);
  if (c && Date.now() - c.at < CAT_TTL) return c.data;
  if (!BP_BASE) return [];
  const html = await fetchWithFallback(BP_BASE + '/', 15000);
  if (!html) return [];
  const movies = parseMovieList(html);
  const mapped = [];
  for (const m of movies.slice(0, 25)) {
    let id = `bp_${Buffer.from(m.url).toString('base64url').slice(0, 20)}`;
    const w = await raceSearch('movie', m.title, m.year, key);
    if (w?.imdbId) id = w.imdbId;
    mapped.push({ id, type: 'movie', name: m.title, year: m.year ? +m.year : undefined, poster: m.poster || undefined, posterShape: 'poster', description: m.quality ? `[ ${m.quality} ]` : undefined, _u: m.url, _q: m.quality || '' });
  }
  catalogCache.set(ck, { data: mapped, at: Date.now() });
  return mapped;
}

// ─── Manifest ────────────────────────────────────────────────────────────────

function manifest() {
  return {
    id: 'community.banglaplex', version: CODE_VERSION, name: 'BanglaPlex',
    description: 'Bengali, Bollywood, South Indian & Hollywood streams. Zero server bandwidth — video plays directly from source.',
    resources: ['stream', { name: 'catalog', type: 'movie', id: 'banglaplex' }],
    types: ['movie', 'series'], idPrefixes: ['tt', 'bp_'],
    catalogs: [{ id: 'banglaplex', type: 'movie', name: 'BanglaPlex', extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false, options: ['bengali-movies', 'bollywood-movies', 'south-indian-movies', 'hollywood-movies', 'dual-audio-movies', 'bengali-web-series'] }] }],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

// ─── Catalog handler ──────────────────────────────────────────────────────────

async function handleCatalog(type, id, extra, key) {
  if (type !== 'movie' || id !== 'banglaplex') return { metas: [] };
  if (extra?.search) {
    const r = await searchBP(extra.search);
    const metas = [];
    for (const x of r.slice(0, 20)) {
      const w = await raceSearch('movie', x.title, '', key);
      metas.push({ id: w?.imdbId || `bp_${Buffer.from(x.url).toString('base64url').slice(0, 20)}`, type: 'movie', name: x.title, poster: x.image || undefined, posterShape: 'poster' });
    }
    return { metas };
  }
  const genre = extra?.genre;
  const url = genre ? `${BP_BASE}/genre/${genre}.html` : BP_BASE + '/';
  const html = await fetchWithFallback(url, 15000);
  if (!html) return { metas: [] };
  const movies = parseMovieList(html);
  const metas = [];
  for (const m of movies.slice(0, 20)) {
    const w = await raceSearch('movie', m.title, m.year, key);
    metas.push({ id: w?.imdbId || `bp_${Buffer.from(m.url).toString('base64url').slice(0, 20)}`, type: 'movie', name: m.title, year: m.year ? +m.year : undefined, poster: m.poster || undefined, posterShape: 'poster', description: m.quality ? `[ ${m.quality} ]` : undefined });
  }
  return { metas };
}

// ─── Configure page ───────────────────────────────────────────────────────────

function configurePage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BanglaPlex Configure</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0b;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.c{background:#16161a;border:1px solid #2a2a30;border-radius:16px;padding:40px;max-width:520px;width:90%}h1{font-size:28px;color:#ff277d;margin-bottom:4px}h2{font-size:14px;color:#888;font-weight:400;margin-bottom:24px}label{display:block;font-size:13px;color:#aaa;margin:16px 0 6px}input{width:100%;padding:12px 16px;border-radius:8px;border:1px solid #2a2a30;background:#0a0a0b;color:#fff;font-size:15px;outline:none}input:focus{border-color:#ff277d}.h{font-size:12px;color:#666;margin-top:6px;line-height:1.4}.h a{color:#ff277d}.b{display:block;width:100%;background:#ff277d;color:#fff;padding:14px;border-radius:8px;font-size:16px;font-weight:600;margin-top:24px;cursor:pointer;border:none;text-align:center}.b:hover{background:#e0106a}.b:disabled{background:#333;cursor:not-allowed}.o{display:flex;align-items:center;gap:12px;margin:20px 0;color:#555;font-size:13px}.o::before,.o::after{content:'';flex:1;height:1px;background:#2a2a30}.s{margin-top:12px;padding:10px;border-radius:8px;font-size:13px;display:none}.s.ok{display:block;background:#0d2818;border:1px solid #1a5c2e;color:#4ade80}.s.err{display:block;background:#2d0a0a;border:1px solid #5c1a1a;color:#f87171}.u{width:100%;padding:10px;border-radius:8px;background:#0a0a0b;border:1px solid #2a2a30;color:#4ade80;font-size:12px;font-family:monospace;word-break:break-all;margin-top:8px;cursor:pointer}.bd{display:inline-block;background:#ff277d;color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;margin:2px}.f{margin-top:20px;text-align:center;font-size:12px;color:#444}</style></head><body>
<div class="c"><h1>🎬 BanglaPlex</h1><h2>Stremio Addon</h2>
<div style="margin-bottom:16px"><span class="bd">Movies</span><span class="bd">Series</span><span class="bd">Bengali</span><span class="bd">HD</span><span class="bd">0 bandwidth</span></div>
<label>TMDb API Key (optional)</label>
<input id="k" placeholder="e.g. 8265bd1679663a7ea12ac168da84d2e8" autocomplete="off" spellcheck="false">
<div class="h">Free at <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org</a>. Encoded in URL, never stored. Without it, IMDb suggestion API is used (works great!).</div>
<button class="b" id="btn" onclick="go()">Install in Stremio</button><div id="st" class="s"></div>
<div id="mu" style="display:none"><div class="o">or copy URL</div><input class="u" id="iu" readonly onclick="this.select()"></div>
<div class="o">or skip</div><button class="b" style="background:#2a2a30" onclick="noKey()">Install without TMDB key</button>
<div class="f">Domain: ${BP_BASE || '…'} · v${CODE_VERSION} · 0 bandwidth</div></div>
<script>const h=location.origin;
function ss(t,m){const e=document.getElementById('st');e.className='s '+t;e.textContent=m;e.style.display='block'}
async function go(){const k=document.getElementById('k').value.trim();if(k&&k.length<20){ss('err','Key too short.');return}
const b=document.getElementById('btn');if(k){b.disabled=true;b.textContent='Validating…';try{const r=await fetch(h+'/validate-key?key='+encodeURIComponent(k));const d=await r.json();if(!d.valid){ss('err','Invalid key.');b.disabled=false;b.textContent='Install in Stremio';return}}catch{ss('err','Validation failed.');b.disabled=false;b.textContent='Install in Stremio';return}}
const u=k?h+'/'+encodeURIComponent(k)+'/manifest.json':h+'/manifest.json';try{location.href='stremio://'+u.replace(/^https?:\\/\\//,'')}catch{}
document.getElementById('mu').style.display='block';document.getElementById('iu').value=u;b.disabled=false;b.textContent='Install in Stremio'}
function noKey(){const u=h+'/manifest.json';try{location.href='stremio://'+u.replace(/^https?:\\/\\//,'')}catch{}document.getElementById('mu').style.display='block';document.getElementById('iu').value=u}</script></body></html>`;
}

// ─── Router ──────────────────────────────────────────────────────────────────

async function route(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const raw = u.pathname || '/';
  const p = raw.replace(/\/+$/, '') || '/';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  try {
    if (p === '/configure' || p === '/config' || p === '/setup') return htmlPage(res, configurePage());
    if (p === '/validate-key') return json(res, { valid: await validateKey(u.searchParams.get('key') || '') });

    const seg = raw.split('/').filter(Boolean);
    let tmdbKey = '', pp = p;
    if (seg.length >= 1 && /^[a-f0-9]{32}$/i.test(decodeURIComponent(seg[0]))) { tmdbKey = decodeURIComponent(seg[0]); pp = '/' + seg.slice(1).join('/'); }

    if (pp === '/manifest.json' || pp === '/manifest') return json(res, manifest());

    const cm = pp.match(/^\/catalog\/([^/]+)\/([^/]+)\.json$/);
    if (cm) { const ex = {}; for (const [k, v] of u.searchParams) ex[k] = v; return json(res, await handleCatalog(cm[1], cm[2], ex, tmdbKey)); }

    const sm = pp.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (sm) return json(res, { streams: await resolveStream(sm[1], sm[2], tmdbKey) });

    if (pp === '/health') return json(res, { status: 'ok', version: CODE_VERSION, banglaplex: BP_BASE || '…', proxyPool: PROXY_POOL.length ? `${PROXY_POOL.length} proxies` : 'none', cache: resolveCache.size, uptime: Math.round(process.uptime()) });

    if (p === '/' || p === '') return htmlPage(res, `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BanglaPlex</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0b;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.c{background:#16161a;border:1px solid #2a2a30;border-radius:16px;padding:40px;max-width:480px;text-align:center}h1{font-size:28px;color:#ff277d;margin-bottom:8px}p{color:#888;margin-bottom:16px}.bd{display:inline-block;background:#ff277d;color:#fff;padding:4px 12px;border-radius:20px;font-size:13px;margin:4px}a.b{display:inline-block;background:#ff277d;color:#fff;padding:12px 32px;border-radius:8px;font-size:16px;font-weight:600;margin-top:16px;text-decoration:none}pre{background:#1a1a20;padding:12px;border-radius:8px;text-align:left;font-size:13px;margin-top:16px;color:#aaa}</style></head><body>
<div class="c"><h1>🎬 BanglaPlex</h1><p>Stremio addon — zero server bandwidth</p>
<div><span class="bd">Movies</span><span class="bd">Series</span><span class="bd">0 BW</span></div><br><a class="b" href="/configure">Configure & Install</a>
<pre>Domain: ${BP_BASE || '…'}\nProxy:  ${PROXY_POOL.length ? PROXY_POOL.length + ' fallback' : 'none'}\nV: ${CODE_VERSION}</pre></div></body></html>`);

    jsonErr(res, 404, 'not found');
  } catch (e) { console.error('ERR:', e.message); jsonErr(res, 500, 'internal'); }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  await detectDomain();
  console.log(`BanglaPlex v${CODE_VERSION} port ${PORT} | ${BP_BASE} | proxy: ${PROXY_POOL.length || 'none'}`);
  http.createServer(route).listen(PORT, '0.0.0.0', () => console.log(`Ready on :${PORT}`));
}
start().catch(e => { console.error(e); process.exit(1); });
