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

const cachePathFor = (url) =>
  path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');

// Cached fetch for non-MusicBrainz hosts (Wikidata, Wikipedia): disk cache +
// in-flight dedup + identifying UA, but no rate-limit queue.
function webFetch(url) {
  const file = cachePathFor(url);
  try { return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* not cached */ }
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    const data = await res.json();
    fs.writeFile(file, JSON.stringify(data), () => {});
    return data;
  })();
  inflight.set(url, p);
  p.catch(() => {}).then(() => inflight.delete(url));
  return p;
}

function mbFetch(pathAndQuery) {
  const url = MB + pathAndQuery + (pathAndQuery.includes('?') ? '&' : '?') + 'fmt=json';
  const file = cachePathFor(url);
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

// Best-effort enrichment for the detail panel. MusicBrainz gives us the
// Wikidata id (exact match, no fuzzy name lookups) and the release groups;
// Wikidata gives the enwiki title + portrait (P18); Wikipedia's REST summary
// gives the bio extract. Cover art URLs are built client-side against the
// keyless Cover Art Archive. Every upstream response is disk-cached.
async function apiEnrich(req, res, url) {
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return sendJson(res, 400, { error: 'Invalid MBID' });
  }
  const artist = await mbFetch(`artist/${id}?inc=url-rels+release-groups`);
  const out = { wikipedia: null, image: null, releaseGroups: [] };

  out.releaseGroups = (artist['release-groups'] || [])
    .filter((rg) => rg['primary-type'] === 'Album' && !(rg['secondary-types'] || []).length)
    .sort((a, b) => (a['first-release-date'] || '9999').localeCompare(b['first-release-date'] || '9999'))
    .slice(0, 8)
    .map((rg) => ({ id: rg.id, title: rg.title, year: (rg['first-release-date'] || '').slice(0, 4) }));

  const wd = (artist.relations || []).find((r) => r.type === 'wikidata' && r.url);
  const qid = wd ? (wd.url.resource.match(/(Q\d+)/) || [])[1] : null;
  if (qid) {
    try {
      const sl = await webFetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`);
      const title = sl.entities?.[qid]?.sitelinks?.enwiki?.title;
      const pc = await webFetch(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P18&format=json`);
      const p18 = pc.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (p18) {
        out.image = 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(p18) + '?width=480';
      }
      if (title) {
        const sum = await webFetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')));
        out.wikipedia = {
          title: sum.title,
          extract: sum.extract,
          url: sum.content_urls?.desktop?.page,
        };
        if (!out.image && sum.thumbnail?.source) out.image = sum.thumbnail.source;
      }
    } catch { /* enrichment is best-effort — ship what we have */ }
  }
  sendJson(res, 200, out);
}

const routes = {
  'GET /api/search': apiSearch,
  'GET /api/artist': apiArtist,
  'GET /api/enrich': apiEnrich,
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
