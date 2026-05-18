'use strict';
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { parseStringPromise } = require('xml2js');
const Seedr    = require('seedr');
const axios    = require('axios');
const FormData = require('form-data');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

const JACKETT_KEY  = process.env.JACKETT_KEY  || '';
const SEEDR_EMAIL  = process.env.SEEDR_EMAIL  || '';
const SEEDR_PASS   = process.env.SEEDR_PASS   || '';

if (!JACKETT_KEY || !SEEDR_EMAIL || !SEEDR_PASS) {
  console.error('Missing required env vars: JACKETT_KEY, SEEDR_EMAIL, SEEDR_PASS');
  console.error('Copy .env.example to .env and fill in your credentials.');
  process.exit(1);
}

const SEEDR_PROTECTED = new Set([903015920]);

let seedrToken = null;
let seedrClient = null;

async function getSeedr() {
  if (seedrClient && seedrToken) return seedrClient;
  seedrClient = new Seedr();
  seedrToken  = await seedrClient.login(SEEDR_EMAIL, SEEDR_PASS);
  return seedrClient;
}

async function seedrCall(fn) {
  try {
    const s = await getSeedr();
    return await fn(s);
  } catch (e) {
    if (/auth|token|login|unauthorized/i.test(e.message)) {
      seedrToken = null; seedrClient = null;
      const s = await getSeedr();
      return await fn(s);
    }
    throw e;
  }
}

async function getSeedrFolders() {
  const token = seedrToken || (await getSeedr(), seedrToken);
  return new Promise((resolve, reject) => {
    https.get(`https://www.seedr.cc/api/folder?access_token=${token}`, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function seedrDelete(token, entries) {
  const data = new FormData();
  data.append('access_token', token);
  data.append('func', 'delete');
  data.append('delete_arr', JSON.stringify(entries));
  const res = await axios({ method: 'post', url: 'https://www.seedr.cc/oauth_test/resource.php', headers: data.getHeaders(), data });
  return res.data;
}

async function ensureSeedrSpace() {
  await getSeedr();
  const data = await getSeedrFolders();

  for (const t of (data.torrents || [])) {
    try {
      await seedrDelete(seedrToken, [{ type: 'torrent', id: t.id }]);
    } catch(e) {
      console.error(`[seedr] failed to cancel torrent ${t.id}:`, e.message);
    }
  }

  const deletable = (data.folders || [])
    .filter(f => !SEEDR_PROTECTED.has(f.id))
    .sort((a, b) => new Date(a.last_update || 0) - new Date(b.last_update || 0));

  for (const folder of deletable) {
    try {
      const s = await getSeedr();
      await s.deleteFolder(folder.id);
    } catch(e) {
      console.error(`[seedr] failed to delete folder ${folder.id}:`, e.message);
    }
  }
}

function infoHashFromTorrent(buf) {
  const marker = Buffer.from('4:info');
  const idx = buf.indexOf(marker);
  if (idx === -1) return null;
  const start = idx + marker.length;
  try {
    const end = bencodeEnd(buf, start);
    return crypto.createHash('sha1').update(buf.slice(start, end)).digest('hex').toUpperCase();
  } catch { return null; }
}

function bencodeEnd(buf, pos) {
  const ch = String.fromCharCode(buf[pos]);
  if (ch === 'd') {
    pos++;
    while (buf[pos] !== 0x65) pos = bencodeEnd(buf, pos);
    return pos + 1;
  }
  if (ch === 'l') {
    pos++;
    while (buf[pos] !== 0x65) pos = bencodeEnd(buf, pos);
    return pos + 1;
  }
  if (ch === 'i') {
    const e = buf.indexOf(0x65, pos + 1);
    return e + 1;
  }
  const colon = buf.indexOf(0x3a, pos);
  const len = parseInt(buf.slice(pos, colon).toString());
  return colon + 1 + len;
}

function fetchTorrentHash(torrentUrl) {
  if (!torrentUrl) return Promise.resolve(null);
  if (torrentUrl.startsWith('magnet:')) {
    const m = torrentUrl.match(/urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
    return Promise.resolve(m ? m[1].toUpperCase() : null);
  }
  if (!torrentUrl.startsWith('http')) return Promise.resolve(null);
  return new Promise((resolve) => {
    const mod = torrentUrl.startsWith('https') ? https : http;
    const req = mod.get(torrentUrl, { timeout: 8000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(fetchTorrentHash(res.headers.location));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(infoHashFromTorrent(Buffer.concat(chunks))); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT     = 5;
const rateBuckets    = new Map();

function getIP(req) {
  return req.headers['x-real-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress;
}

function checkRate(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.windowStart > RATE_WINDOW_MS) {
    b = { count: 0, windowStart: now };
    rateBuckets.set(ip, b);
  }
  b.count++;
  return b.count <= RATE_LIMIT;
}

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [ip, b] of rateBuckets) if (b.windowStart < cutoff) rateBuckets.delete(ip);
}, 60_000);

const imdbCache = new Map();

function fetchIMDBTitle(imdbId) {
  const id = imdbId.replace(/^tt0*/, '');
  const paddedId = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
  if (imdbCache.has(paddedId)) return Promise.resolve(imdbCache.get(paddedId));

  return new Promise((resolve) => {
    const firstChar = id[0];
    const p = `/suggests/${firstChar}/tt${id.padStart(7,'0')}.json`;
    const req = https.request(
      { hostname: 'sg.media-imdb.com', path: p, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' } },
      (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const json = data.replace(/^[^(]+\(/, '').replace(/\)$/, '');
            const parsed = JSON.parse(json);
            const entry = parsed.d?.[0];
            if (entry) {
              const result = { title: entry.l, year: entry.y, type: entry.qid };
              imdbCache.set(paddedId, result);
              resolve(result);
            } else {
              resolve(null);
            }
          } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function fetchIMDBSuggestions(query) {
  if (!query || query.length < 2) return Promise.resolve([]);
  const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '_');
  if (!q) return Promise.resolve([]);

  return new Promise((resolve) => {
    const p = `/suggests/${q[0]}/${encodeURIComponent(q)}.json`;
    const req = https.request(
      { hostname: 'sg.media-imdb.com', path: p, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const json = data.replace(/^[^(]+\(/, '').replace(/\)[\s]*$/, '');
            const parsed = JSON.parse(json);
            const results = (parsed.d || [])
              .filter(e => e.id && e.l && (e.qid === 'movie' || e.qid === 'tvSeries' || e.qid === 'tvMiniSeries'))
              .slice(0, 8)
              .map(e => ({ id: e.id, title: e.l, year: e.y, type: e.qid }));
            resolve(results);
          } catch { resolve([]); }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.setTimeout(5000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

async function buildQuery({ q, imdb, season, episode }) {
  let title = q || '';
  let year  = null;
  let resolved = null;

  if (imdb) {
    resolved = await fetchIMDBTitle(imdb);
    if (resolved) { title = resolved.title; year = resolved.year; }
  }

  let query = title;
  if (year && !season) query += ` ${year}`;

  if (season !== undefined && episode !== undefined) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    query += ` S${s}E${e}`;
  } else if (season !== undefined) {
    query += ` S${String(season).padStart(2, '0')}`;
  }

  return { query: query.trim(), resolved };
}

function jackettSearch({ query, category, indexer, limit }) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      apikey: JACKETT_KEY, t: 'search', q: query,
      limit: String(Math.min(limit || 20, 100)),
    });
    if (category) params.set('cat', category);

    const idx  = indexer || 'all';
    const p    = `/api/v2.0/indexers/${idx}/results/torznab/api?${params}`;

    const req = http.request(
      { hostname: '127.0.0.1', port: 9117, path: p, method: 'GET' },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Jackett timeout')); });
    req.end();
  });
}

function attr(item, name) {
  const attrs = item['torznab:attr'] || [];
  const found = attrs.find(a => a.$ && a.$.name === name);
  return found ? found.$.value : null;
}

async function parseResults(xml) {
  const parsed = await parseStringPromise(xml, { explicitArray: true });
  const items  = parsed?.rss?.channel?.[0]?.item || [];

  const partial = items.map(item => {
    const infoHash  = attr(item, 'infohash');
    const magnetUrl = attr(item, 'magneturl');
    const seeders   = attr(item, 'seeders');
    const peers     = attr(item, 'peers');
    const size      = item.size?.[0];

    let hash = infoHash;
    if (!hash && magnetUrl) {
      const m = magnetUrl.match(/urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
      if (m) hash = m[1].toUpperCase();
    }

    return {
      title:     item.title?.[0] || '',
      size_mb:   size ? Math.round(parseInt(size) / 1024 / 1024) : null,
      seeders:   seeders ? parseInt(seeders) : null,
      peers:     peers   ? parseInt(peers)   : null,
      info_hash: hash ? hash.toUpperCase() : null,
      link:      item.link?.[0] || null,
      indexer:   item.jackettindexer?.[0]?._ || item.jackettindexer?.[0] || null,
      pub_date:  item.pubDate?.[0] || null,
    };
  }).filter(r => r.title);

  await Promise.all(partial.map(async (r) => {
    if (!r.info_hash && r.link) r.info_hash = await fetchTorrentHash(r.link);
  }));

  return partial.map(r => ({
    ...r,
    magnet: r.info_hash
      ? `magnet:?xt=urn:btih:${r.info_hash}&dn=${encodeURIComponent(r.title)}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.tracker.cl:1337/announce`
      : null,
  })).sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

const SHARED_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;background:#f0f0f0;color:#111}
  a{color:#2980b9;text-decoration:none}
  a:hover{text-decoration:underline}
  button{font:600 13px/1 inherit;cursor:pointer;border:none;border-radius:8px}
  input{font:14px/1 inherit;border:1px solid #ccc;border-radius:8px;outline:none;background:#fff;padding:8px 12px}
  input:focus{border-color:#888}
`;

const AUTOCOMPLETE_JS = `
(function(){
  const qInput = document.getElementById('q');
  const sugBox  = document.getElementById('suggestions');
  const form    = document.getElementById('search-form');
  let timer, activeIdx = -1, items = [];

  qInput.addEventListener('input', () => {
    clearTimeout(timer);
    const val = qInput.value.trim();
    if (val.length < 2 || /^tt\\d/.test(val)) { hideSug(); return; }
    timer = setTimeout(() => fetchSuggestions(val), 220);
  });

  qInput.addEventListener('keydown', e => {
    if (!sugBox.style.display || sugBox.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1); }
    else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); selectItem(items[activeIdx]); }
    else if (e.key === 'Escape') { hideSug(); }
  });

  document.addEventListener('click', e => {
    if (!sugBox.contains(e.target) && e.target !== qInput) hideSug();
  });

  function setActive(idx) {
    activeIdx = Math.max(-1, Math.min(items.length - 1, idx));
    Array.from(sugBox.children).forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  }

  function selectItem(item) {
    qInput.value = item.id;
    hideSug();
    form.submit();
  }

  function hideSug() { sugBox.style.display = 'none'; activeIdx = -1; items = []; }

  async function fetchSuggestions(q) {
    try {
      const res = await fetch('/imdb/suggest?q=' + encodeURIComponent(q));
      const data = await res.json();
      items = data.results || [];
      renderSug(items);
    } catch { hideSug(); }
  }

  function renderSug(results) {
    if (!results.length) { hideSug(); return; }
    sugBox.innerHTML = results.map((r, i) => {
      const typeLabel = r.type === 'movie' ? 'Movie' : 'TV';
      const typeCls   = r.type === 'movie' ? 'movie' : 'tv';
      return '<div class="sug-item" data-idx="' + i + '">' +
        '<span class="sug-title">' + escHtml(r.title) + '</span>' +
        (r.year ? '<span class="sug-year">' + r.year + '</span>' : '') +
        '<span class="sug-type ' + typeCls + '">' + typeLabel + '</span>' +
        '</div>';
    }).join('');
    sugBox.style.display = 'block';
    activeIdx = -1;
    sugBox.querySelectorAll('.sug-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        selectItem(items[parseInt(el.dataset.idx)]);
      });
    });
  }

  function escHtml(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
})();
`;

const AUTOCOMPLETE_CSS = `
  #suggestions{
    position:absolute;top:calc(100% + 4px);left:0;right:0;
    background:#fff;border:1px solid #ccc;border-radius:10px;
    box-shadow:0 4px 16px rgba(0,0,0,.12);
    z-index:100;overflow:hidden;display:none;
  }
  .sug-item{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-bottom:1px solid #f0f0f0}
  .sug-item:last-child{border-bottom:none}
  .sug-item:hover,.sug-item.active{background:#f5f5f5}
  .sug-title{font-size:14px;font-weight:500;flex:1}
  .sug-year{font-size:12px;color:#888;white-space:nowrap}
  .sug-type{font-size:10px;font-weight:700;text-transform:uppercase;color:#fff;padding:2px 6px;border-radius:4px;background:#888;white-space:nowrap}
  .sug-type.movie{background:#e74c3c}
  .sug-type.tv{background:#2980b9}
`;

const PAGE_HOME = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Torrent Search</title>
<style>
  ${SHARED_CSS}
  ${AUTOCOMPLETE_CSS}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:16px;padding:20px}
  h1{font-size:22px;font-weight:700;letter-spacing:-.3px}
  .search-wrap{position:relative;width:100%;max-width:520px}
  form{display:flex;gap:8px}
  #q{flex:1;padding:10px 14px;border-radius:10px}
  button[type=submit]{padding:10px 18px;background:#111;color:#fff;border-radius:10px;white-space:nowrap;flex-shrink:0}
  button[type=submit]:hover{background:#333}
  .hint{font-size:12px;color:#999;text-align:center}
</style>
</head>
<body>
<h1>Torrent Search</h1>
<div class="search-wrap">
  <form id="search-form" action="/results" method="get">
    <input id="q" name="q" placeholder="Title, IMDB ID, or &quot;show S01E02&quot;..." autofocus autocomplete="off">
    <button type="submit">Search</button>
  </form>
  <div id="suggestions"></div>
</div>
<p class="hint">Try: <a href="/results?q=inception+2010">inception 2010</a> &nbsp;·&nbsp; <a href="/results?q=tt0903747">tt0903747</a> &nbsp;·&nbsp; <a href="/results?q=breaking+bad+S03E07">breaking bad S03E07</a></p>
<script>${AUTOCOMPLETE_JS}</script>
</body>
</html>`;

function buildResultsSection(sectionTitle, results, emptyMsg) {
  const rows = results.length === 0
    ? `<tr><td colspan="5" style="color:#888;padding:16px;text-align:center">${emptyMsg}</td></tr>`
    : results.map(r => {
        const sizeStr = r.size_mb !== null ? (r.size_mb >= 1024 ? (r.size_mb/1024).toFixed(1)+'GB' : r.size_mb+'MB') : '—';
        const streamBtn = r.info_hash
          ? `<button class="stream-btn" data-hash="${esc(r.info_hash)}" data-title="${esc(r.title)}">Stream</button>`
          : '—';
        return `<tr>
    <td>${esc(r.title)}</td>
    <td>${sizeStr}</td>
    <td>${r.seeders ?? '—'}</td>
    <td>${esc(r.indexer || '—')}</td>
    <td>${streamBtn}</td>
  </tr>`;
      }).join('');

  return `<div class="section">
<h2 class="section-title">${sectionTitle}</h2>
<table>
  <thead><tr><th>Title</th><th>Size</th><th>Seeds</th><th>Source</th><th>Stream</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>`;
}

function buildResultsPage(rawQuery, imdbData, rawData) {
  const imdbSection = imdbData
    ? buildResultsSection(
        imdbData.resolved
          ? `IMDB: <strong>${esc(imdbData.resolved.title)}</strong> (${imdbData.resolved.year || '?'}) — ${imdbData.results.length} result${imdbData.results.length !== 1 ? 's' : ''}`
          : `IMDB search — ${imdbData.results.length} result${imdbData.results.length !== 1 ? 's' : ''}`,
        imdbData.results,
        imdbData.error ? `Error: ${esc(imdbData.error)}` : 'No results'
      )
    : '';

  const rawSection = buildResultsSection(
    `Raw search: "${esc(rawData.query || rawQuery)}" — ${rawData.results.length} result${rawData.results.length !== 1 ? 's' : ''}`,
    rawData.results,
    rawData.error ? `Error: ${esc(rawData.error)}` : 'No results'
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(rawQuery)} — Torrent Search</title>
<style>
  ${SHARED_CSS}
  ${AUTOCOMPLETE_CSS}
  body{min-height:100vh;padding:20px}
  header{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  .back-btn{font-size:13px;font-weight:600;color:#111;text-decoration:none;background:#fff;border:1px solid #ccc;padding:6px 12px;border-radius:8px}
  .back-btn:hover{background:#f5f5f5}
  .search-wrap{position:relative;flex:1;min-width:200px;display:flex;gap:8px}
  .search-wrap input{flex:1}
  .search-btn{padding:8px 14px;background:#111;color:#fff}
  .search-btn:hover{background:#333}
  .section{margin-bottom:28px}
  .section-title{font-size:14px;font-weight:600;color:#555;margin-bottom:8px;padding:0 2px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
  th{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#888;background:#f8f8f8;padding:10px 12px;text-align:left;border-bottom:1px solid #e8e8e8}
  td{font-size:13px;padding:10px 12px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafafa}
  td:first-child{max-width:400px;word-break:break-word}
  td:nth-child(2),td:nth-child(3){white-space:nowrap;color:#555}
  td:nth-child(3){color:#27ae60;font-weight:600}
  .stream-btn{padding:6px 14px;background:#27ae60;color:#fff;font-size:12px}
  .stream-btn:hover:not(:disabled){background:#219a52}
  .stream-btn:disabled{background:#ccc;cursor:default}
  #player-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:200;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:20px}
  #player-overlay.active{display:flex}
  #player-title{color:#fff;font-size:14px;font-weight:600;max-width:800px;text-align:center;opacity:.8}
  #player{width:100%;max-width:960px;max-height:75vh;border-radius:8px;background:#000}
  #player-close{position:absolute;top:14px;right:18px;background:none;border:none;color:#fff;font-size:24px;cursor:pointer;opacity:.7;line-height:1}
  #player-close:hover{opacity:1}
</style>
</head>
<body>
<header>
  <a class="back-btn" href="/">Back</a>
  <div class="search-wrap">
    <form id="search-form" action="/results" method="get" style="display:flex;gap:8px;flex:1">
      <input id="q" name="q" value="${esc(rawQuery)}" autocomplete="off">
      <button class="search-btn" type="submit">Search</button>
    </form>
    <div id="suggestions"></div>
  </div>
</header>

${imdbSection}
${rawSection}

<div id="player-overlay">
  <button id="player-close" onclick="closePlayer()">&#x2715;</button>
  <div id="player-title"></div>
  <video id="player" controls autoplay></video>
</div>

<script>
document.querySelectorAll('.stream-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Loading...';
    startStream(btn.dataset.hash, btn.dataset.title, btn);
  });
});

function startStream(hash, title, btn) {
  fetch('/seedr/add?hash=' + encodeURIComponent(hash) + '&title=' + encodeURIComponent(title))
    .then(r => r.json())
    .then(d => {
      if (d.error) { resetBtn(btn); alert(d.error); return; }
      pollReady(hash, title, btn);
    })
    .catch(() => { resetBtn(btn); alert('Failed to queue torrent.'); });
}

function pollReady(hash, title, btn) {
  let attempts = 0;
  const iv = setInterval(() => {
    attempts++;
    fetch('/seedr/poll?hash=' + encodeURIComponent(hash) + '&title=' + encodeURIComponent(title))
      .then(r => r.json())
      .then(d => {
        if (d.error) { clearInterval(iv); resetBtn(btn); alert(d.error); return; }
        if (d.url) {
          clearInterval(iv);
          resetBtn(btn);
          openPlayer(d.url, title);
        } else if (attempts > 60) {
          clearInterval(iv);
          resetBtn(btn);
          alert('Timed out waiting for Seedr.');
        }
      })
      .catch(() => {});
  }, 3000);
}

function openPlayer(url, title) {
  const overlay = document.getElementById('player-overlay');
  const player  = document.getElementById('player');
  document.getElementById('player-title').textContent = title;
  player.src = url;
  overlay.classList.add('active');
}

function closePlayer() {
  const player = document.getElementById('player');
  player.pause();
  player.src = '';
  document.getElementById('player-overlay').classList.remove('active');
}

document.getElementById('player-overlay').addEventListener('click', function(e) {
  if (e.target === this) closePlayer();
});

function resetBtn(btn) {
  btn.disabled = false;
  btn.textContent = 'Stream';
}

${AUTOCOMPLETE_JS}
</script>
</body>
</html>`;
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function sendHTML(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'GET')     { sendJSON(res, 405, { error: 'GET only' }); return; }

  if (url.pathname === '/imdb/suggest') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    try {
      const results = await fetchIMDBSuggestions(q);
      sendJSON(res, 200, { results });
    } catch(e) {
      sendJSON(res, 200, { results: [] });
    }
    return;
  }

  if (url.pathname === '/search') {
    const ip = getIP(req);
    if (!checkRate(ip)) { sendJSON(res, 429, { error: 'Rate limit: 5 requests per 10 seconds' }); return; }

    const q       = (url.searchParams.get('q') || '').trim().slice(0, 200);
    const imdb    = (url.searchParams.get('imdb') || '').trim();
    const cat     = url.searchParams.get('cat') || '';
    const indexer = (url.searchParams.get('indexer') || 'all').trim();
    const limit   = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
    const seasonP  = url.searchParams.get('season');
    const episodeP = url.searchParams.get('episode');
    const season  = seasonP  !== null ? parseInt(seasonP)  : undefined;
    const episode = episodeP !== null ? parseInt(episodeP) : undefined;

    if (!q && !imdb) { sendJSON(res, 400, { error: 'Provide q= or imdb=tt...' }); return; }
    if (!/^[a-z0-9_-]+$/.test(indexer)) { sendJSON(res, 400, { error: 'Invalid indexer name' }); return; }
    if (episode !== undefined && season === undefined) { sendJSON(res, 400, { error: 'episode= requires season= too' }); return; }

    try {
      const { query, resolved } = await buildQuery({ q, imdb, season, episode });
      const xml     = await jackettSearch({ query, category: cat, indexer, limit });
      const results = await parseResults(xml);
      sendJSON(res, 200, {
        query,
        ...(resolved ? { title: resolved.title, year: resolved.year, type: resolved.type } : {}),
        indexer, count: results.length, results,
      });
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/indexers') {
    try {
      const resp = await new Promise((resolve, reject) => {
        const r = http.request(
          { hostname: '127.0.0.1', port: 9117,
            path: `/api/v2.0/indexers?apikey=${JACKETT_KEY}&configured=true` },
          (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }
        );
        r.on('error', reject);
        r.end();
      });
      const data = JSON.parse(resp);
      sendJSON(res, 200, data.map(i => ({ id: i.id, name: i.name, type: i.type })));
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  if (url.pathname === '/') {
    sendHTML(res, 200, PAGE_HOME);
    return;
  }

  if (url.pathname === '/results') {
    const ip = getIP(req);
    if (!checkRate(ip)) {
      sendHTML(res, 429, '<p style="font-family:sans-serif;padding:20px">Rate limit exceeded. Try again shortly.</p>');
      return;
    }

    const raw     = (url.searchParams.get('q') || '').trim().slice(0, 200);
    const indexer = (url.searchParams.get('indexer') || 'all').trim();
    const limit   = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100);

    if (!raw) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    if (!/^[a-z0-9_-]+$/.test(indexer)) { sendHTML(res, 400, '<p>Invalid indexer.</p>'); return; }

    let plainQ = raw, imdbId = '', season, episode;

    const imdbMatch = raw.match(/^(tt\d+)/i);
    if (imdbMatch) { imdbId = imdbMatch[1]; plainQ = ''; }

    const seMatch = raw.match(/[Ss](\d{1,2})[Ee](\d{1,2})/);
    if (seMatch) {
      season  = parseInt(seMatch[1]);
      episode = parseInt(seMatch[2]);
      if (!imdbId) plainQ = raw.slice(0, raw.search(/[Ss]\d{1,2}[Ee]\d{1,2}/)).trim();
    } else {
      const sMatch = raw.match(/[Ss](\d{1,2})$/);
      if (sMatch) {
        season = parseInt(sMatch[1]);
        if (!imdbId) plainQ = raw.slice(0, raw.search(/[Ss]\d{1,2}$/)).trim();
      }
    }

    const filter = rs => rs.filter(r => r.size_mb === null || r.size_mb <= 3072);

    const [imdbResult, rawResult] = await Promise.all([
      (async () => {
        if (!imdbId && !plainQ) return null;
        let resolvedImdbId = imdbId;
        if (!resolvedImdbId && plainQ) {
          const sugs = await fetchIMDBSuggestions(plainQ);
          if (sugs.length > 0) resolvedImdbId = sugs[0].id;
        }
        if (!resolvedImdbId) return null;
        try {
          const { query, resolved } = await buildQuery({ q: '', imdb: resolvedImdbId, season, episode });
          const xml = await jackettSearch({ query, category: '', indexer, limit });
          const results = filter(await parseResults(xml));
          return { query, resolved, results, error: null };
        } catch(e) {
          return { query: '', resolved: null, results: [], error: e.message };
        }
      })(),
      (async () => {
        const q = plainQ || raw;
        try {
          const { query, resolved } = await buildQuery({ q, imdb: '', season, episode });
          const xml = await jackettSearch({ query, category: '', indexer, limit });
          const results = filter(await parseResults(xml));
          return { query, resolved, results, error: null };
        } catch(e) {
          return { query: q, resolved: null, results: [], error: e.message };
        }
      })(),
    ]);

    sendHTML(res, 200, buildResultsPage(raw, imdbResult, rawResult));
    return;
  }

  if (url.pathname === '/seedr/add') {
    const hash  = (url.searchParams.get('hash') || '').trim().replace(/[^a-fA-F0-9]/g, '');
    const title = (url.searchParams.get('title') || '').trim().slice(0, 200);
    if (!hash) { sendJSON(res, 400, { error: 'hash required' }); return; }

    const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}&tr=udp://tracker.opentrackr.org:1337/announce`;

    try {
      const result = await seedrCall(s => s.addMagnet(magnet));
      sendJSON(res, 200, { ok: true, torrent_hash: result.torrent_hash });
    } catch (e) {
      const isQuotaError = e.response?.status === 413 || /413|queue_full|storage|full/i.test(e.message);

      if (isQuotaError) {
        try {
          await ensureSeedrSpace();
          await new Promise(r => setTimeout(r, 8000));
          const result = await seedrCall(s => s.addMagnet(magnet));
          sendJSON(res, 200, { ok: true, torrent_hash: result.torrent_hash });
        } catch(e2) {
          const isStillQueue = e2.response?.status === 413;
          sendJSON(res, 507, {
            error: isStillQueue
              ? 'Seedr download queue is busy. Try again in a few seconds.'
              : 'Seedr cleanup failed: ' + e2.message,
          });
        }
      } else {
        sendJSON(res, 502, { error: e.message });
      }
    }
    return;
  }

  if (url.pathname === '/seedr/poll') {
    const hash  = (url.searchParams.get('hash') || '').trim().toLowerCase().replace(/[^a-f0-9]/g, '');
    const title = (url.searchParams.get('title') || '').trim();
    if (!hash) { sendJSON(res, 400, { error: 'hash required' }); return; }

    try {
      const token = seedrToken || (await getSeedr(), seedrToken);
      const folderData = await new Promise((resolve, reject) => {
        https.get(`https://www.seedr.cc/api/folder?access_token=${token}`, r => {
          let d = ''; r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });

      const torrents = folderData.torrents || [];
      if (torrents.some(t => t.hash && t.hash.toLowerCase() === hash)) {
        sendJSON(res, 200, { ready: false });
        return;
      }

      const folders = folderData.folders || [];
      if (!folders.length) { sendJSON(res, 200, { ready: false }); return; }

      const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normTitle = normalize(title);
      const folder = folders.find(f => normalize(f.name).includes(normTitle.slice(0, 15)))
                  || folders.sort((a,b) => new Date(b.last_update) - new Date(a.last_update))[0];

      const folderDetail = await new Promise((resolve, reject) => {
        https.get(`https://www.seedr.cc/api/folder/${folder.id}?access_token=${token}`, r => {
          let d = ''; r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });

      const files = (folderDetail.files || []).filter(f => f.play_video);
      if (!files.length) { sendJSON(res, 200, { ready: false }); return; }

      const fileEntry = files.sort((a,b) => (b.size||0) - (a.size||0))[0];
      const fileResult = await seedrCall(s => s.getFile(fileEntry.folder_file_id));

      if (fileResult && fileResult.url) {
        sendJSON(res, 200, { ready: true, url: fileResult.url, name: fileEntry.name });
      } else {
        sendJSON(res, 200, { ready: false });
      }
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

const PORT = 3002;
server.listen(PORT, '127.0.0.1', () => console.log(`Torrent search API on 127.0.0.1:${PORT}`));
