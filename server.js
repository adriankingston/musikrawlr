// musikrawlr — local server + polite MusicBrainz proxy.
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
const UA = `musikrawlr/0.1 (${process.env.MB_CONTACT || 'no-contact-set; local dev'})`;

fs.mkdirSync(CACHE_DIR, { recursive: true });

// --- Polite MusicBrainz fetcher ----------------------------------------------
// Disk cache → in-flight dedup → a single promise chain that spaces outbound
// requests ≥1.1s apart. 503/429 (throttled) retries with backoff.
const inflight = new Map();
let queueTail = Promise.resolve();
let lastFetchAt = 0;

const cachePathFor = (url) =>
  path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');

// Cached fetch for non-MusicBrainz hosts (Wikidata, Wikipedia, Discogs):
// disk cache + in-flight dedup + identifying UA, but no rate-limit queue.
function webFetch(url, headers = {}) {
  const file = cachePathFor(url);
  try { return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* not cached */ }
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    const data = await res.json();
    fs.writeFile(file, JSON.stringify(data), () => {});
    return data;
  })();
  inflight.set(url, p);
  p.catch(() => {}).then(() => inflight.delete(url));
  return p;
}

// Discogs profile text uses its own markup ([a=Artist], [l=Label], [b]…);
// strip it down to plain prose and keep it to a paragraph.
function cleanDiscogsProfile(s) {
  let t = String(s || '')
    .replace(/\[(?:a|l|m|r)=([^\]]+)\]/g, '$1')
    .replace(/\[(?:a|l|m|r)\d+\]/g, '')
    .replace(/\[url=[^\]]*\]([^[]*)\[\/url\]/g, '$1')
    .replace(/\[\/?[bius]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > 620) {
    const cut = t.slice(0, 620);
    const stop = cut.lastIndexOf('. ');
    t = stop > 200 ? cut.slice(0, stop + 1) : cut + '…';
  }
  return t;
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

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  if (!MBID_RE.test(id)) {
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
  const out = { bio: null, image: null, releaseGroups: [] };

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
        if (sum.extract) {
          out.bio = { text: sum.extract, source: 'Wikipedia', url: sum.content_urls?.desktop?.page };
        }
        if (!out.image && sum.thumbnail?.source) out.image = sum.thumbnail.source;
      }
    } catch { /* enrichment is best-effort — ship what we have */ }
  }

  // Discogs fills the Wikipedia gaps: MusicBrainz stores the exact Discogs
  // artist id, and /artists/<id> works keyless (an optional DISCOGS_TOKEN in
  // .env raises the rate limit and unlocks artist photos).
  if (!out.bio || !out.image) {
    const dg = (artist.relations || []).find((r) => r.type === 'discogs' && r.url);
    const dgId = dg ? (dg.url.resource.match(/\/artist\/(\d+)/) || [])[1] : null;
    if (dgId) {
      try {
        const headers = process.env.DISCOGS_TOKEN
          ? { Authorization: `Discogs token=${process.env.DISCOGS_TOKEN}` }
          : {};
        const dgData = await webFetch(`https://api.discogs.com/artists/${dgId}`, headers);
        if (!out.bio && dgData.profile) {
          const text = cleanDiscogsProfile(dgData.profile);
          if (text) out.bio = { text, source: 'Discogs', url: `https://www.discogs.com/artist/${dgId}` };
        }
        if (!out.image && Array.isArray(dgData.images) && dgData.images.length) {
          const img = dgData.images.find((i) => i.type === 'primary') || dgData.images[0];
          if (img && img.uri) out.image = img.uri;
        }
      } catch { /* best-effort */ }
    }
  }
  sendJson(res, 200, out);
}

// How widely written-about an artist is, as a "fame" amplifier for the
// main-member logic. Wikidata stores MusicBrainz ids (P434), so one SPARQL
// query resolves a whole band's line-up at once — no name matching, and no
// per-member request storm. Counts are cached forever (they barely move).
const NOTA_FILE = path.join(CACHE_DIR, 'notability.json');
let notaStore = null;

function loadNotability() {
  if (!notaStore) {
    try { notaStore = JSON.parse(fs.readFileSync(NOTA_FILE, 'utf8')); } catch { notaStore = {}; }
  }
  return notaStore;
}

async function apiNotability(req, res, url) {
  const ids = (url.searchParams.get('ids') || '')
    .split(',').map((s) => s.trim()).filter((s) => MBID_RE.test(s)).slice(0, 150);
  if (!ids.length) return sendJson(res, 400, { error: 'No valid ids' });

  const store = loadNotability();
  const missing = ids.filter((id) => !(id in store));
  if (missing.length) {
    const values = missing.map((id) => `"${id}"`).join(' ');
    const q = `SELECT ?mbid (COUNT(DISTINCT ?sl) AS ?n) WHERE {`
      + ` VALUES ?mbid { ${values} } ?item wdt:P434 ?mbid .`
      + ` OPTIONAL { ?sl schema:about ?item } } GROUP BY ?mbid`;
    try {
      const r = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(q), {
        headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
      });
      if (r.ok) {
        const j = await r.json();
        for (const b of j.results.bindings) store[b.mbid.value] = Number(b.n.value) || 0;
      }
    } catch { /* fame is a bonus signal — never fail the request over it */ }
    // Anything Wikidata didn't return simply has no item: record the zero so
    // we don't ask again.
    for (const id of missing) if (!(id in store)) store[id] = 0;
    fs.writeFile(NOTA_FILE, JSON.stringify(store), () => {});
  }
  sendJson(res, 200, { sitelinks: Object.fromEntries(ids.map((id) => [id, store[id] || 0])) });
}

// Is there a chain between two artists, and how long? Bidirectional BFS over
// MusicBrainz relationships, always growing the smaller side so the two
// searches meet in the middle. Every lookup is the same cached artist fetch
// the graph uses, so a second run over familiar ground is instant — but a
// cold search is rate-limited to 1/sec, hence the hard budget.
async function apiRoute(req, res, url) {
  const from = (url.searchParams.get('from') || '').trim();
  const to = (url.searchParams.get('to') || '').trim();
  if (!MBID_RE.test(from) || !MBID_RE.test(to)) {
    return sendJson(res, 400, { error: 'Invalid MBID' });
  }
  if (from === to) return sendJson(res, 200, { found: true, distance: 0, path: [] });

  const BUDGET = Math.min(60, Math.max(5, Number(url.searchParams.get('budget')) || 26));
  const seen = { f: new Map([[from, null]]), b: new Map([[to, null]]) };
  const names = new Map();
  let frontF = [from];
  let frontB = [to];
  let fetches = 0;
  let meet = null;
  // Levels fully explored on each side. Only complete levels count, so the
  // "at least N steps" we report back is a bound we can actually stand behind.
  let doneF = 0;
  let doneB = 0;

  const neighbours = async (id) => {
    fetches++;
    const a = await mbFetch(`artist/${id}?inc=artist-rels`);
    names.set(id, { name: a.name, type: a.type });
    const out = [];
    for (const r of a.relations || []) {
      if (!r.artist || r.artist.id === id) continue;
      names.set(r.artist.id, { name: r.artist.name, type: r.artist.type });
      out.push(r.artist.id);
    }
    return out;
  };

  while (!meet && frontF.length && frontB.length && fetches < BUDGET) {
    // Grow whichever side is cheaper to grow.
    const fwd = frontF.length <= frontB.length;
    const front = fwd ? frontF : frontB;
    const mine = fwd ? seen.f : seen.b;
    const theirs = fwd ? seen.b : seen.f;
    const next = [];
    let complete = true;
    for (const id of front) {
      if (fetches >= BUDGET) { complete = false; break; }
      let nb;
      try { nb = await neighbours(id); } catch { continue; }
      for (const other of nb) {
        if (mine.has(other)) continue;
        mine.set(other, id);
        if (theirs.has(other)) { meet = other; break; }
        next.push(other);
      }
      if (meet) break;
    }
    if (fwd) { frontF = next; if (complete && !meet) doneF++; }
    else { frontB = next; if (complete && !meet) doneB++; }
  }

  if (!meet) {
    // A frontier running dry means we walked that artist's ENTIRE connected
    // corner of MusicBrainz without meeting the other — a real "no link",
    // not merely a search that ran out of road.
    const exhausted = frontF.length === 0 || frontB.length === 0;
    return sendJson(res, 200, {
      found: false,
      exhausted,
      atLeast: doneF + doneB + 1,
      searched: fetches,
      budget: BUDGET,
    });
  }

  const chain = [];
  for (let id = meet; id != null; id = seen.f.get(id)) chain.unshift(id);
  for (let id = seen.b.get(meet); id != null; id = seen.b.get(id)) chain.push(id);
  sendJson(res, 200, {
    found: true,
    distance: chain.length - 1,
    path: chain.map((id) => ({ id, name: (names.get(id) || {}).name || '?', type: (names.get(id) || {}).type })),
    searched: fetches,
  });
}

const routes = {
  'GET /api/search': apiSearch,
  'GET /api/artist': apiArtist,
  'GET /api/enrich': apiEnrich,
  'GET /api/notability': apiNotability,
  'GET /api/route': apiRoute,
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
  console.log(`\n  musikrawlr → http://localhost:${PORT}\n`);
  if (!process.env.MB_CONTACT) {
    console.log('  ⚠  No MB_CONTACT in .env — MusicBrainz asks for contact info in the User-Agent.\n');
  }
});
