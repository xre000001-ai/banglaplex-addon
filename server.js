#!/usr/bin/env node
// BanglaPlex Stremio Addon v2.1.0 — zero-dependency Node.js (18+)
//
// PROXY POOL (from moviebox-stremio):
//   - ProxyScrape free proxy list (~1800 proxies, auto-refreshed every 4 min)
//   - Probes CONNECT-aliveness in parallel, caches top 20 fastest
//   - Pool learning: ok/fail/latency tracking per proxy
//   - Bad proxy benching: dead=10min, blocked=15min
//   - Sticky sessions: last good proxy reused 90s
//   - Scoring: quality * speed (Laplace-smoothed success rate × EWMA latency)
//   - Manual proxy list support via PROXY_POOL env var
//
// ZERO BANDWIDTH: server only resolves tiny JSON/HTML, video plays direct.

'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const net = require('node:net');

const CODE_VERSION = '2.1.0';
const PORT = parseInt(process.env.PORT, 10) || 7000;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_SPACING_MS = 300;

const BP_DOMAINS = ['https://banglaplex.biz', 'https://banglaplex.life', 'https://banglaplex.me', 'https://banglaplex.space'];
const BP_OVERRIDE = process.env.BANGLAPLEX_URL || '';

// ─── Free Proxy Pool (moviebox-stremio architecture) ─────────────────────────

const POOL_SRC = process.env.PROXY_SOURCE ||
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text';

// Manual proxy list (comma-separated) — overrides free pool if set
const MANUAL_PROXIES = (process.env.PROXY_POOL || '').split(',').map(s => s.trim()).filter(Boolean);

let pool = [];                    // alive free proxies (auto-refreshed)
let poolTS = 0;                   // last refresh start (throttle: 4 min)
const POOL_REFRESH_MS = 4 * 60 * 1000;
const POOL_MAX = 20;              // max cached proxies
const POOL_PROBE_TIMEOUT = 5000;  // CONNECT probe timeout

// Pool learning (from moviebox v1.7.0)
const poolStats = {};  // url → { ok, fail, lat }
const poolBad = {};    // url → benched-until timestamp
let poolSticky = null; // last good url
let poolStickyUntil = 0;

const BAD_BENCH_MS = 10 * 60 * 1000;   // dead proxy: bench 10 min
const BLOCKED_BENCH_MS = 15 * 60 * 1000; // 403/406: bench 15 min
const STICKY_MS = 90 * 1000;            // sticky session: 90s

// ─── Pool: fetch + probe + score ─────────────────────────────────────────────

async function poolRefresh() {
  const now = Date.now();
  if (now - poolTS < POOL_REFRESH_MS) return;
  poolTS = now;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(POOL_SRC, { signal: ctrl.signal, headers: { 'User-Agent': 'banglaplex/2.1' } });
    clearTimeout(t);
    if (!r.ok) return;
    const text = await r.text();
    const candidates = text.replace(/\r/g, '').split('\n')
      .map(u => u.trim())
      .filter(u => u.startsWith('http://'))
      .slice(0, 200);
    if (!candidates.length) return;

    // Sample 100 random candidates
    const sample = shuffle(candidates).slice(0, 100);

    // Probe in parallel (25 workers)
    const alive = [];
    const batchSize = 25;
    for (let i = 0; i < sample.length; i += batchSize) {
      const batch = sample.slice(i, i + batchSize);
      const results = await Promise.allSettled(batch.map(u => probeProxy(u)));
      for (let j = 0; j < batch.length; j++) {
        const res = results[j];
        if (res.status === 'fulfilled' && res.value.alive) {
          alive.push({ url: batch[j], lat: res.value.lat });
        }
      }
    }

    // Sort by latency, take top POOL_MAX
    alive.sort((a, b) => a.lat - b.lat);
    const prev = pool.filter(u => (poolBad[u] || 0) <= now);
    const merged = [...new Set([...prev, ...alive.map(a => a.url)])].slice(0, POOL_MAX);
    pool = merged;

    // Seed stats for new probes
    for (const { url, lat } of alive) {
      const st = poolStats[url] || (poolStats[url] = { ok: 0, fail: 0, lat: null });
      st.ok++;
      st.lat = st.lat === null ? lat : Math.round(0.6 * st.lat + 0.4 * lat);
      delete poolBad[url];
    }

    // Prune stale stats
    const keep = new Set([...pool, ...Object.keys(poolBad).filter(u => poolBad[u] > now)]);
    for (const key of Object.keys(poolStats)) {
      if (!keep.has(key)) delete poolStats[key];
    }

    console.log(`Pool refreshed: ${pool.length} alive (${alive.length} new, ${prev.length} carried)`);
  } catch (e) {
    console.warn('Pool refresh failed:', e.message);
  }
}

async function probeProxy(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    const start = Date.now();
    const sock = net.createConnection({ host: u.hostname, port: parseInt(u.port, 10) || 80 });
    const result = await new Promise((resolve) => {
      const t = setTimeout(() => { sock.destroy(); resolve({ alive: false }); }, POOL_PROBE_TIMEOUT);
      sock.on('connect', () => { clearTimeout(t); sock.destroy(); resolve({ alive: true, lat: Date.now() - start }); });
      sock.on('error', () => { clearTimeout(t); resolve({ alive: false }); });
    });
    return result;
  } catch { return { alive: false }; }
}

function poolPick() {
  const now = Date.now();
  const all = MANUAL_PROXIES.length ? MANUAL_PROXIES : pool;
  if (!all.length) return null;

  // Sticky: reuse last good proxy
  if (poolSticky && poolStickyUntil > now && all.includes(poolSticky)) return poolSticky;

  // Filter out benched
  const healthy = all.filter(u => (poolBad[u] || 0) <= now);

  function score(u) {
    const st = poolStats[u] || { ok: 0, fail: 0, lat: 4000 };
    const quality = (st.ok + 1) / (st.ok + st.fail + 2);
    const lat = st.lat || 4000;
    return quality * (4000 / Math.max(lat, 250));
  }

  let pick;
  if (healthy.length) {
    pick = healthy.sort((a, b) => score(b) - score(a))[0];
  } else if (all.length) {
    pick = all[Math.floor(Math.random() * all.length)]; // everything benched: try anyway
  } else {
    return null;
  }

  poolSticky = pick;
  poolStickyUntil = now + STICKY_MS;
  return pick;
}

function poolNote(url, ok, ms) {
  if (!url) return;
  const st = poolStats[url] || (poolStats[url] = { ok: 0, fail: 0, lat: null });
  if (ok) {
    st.ok++;
    st.lat = st.lat === null ? ms : Math.round(0.6 * st.lat + 0.4 * ms);
    delete poolBad[url];
    poolSticky = url;
    poolStickyUntil = Date.now() + STICKY_MS;
  } else {
    st.fail++;
    poolBad[url] = Date.now() + BAD_BENCH_MS;
    if (poolSticky === url) { poolSticky = null; poolStickyUntil = 0; }
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ─── State ────────────────────────────────────────────────────────────────────

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

// ─── HTTP client with proxy pool fallback ─────────────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function fetchWithFallback(url, timeoutMs = 12000) {
  // Try direct first
  let result = await doFetch(url, null, timeoutMs);
  if (result) return result;

  // Fallback: HTTP CONNECT tunnel through free proxy pool
  if (url.startsWith('https://')) {
    result = await tunnelFetchWithPool(url, timeoutMs);
    if (result) return result;
  }
  return null;
}

async function doFetch(url, _unused, timeoutMs) {
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

// HTTP CONNECT tunnel — for when server IP is blocked by BanglaPlex
// Routes HTTPS requests through free proxy via CONNECT tunneling
function tunnelFetch(proxyUrl, targetUrl, timeoutMs = 15000) {
  const net = require('net');
  const tls = require('tls');
  return new Promise((resolve, reject) => {
    const pu = new URL(proxyUrl);
    const tu = new URL(targetUrl);
    const ctrl = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs);
    const sock = net.createConnection({ host: pu.hostname, port: parseInt(pu.port) || 80 });
    sock.on('error', (e) => { clearTimeout(ctrl); reject(e); });
    sock.on('connect', () => {
      sock.write('CONNECT ' + tu.hostname + ':443 HTTP/1.1\r\nHost: ' + tu.hostname + ':443\r\n\r\n');
      let buf = '';
      const onConnect = (chunk) => {
        buf += chunk.toString();
        if (!buf.includes('\r\n\r\n')) return;
        sock.removeListener('data', onConnect);
        if (!buf.startsWith('HTTP/1.1 200')) {
          clearTimeout(ctrl); sock.destroy();
          return reject(new Error('CONNECT: ' + buf.split('\r\n')[0]));
        }
        const tlsSock = tls.connect({ socket: sock, servername: tu.hostname, rejectUnauthorized: false }, () => {
          const path = tu.pathname + tu.search;
          tlsSock.write('GET ' + path + ' HTTP/1.1\r\nHost: ' + tu.hostname + '\r\nUser-Agent: ' + UA + '\r\nAccept: */*\r\nConnection: close\r\n\r\n');
          let resp = '';
          tlsSock.on('data', (d) => { resp += d.toString(); });
          tlsSock.on('end', () => {
            clearTimeout(ctrl);
            const parts = resp.split('\r\n\r\n');
            let body = parts.slice(1).join('\r\n\r\n');
            // Decode chunked
            if (parts[0].toLowerCase().includes('transfer-encoding: chunked')) {
              let decoded = '', pos = 0;
              while (pos < body.length) {
                const le = body.indexOf('\r\n', pos);
                if (le === -1) break;
                const sz = parseInt(body.slice(pos, le), 16);
                if (!sz) break;
                pos = le + 2;
                decoded += body.slice(pos, pos + sz);
                pos += sz + 2;
              }
              body = decoded;
            }
            resolve(body);
          });
        });
        tlsSock.on('error', (e) => { clearTimeout(ctrl); reject(e); });
      };
      sock.on('data', onConnect);
    });
  });
}

async function tunnelFetchWithPool(url, timeoutMs = 15000) {
  // Try up to 5 proxies from the pool
  const tried = new Set();
  for (let i = 0; i < 5; i++) {
    const proxy = poolPick();
    if (!proxy || tried.has(proxy)) continue;
    tried.add(proxy);
    try {
      const start = Date.now();
      const body = await tunnelFetch(proxy, url, timeoutMs);
      poolNote(proxy, true, Date.now() - start);
      return body;
    } catch (e) {
      poolNote(proxy, false);
    }
  }
  return null;
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
    const r = await fetch(`${TMDB_BASE}${path}${sep}api_key=${encodeURIComponent(key)}`, { signal: ctrl.signal, headers: { 'User-Agent': 'banglaplex/2.1' } });
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

// ─── BanglaPlex ──────────────────────────────────────────────────────────────

async function detectDomain() {
  if (BP_OVERRIDE) { BP_BASE = BP_OVERRIDE.replace(/\/+$/, ''); return; }
  for (const d of BP_DOMAINS) {
    try {
      // Verify autocomplete API actually works (not just a landing page)
      // Use fetchWithFallback since Render IP may be blocked
      const testText = await fetchWithFallback(`${d}//home/autocompleteajax?term=test`, 10000);
      let data = null; try { data = JSON.parse(testText); } catch {}
      if (Array.isArray(data) && data.length > 0) {
        BP_BASE = d;
        console.log(`BanglaPlex: ${BP_BASE} (autocomplete OK, ${data.length} results)`);
        return;
      }
      // Fallback: check for actual watch links (not just landing page)
      const h = await fetchWithFallback(d + '/', 8000);
      if (h && h.includes('/watch/') && h.includes('movie-container')) {
        BP_BASE = d;
        console.log(`BanglaPlex: ${BP_BASE} (content detected)`);
        return;
      }
    } catch (e) {
      console.warn(`BanglaPlex ${d}: ${e.message}`);
    }
  }
  BP_BASE = BP_DOMAINS[0];
  console.warn(`BanglaPlex: fallback to ${BP_BASE}`);
}

function parseMovieList(html) {
  const movies = [];
  const re = /<a\s+href="(https?:\/\/[^"]*\/watch\/[^"]+)"[^>]*>[\s\S]*?<img\s+src="([^"]*)"[^>]*alt="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) { const t = he(m[3]); if (t && !movies.some(x => x.url === m[1])) movies.push({ title: t, url: m[1], poster: m[2] }); }
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
  const rm = ft.match(/(4K|2160p|1080p|720p|480p|UHD)/i); if (rm) qp.push(rm[1].toUpperCase());
  const sm = ft.match(/(AMZN|Netflix|DSNP|ATVP|HMAX|WEB-DL|BluRay|HDRip|WEBRip|HDTC)/i); if (sm) qp.push(sm[1]);
  const em = html.match(/iframe[^>]*src="(https?:\/\/[^"]*embed[^"]*)"/i) || html.match(/video-embed-container[\s\S]*?iframe[^>]*src="([^"]+)"/);
  return { title: mm ? mm[1].trim() : ft, year: mm ? mm[2] : '', poster: pm?.[1] || '', quality: qp.join(' ') || 'HD', director: dm ? he(dm[1]) : '', embedUrl: em?.[1] || '', watchUrl: url };
}

function he(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n, 10)); }

// ─── AES-CTR decrypt for abyssplayer media blob ─────────────────────────────
const tls = require('node:tls');
const crypto2 = require('node:crypto');

function b64Pad(s) { const r = s.length % 4; return r ? s + '='.repeat(4 - r) : s; }

async function decryptAbyssMedia(blob, keyStr) {
  try {
    const md5hex = crypto2.createHash('md5').update(keyStr).digest('hex');
    const keyBytes = new TextEncoder().encode(md5hex);
    const counter = new Uint8Array(keyBytes.slice(0, 16));
    const encBytes = new Uint8Array(blob.media.length);
    for (let i = 0; i < blob.media.length; i++) encBytes[i] = blob.media.charCodeAt(i);
    const key = await crypto2.webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR', length: 128 }, false, ['decrypt']);
    const algo = { name: 'AES-CTR', counter, length: 128 };
    const dec = await crypto2.webcrypto.subtle.decrypt(algo, key, encBytes);
    return JSON.parse(new TextDecoder().decode(dec));
  } catch (e) { return null; }
}

// ─── Full embed resolution: plextream → abyssplayer → decrypt → direct URLs ──
async function resolveEmbed(embedUrl) {
  if (!embedUrl) return [];
  // Step 1: fetch plextream embed page to find abyssplayer iframe
  const html = await fetchWithFallback(embedUrl, 15000);
  if (!html) return [];

  // Find abyssplayer iframe slug
  const abyssMatch = html.match(/abyssplayer\.com\/([a-zA-Z0-9]+)/);
  if (!abyssMatch) {
    // Fallback: extract any playable URLs from the page
    const servers = [];
    const ir = /iframe[^>]*src="(https?:\/\/[^"]+)"/g;
    let m;
    while ((m = ir.exec(html))) { if (!/gstatic|google|cloudflare|recaptcha/.test(m[1])) servers.push(m[1]); }
    return servers;
  }

  const abyssSlug = abyssMatch[1];

  // Step 2: fetch abyssplayer page
  const abyssHtml = await fetchWithFallback(`https://abyssplayer.com/${abyssSlug}`, 15000);
  if (!abyssHtml) return [];

  // Step 3: extract encrypted blob (base64, decoded as latin1!)
  const datasMatch = abyssHtml.match(/const datas = "([^"]+)"/);
  if (!datasMatch) return [];
  let blob;
  try {
    blob = JSON.parse(Buffer.from(datasMatch[1], 'base64').toString('latin1'));
  } catch (e) { return []; }

  // Step 4: derive key and decrypt
  const keyStr = `${blob.user_id}:${blob.slug}:${blob.md5_id}`;
  const media = await decryptAbyssMedia(blob, keyStr);
  if (!media) return [];

  // Step 5: extract direct video URLs from fristDatas or sources
  const urls = [];
  const mp4 = media.mp4 || media;
  if (mp4.fristDatas) {
    for (const fd of mp4.fristDatas) {
      if (fd.url) {
        const codec = fd.codec || 'h264';
        const quality = fd.res_id <= 2 ? '360p' : fd.res_id <= 4 ? '720p' : '1080p';
        urls.push({ url: fd.url, quality, codec, size: fd.size });
      }
    }
  }
  // Fallback: try sources with domain construction
  if (!urls.length && mp4.sources && mp4.domains) {
    for (const src of mp4.sources) {
      if (src.sub && mp4.domains.some(d => d.startsWith(src.sub))) {
        const domain = mp4.domains.find(d => d.startsWith(src.sub));
        urls.push({ url: `https://${domain}`, quality: src.label || 'HD', codec: src.codec || 'h264', size: src.size });
      }
    }
  }
  return urls;
}

async function searchBP(q) {
  if (!BP_BASE) return [];
  // Use fetchWithFallback (CONNECT tunnel) since Render IP is blocked by BanglaPlex
  const text = await fetchWithFallback(`${BP_BASE}//home/autocompleteajax?term=${encodeURIComponent(q)}`, 10000);
  if (!text) return [];
  try {
    const d = JSON.parse(text);
    return Array.isArray(d) ? d.map(i => ({ title: i.title || '', type: i.type || 'Movie', image: i.image || '', url: i.url || '' })) : [];
  } catch { return []; }
}

// ─── Stream resolver (direct URLs) ───────────────────────────────────────────

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
    if (item) { const streams = [{ name: `[ BanglaPlex ] ${item._q}`, title: `${item.name} (${item.year || '?'})`, url: item._u }]; resolveCache.set(id, { streams, at: Date.now() }); return streams; }
    return [];
  }
  if (!title) return [];

  const results = await searchBP(title);
  if (!results.length) return [];

  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(title);
  let best = results.find(r => { const rn = norm(r.title); return rn === t || rn.includes(t) || t.includes(rn); }) || results[0];

  const wh = await fetchWithFallback(best.url, 15000);
  if (!wh) { const streams = [{ name: '[ BanglaPlex ] HD', title: best.title, url: best.url }]; resolveCache.set(id, { streams, at: Date.now() }); return streams; }
  const info = parseWatch(wh, best.url);

  const embedUrls = await resolveEmbed(info.embedUrl);
  const streams = [];
  
  if (embedUrls.length) {
    // Direct video URLs from decrypted abyssplayer
    for (const eu of embedUrls) {
      if (typeof eu === 'string') {
        streams.push({
          name: `[ BanglaPlex ] ${info.quality}`,
          title: `${info.title} (${info.year || '?'})`,
          url: eu, poster: info.poster || undefined,
          behaviorHints: { notWebReady: false, bingeGroup: `bp-${id}` },
        });
      } else {
        const qLabel = eu.quality || info.quality;
        const codecTag = eu.codec && eu.codec !== 'h264' ? ` [${eu.codec.toUpperCase()}]` : '';
        const sizeStr = eu.size ? ` (${(eu.size / 1e9).toFixed(1)}GB)` : '';
        // Proxy through server with Referer header (CDN requires abyssplayer referer)
        // URL is relative — will be resolved by Stremio against the addon base URL
        const proxyPath = `/proxy?url=${encodeURIComponent(eu.url)}`;
        streams.push({
          name: `[ BanglaPlex ] ${qLabel}${codecTag}`,
          title: `${info.title} (${info.year || '?'})${sizeStr}`,
          url: proxyPath, poster: info.poster || undefined,
          behaviorHints: { notWebReady: false, bingeGroup: `bp-${id}` },
        });
      }
    }
  }
  
  if (!streams.length) {
    // Fallback: use watch page URL
    streams.push({
      name: `[ BanglaPlex ] ${info.quality}`,
      title: `${info.title} (${info.year || '?'})`,
      url: info.watchUrl,
      behaviorHints: { notWebReady: true, bingeGroup: `bp-${id}` },
    });
  }

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

// ─── Manifest + Config ───────────────────────────────────────────────────────

function manifest() {
  return {
    id: 'community.banglaplex', version: CODE_VERSION, name: 'BanglaPlex',
    description: 'Bengali, Bollywood, South Indian & Hollywood. Zero bandwidth — video direct from CDN. Free proxy pool for IP protection.',
    resources: ['stream', { name: 'catalog', type: 'movie', id: 'banglaplex' }],
    types: ['movie', 'series'], idPrefixes: ['tt', 'bp_'],
    catalogs: [{ id: 'banglaplex', type: 'movie', name: 'BanglaPlex', extra: [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false, options: ['bengali-movies', 'bollywood-movies', 'south-indian-movies', 'hollywood-movies', 'dual-audio-movies', 'bengali-web-series'] }] }],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

async function handleCatalog(type, id, extra, key) {
  if (type !== 'movie' || id !== 'banglaplex') return { metas: [] };
  if (extra?.search) {
    const r = await searchBP(extra.search);
    const metas = [];
    for (const x of r.slice(0, 20)) { const w = await raceSearch('movie', x.title, '', key); metas.push({ id: w?.imdbId || `bp_${Buffer.from(x.url).toString('base64url').slice(0, 20)}`, type: 'movie', name: x.title, poster: x.image || undefined, posterShape: 'poster' }); }
    return { metas };
  }
  const genre = extra?.genre;
  const url = genre ? `${BP_BASE}/genre/${genre}.html` : BP_BASE + '/';
  const html = await fetchWithFallback(url, 15000);
  if (!html) return { metas: [] };
  const movies = parseMovieList(html);
  const metas = [];
  for (const m of movies.slice(0, 20)) { const w = await raceSearch('movie', m.title, m.year, key); metas.push({ id: w?.imdbId || `bp_${Buffer.from(m.url).toString('base64url').slice(0, 20)}`, type: 'movie', name: m.title, year: m.year ? +m.year : undefined, poster: m.poster || undefined, posterShape: 'poster', description: m.quality ? `[ ${m.quality} ]` : undefined }); }
  return { metas };
}

function configurePage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BanglaPlex Configure</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0b;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.c{background:#16161a;border:1px solid #2a2a30;border-radius:16px;padding:40px;max-width:520px;width:90%}h1{font-size:28px;color:#ff277d;margin-bottom:4px}h2{font-size:14px;color:#888;font-weight:400;margin-bottom:24px}label{display:block;font-size:13px;color:#aaa;margin:16px 0 6px}input{width:100%;padding:12px 16px;border-radius:8px;border:1px solid #2a2a30;background:#0a0a0b;color:#fff;font-size:15px;outline:none}input:focus{border-color:#ff277d}.h{font-size:12px;color:#666;margin-top:6px;line-height:1.4}.h a{color:#ff277d}.b{display:block;width:100%;background:#ff277d;color:#fff;padding:14px;border-radius:8px;font-size:16px;font-weight:600;margin-top:24px;cursor:pointer;border:none;text-align:center}.b:hover{background:#e0106a}.b:disabled{background:#333;cursor:not-allowed}.o{display:flex;align-items:center;gap:12px;margin:20px 0;color:#555;font-size:13px}.o::before,.o::after{content:'';flex:1;height:1px;background:#2a2a30}.s{margin-top:12px;padding:10px;border-radius:8px;font-size:13px;display:none}.s.ok{display:block;background:#0d2818;border:1px solid #1a5c2e;color:#4ade80}.s.err{display:block;background:#2d0a0a;border:1px solid #5c1a1a;color:#f87171}.u{width:100%;padding:10px;border-radius:8px;background:#0a0a0b;border:1px solid #2a2a30;color:#4ade80;font-size:12px;font-family:monospace;word-break:break-all;margin-top:8px;cursor:pointer}.bd{display:inline-block;background:#ff277d;color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;margin:2px}.f{margin-top:20px;text-align:center;font-size:12px;color:#444}</style></head><body>
<div class="c"><h1>🎬 BanglaPlex</h1><h2>Stremio Addon</h2>
<div style="margin-bottom:16px"><span class="bd">Movies</span><span class="bd">Series</span><span class="bd">Bengali</span><span class="bd">HD</span><span class="bd">🛡️ Proxy Pool</span></div>
<label>TMDb API Key (optional)</label>
<input id="k" placeholder="e.g. 8265bd1679663a7ea12ac168da84d2e8" autocomplete="off" spellcheck="false">
<div class="h">Free at <a href="https://www.themoviedb.org/settings/api" target="_blank">themoviedb.org</a>. Optional — IMDb suggestion works without it.</div>
<button class="b" id="btn" onclick="go()">Install in Stremio</button><div id="st" class="s"></div>
<div id="mu" style="display:none"><div class="o">or copy URL</div><input class="u" id="iu" readonly onclick="this.select()"></div>
<div class="o">or skip</div><button class="b" style="background:#2a2a30" onclick="noKey()">Install without TMDB key</button>
<div class="f">${BP_BASE || '…'} · v${CODE_VERSION} · Free proxy pool</div></div>
<script>const h=location.origin;function ss(t,m){const e=document.getElementById('st');e.className='s '+t;e.textContent=m;e.style.display='block'}
async function go(){const k=document.getElementById('k').value.trim();if(k&&k.length<20){ss('err','Key too short.');return}const b=document.getElementById('btn');if(k){b.disabled=true;b.textContent='Validating…';try{const r=await fetch(h+'/validate-key?key='+encodeURIComponent(k));const d=await r.json();if(!d.valid){ss('err','Invalid key.');b.disabled=false;b.textContent='Install';return}}catch{ss('err','Validation failed.');b.disabled=false;b.textContent='Install';return}}const u=k?h+'/'+encodeURIComponent(k)+'/manifest.json':h+'/manifest.json';try{location.href='stremio://'+u.replace(/^https?:\\/\\//,'')}catch{}document.getElementById('mu').style.display='block';document.getElementById('iu').value=u;b.disabled=false;b.textContent='Install'}
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

    // Video proxy — forwards requests with abyssplayer Referer for CDN access
    if (p === '/proxy') {
      const targetUrl = u.searchParams.get('url');
      if (!targetUrl || !targetUrl.startsWith('https://')) return jsonErr(res, 400, 'missing url');
      try {
        const https = require('node:https');
        const proxyReq = https.request(targetUrl, {
          headers: {
            'User-Agent': UA,
            'Referer': 'https://abyssplayer.com/',
            'Origin': 'https://abyssplayer.com',
            'Range': req.headers.range || '',
          },
        }, (proxyRes) => {
          if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            // Follow redirect
            const redirReq = https.request(proxyRes.headers.location, {
              headers: { 'User-Agent': UA, 'Referer': 'https://abyssplayer.com/', 'Range': req.headers.range || '' },
            }, (redirRes) => {
              const headers = { 'Content-Type': redirRes.headers['content-type'] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' };
              if (redirRes.headers['content-length']) headers['Content-Length'] = redirRes.headers['content-length'];
              if (redirRes.headers['content-range']) headers['Content-Range'] = redirRes.headers['content-range'];
              if (redirRes.headers['accept-ranges']) headers['Accept-Ranges'] = redirRes.headers['accept-ranges'];
              res.writeHead(redirRes.statusCode, headers);
              redirRes.pipe(res);
            });
            redirReq.on('error', () => jsonErr(res, 502, 'proxy error'));
            redirReq.end();
            return;
          }
          const headers = { 'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' };
          if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
          if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range'];
          if (proxyRes.headers['accept-ranges']) headers['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
          res.writeHead(proxyRes.statusCode, headers);
          proxyRes.pipe(res);
        });
        proxyReq.on('error', () => jsonErr(res, 502, 'proxy error'));
        proxyReq.end();
      } catch (e) { jsonErr(res, 502, 'proxy: ' + e.message); }
      return;
    }

    const seg = raw.split('/').filter(Boolean);
    let tmdbKey = '', pp = p;
    if (seg.length >= 1 && /^[a-f0-9]{32}$/i.test(decodeURIComponent(seg[0]))) { tmdbKey = decodeURIComponent(seg[0]); pp = '/' + seg.slice(1).join('/'); }

    if (pp === '/manifest.json' || pp === '/manifest') return json(res, manifest());

    const cm = pp.match(/^\/catalog\/([^/]+)\/([^/]+)\.json$/);
    if (cm) { const ex = {}; for (const [k, v] of u.searchParams) ex[k] = v; return json(res, await handleCatalog(cm[1], cm[2], ex, tmdbKey)); }

    const sm = pp.match(/^\/stream\/(movie|series)\/(.+)\.json$/);
    if (sm) {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host || 'localhost';
      const base = `${proto}://${host}`;
      const streams = await resolveStream(sm[1], sm[2], tmdbKey);
      // Make proxy URLs absolute
      for (const s of streams) {
        if (s.url && s.url.startsWith('/proxy')) s.url = base + s.url;
      }
      return json(res, { streams });
    }

    // Debug endpoint
    if (pp === '/debug') {
      const steps = [];
      try {
        steps.push({ step: 'domain', bp: BP_BASE });
        
        // Test autocomplete (use tunnel since Render IP is blocked)
        const acUrl = `${BP_BASE}//home/autocompleteajax?term=test`;
        steps.push({ step: 'autocomplete-url', url: acUrl });
        const acText = await fetchWithFallback(acUrl, 10000);
        let acData = null; try { acData = JSON.parse(acText); } catch {}
        steps.push({ step: 'autocomplete', ok: Array.isArray(acData), count: acData?.length || 0 });
        
        // Test homepage scrape
        const hp = await fetchWithFallback(BP_BASE + '/', 15000);
        steps.push({ step: 'homepage', ok: !!hp, len: hp?.length || 0 });
        
        if (hp) {
          const movies = parseMovieList(hp);
          steps.push({ step: 'parse', movies: movies.length, first: movies[0]?.title });
          
          // Test search
          if (movies[0]) {
            const sr = await searchBP(movies[0].title);
            steps.push({ step: 'search', ok: sr.length > 0, count: sr.length, first: sr[0]?.title });
          }
        }
        
        // Test IMDb suggest
        const imdb = await imdbSuggest('Grihostho');
        steps.push({ step: 'imdb', ok: !!imdb, id: imdb?.imdbId });
        
        // Test Cinemeta
        const cm = await fetchJSON('https://v3-cinemeta.strem.io/meta/movie/tt31325595.json', 8000);
        steps.push({ step: 'cinemeta', ok: !!cm?.meta, name: cm?.meta?.name });
        
      } catch (e) {
        steps.push({ step: 'error', msg: e.message });
      }
      return json(res, { steps });
    }
    
    if (pp === '/health') return json(res, {
      status: 'ok', version: CODE_VERSION, banglaplex: BP_BASE || '…',
      pool: { size: pool.length, healthy: pool.filter(u => (poolBad[u] || 0) <= Date.now()).length, sticky: poolSticky || 'none', source: MANUAL_PROXIES.length ? 'manual' : 'proxyscrape-free' },
      cache: resolveCache.size, uptime: Math.round(process.uptime()),
    });

    if (p === '/' || p === '') return htmlPage(res, `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BanglaPlex</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0b;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.c{background:#16161a;border:1px solid #2a2a30;border-radius:16px;padding:40px;max-width:480px;text-align:center}h1{font-size:28px;color:#ff277d;margin-bottom:8px}p{color:#888;margin-bottom:16px}.bd{display:inline-block;background:#ff277d;color:#fff;padding:4px 12px;border-radius:20px;font-size:13px;margin:4px}a.b{display:inline-block;background:#ff277d;color:#fff;padding:12px 32px;border-radius:8px;font-size:16px;font-weight:600;margin-top:16px;text-decoration:none}pre{background:#1a1a20;padding:12px;border-radius:8px;text-align:left;font-size:13px;margin-top:16px;color:#aaa}</style></head><body>
<div class="c"><h1>🎬 BanglaPlex</h1><p>Zero bandwidth · Free proxy pool · Direct streams</p>
<div><span class="bd">Movies</span><span class="bd">Series</span><span class="bd">🛡️ Pool</span></div><br><a class="b" href="/configure">Configure & Install</a>
<pre>Domain: ${BP_BASE || '…'}\nPool:   ${pool.length} proxies\nV: ${CODE_VERSION}</pre></div></body></html>`);

    jsonErr(res, 404, 'not found');
  } catch (e) { console.error('ERR:', e.message); jsonErr(res, 500, 'internal'); }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  await detectDomain();
  // Start pool refresh daemon
  poolRefresh();
  setInterval(poolRefresh, POOL_REFRESH_MS);
  console.log(`BanglaPlex v${CODE_VERSION} port ${PORT} | ${BP_BASE}`);
  console.log(`Proxy pool: ${MANUAL_PROXIES.length ? MANUAL_PROXIES.length + ' manual' : 'ProxyScrape free (auto-refreshed)'}`);
  http.createServer(route).listen(PORT, '0.0.0.0', () => console.log(`Ready on :${PORT}`));
}
start().catch(e => { console.error(e); process.exit(1); });
