// Local development server — NOT used on Vercel (Vercel uses api/ functions).
// Run: node serve.mjs
import { createServer } from 'http';
import { readFile, writeFile, access } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import { execFile } from 'child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = 3000;
const WATCHES_FILE = join(__dirname, 'watches.json');
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const NODE_BIN = process.execPath;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mjs': 'application/javascript',
};

let watchCache = { data: null, ts: 0, source: 'none' };

// ─── Run scrape.mjs as a child process ───────────────────
function runScraper() {
  return new Promise((resolve) => {
    const scraperPath = join(__dirname, 'scrape.mjs');
    execFile(NODE_BIN, [scraperPath], { timeout: 90_000 }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      resolve(!err);
    });
  });
}

// ─── Load watches (cache → scrape → file fallback) ───────
async function getWatches() {
  const now = Date.now();
  if (watchCache.data && now - watchCache.ts < CACHE_TTL) return watchCache.data;

  const ok = await runScraper();
  if (ok) {
    try {
      const raw = await readFile(WATCHES_FILE, 'utf-8');
      const data = JSON.parse(raw);
      watchCache = { data, ts: now, source: 'chrono24-live' };
      return data;
    } catch {}
  }

  try {
    const raw = await readFile(WATCHES_FILE, 'utf-8');
    const data = JSON.parse(raw);
    watchCache = { data, ts: now - CACHE_TTL + 60_000, source: 'file' };
    console.log(`[Watches] Fallback — ${data.length} watches from watches.json`);
    return data;
  } catch {
    return [];
  }
}

// ─── Background refresh ───────────────────────────────────
async function backgroundRefresh() {
  console.log('[Scraper] Background refresh…');
  const ok = await runScraper();
  if (ok) {
    try {
      const raw = await readFile(WATCHES_FILE, 'utf-8');
      const data = JSON.parse(raw);
      watchCache = { data, ts: Date.now(), source: 'chrono24-live' };
      console.log(`[Scraper] Updated — ${data.length} watches`);
    } catch {}
  }
}

setTimeout(backgroundRefresh, 15_000);
setInterval(backgroundRefresh, CACHE_TTL);

// ─── HTTP Server ──────────────────────────────────────────
const server = createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/api/watches') {
    try {
      const watches = await getWatches();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ watches, count: watches.length, source: watchCache.source, lastUpdated: new Date(watchCache.ts).toISOString() }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (urlPath === '/api/refresh') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    backgroundRefresh();
    return;
  }

  // Image proxy — same logic as api/img.js
  if (urlPath === '/api/img') {
    const imgUrl = new URL(req.url, 'http://localhost').searchParams.get('url');
    if (!imgUrl || !imgUrl.startsWith('https://img.chrono24.com/')) {
      res.writeHead(400); res.end('Bad request'); return;
    }
    try {
      const parsed = new URL(imgUrl);
      const proto = parsed.protocol === 'https:' ? https : http;
      proto.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Referer': 'https://www.chrono24.com.tr/',
          'Accept': 'image/*,*/*;q=0.8',
        },
        timeout: 10000,
      }, (imgRes) => {
        res.writeHead(imgRes.statusCode, {
          'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        });
        imgRes.pipe(res);
      }).on('error', (e) => { res.writeHead(502); res.end(e.message); });
    } catch (e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  const filePath = join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`✓ Privé Watch (local) → http://localhost:${PORT}`);
  console.log(`  Vercel deployment uses api/watches.js + api/img.js (no Puppeteer needed)`);
});
