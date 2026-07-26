// Band graph — local server + polite MusicBrainz proxy.
//
// Zero dependencies. Serves ./public and routes /api/* to the MusicBrainz
// web service (https://musicbrainz.org/ws/2/), respecting its etiquette:
//   - at most 1 outbound request per second (all requests share one queue)
//   - a descriptive User-Agent with contact info (set MB_CONTACT in .env)
//   - aggressive local caching (.cache/, gitignored) so repeat lookups
//     never hit the network at all.
//
// Run with:  node server.js   →   http://localhost:4700

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Load .env (tiny parser, no dependency) ----------------------------------
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env file — fall back to real environment */ }

const PORT = process.env.PORT || 4700;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = path.join(__dirname, '.cache');
const MB = 'https://musicbrainz.org/ws/2/';
const UA = `BandGraph/0.1 (${process.env.MB_CONTACT || 'no-contact-set; local dev'})`;

fs.mkdirSync(CACHE_DIR, { recursive: true });

// --- Polite MusicBrainz fetcher ----------------------------------------------
// Disk cache → in-flight dedup → a single promise chain that spaces outbound
// requests ≥1.1s apart. 503/429 (throttled) retries with backoff.
const inflight = new Map();
let queueTail = Promise.resolve();
let lastFetchAt = 0;

function mbFetch(pathAndQuery) {
  const url = MB + pathAndQuery + (pathAndQuery.includes('?') ? '&' : '?') + 'fmt=json';
  const file = path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  try { return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* not cached */ }
  if (inflight.has(url)) return inflight.get(url);

  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastFetchAt + 1100 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastFetchAt = Date.now();
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if ((res.status === 503 || res.status === 429) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`MusicBrainz responded ${res.status}`);
      const data = await res.json();
      fs.writeFile(file, JSON.stringify(data), () => {});
      return data;
    }
  };

  const p = (queueTail = queueTail.catch(() => {}).then(run));
  inflight.set(url, p);
  p.catch(() => {}).then(() => inflight.delete(url));
  return p;
}

// Lucene special characters would break (or hijack) the search query syntax.
const luceneEscape = (s) => s.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, '\\$&');

// --- API routes --------------------------------------------------------------
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function apiSearch(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return sendJson(res, 400, { error: 'Missing q' });
  const data = await mbFetch(`artist?query=${encodeURIComponent(luceneEscape(q))}&limit=12`);
  sendJson(res, 200, {
    count: data.count,
    artists: (data.artists || []).map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      country: a.country,
      area: a.area && a.area.name,
      begin: a['life-span'] && a['life-span'].begin,
      end: a['life-span'] && a['life-span'].end,
      ended: a['life-span'] && a['life-span'].ended,
      disambiguation: a.disambiguation,
      score: a.score,
    })),
  });
}

async function apiArtist(req, res, url) {
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return sendJson(res, 400, { error: 'Invalid MBID' });
  }
  const data = await mbFetch(`artist/${id}?inc=artist-rels+url-rels+genres`);
  sendJson(res, 200, data);
}

const routes = {
  'GET /api/search': apiSearch,
  'GET /api/artist': apiArtist,
};

// --- Server ------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    Promise.resolve(handler(req, res, url)).catch((e) => {
      if (!res.headersSent) sendJson(res, 502, { error: String(e.message || e) });
    });
    return;
  }

  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // Local dev tool whose files change often — never serve a stale UI.
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Band graph → http://localhost:${PORT}\n`);
  if (!process.env.MB_CONTACT) {
    console.log('  ⚠  No MB_CONTACT in .env — MusicBrainz asks for contact info in the User-Agent.\n');
  }
});
