import { createServer } from 'http';
import { readFile, writeFile } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = 3000;
const WATCHES_FILE = join(__dirname, 'watches.json');
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ─── MIME types ───────────────────────────────────────────
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

// ─── Cache ────────────────────────────────────────────────
let watchCache = { data: null, ts: 0, source: 'none' };

// ─── Brand list for parsing ───────────────────────────────
const KNOWN_BRANDS = [
  'Patek Philippe', 'Audemars Piguet', 'Jaeger-LeCoultre',
  'A. Lange & Söhne', 'F.P. Journe', 'Tag Heuer', 'TagHeuer',
  'Rolex', 'Omega', 'Cartier', 'IWC', 'Breitling', 'Panerai',
  'Hublot', 'Tudor', 'Bulgari', 'Bvlgari', 'Chopard', 'Zenith',
  'Longines', 'Tissot', 'Rado', 'Seiko', 'Grand Seiko',
  'Vacheron Constantin', 'Girard-Perregaux', 'Ulysse Nardin',
  'Blancpain', 'Breguet', 'Piaget', 'Roger Dubuis', 'Bell & Ross',
  'Richard Mille', 'Glashütte', 'Nomos', 'H. Moser', 'Moritz Grossmann',
];

/**
 * Parse "Brand Model Ref" from an img alt string like:
 *   "Patek Philippe Nautilus 5711/1A-010"
 *   "Rolex Datejust II 116300"
 */
function parseAlt(alt) {
  if (!alt) return { brand: 'Diğer', model: alt || '', ref: '' };

  let brand = 'Diğer';
  let rest = alt;

  // Try longest match first
  const sorted = [...KNOWN_BRANDS].sort((a, b) => b.length - a.length);
  for (const b of sorted) {
    if (alt.toLowerCase().startsWith(b.toLowerCase())) {
      brand = b === 'Bvlgari' ? 'Bulgari' : b === 'TagHeuer' ? 'Tag Heuer' : b;
      rest = alt.slice(b.length).trim();
      break;
    }
    // Also check if brand appears anywhere (for reordered strings)
    if (alt.toLowerCase().includes(b.toLowerCase())) {
      brand = b === 'Bvlgari' ? 'Bulgari' : b === 'TagHeuer' ? 'Tag Heuer' : b;
      rest = alt.replace(new RegExp(b, 'i'), '').trim();
      break;
    }
  }

  // Last token is often the reference number (contains digit or slash)
  const tokens = rest.split(/\s+/).filter(Boolean);
  let ref = '';
  let model = rest;

  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    // Ref pattern: has digits, or slashes, or dashes between alphanumeric
    if (/\d/.test(last) || /[A-Z]+-\d+/.test(last)) {
      ref = last;
      model = tokens.slice(0, -1).join(' ');
    }
  }

  return { brand, model: model || rest, ref };
}

// ─── Puppeteer scraper ────────────────────────────────────
async function scrapeChrono24() {
  const SEARCH_URL = 'https://www.chrono24.com.tr/search/index.htm?customerId=36265&dosearch=true';

  let puppeteer;
  try {
    // Resolve puppeteer relative to project dir
    const pPath = join(__dirname, 'node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js');
    puppeteer = (await import(pPath)).default;
  } catch (e) {
    console.error('[Scraper] Puppeteer import failed:', e.message);
    return null;
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    console.log('[Scraper] Loading', SEARCH_URL);
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 2500)); // Let lazy images settle

    // Extract all listing cards
    const raw = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.wt-listing-item')];
      return items.map(card => {
        const link = card.querySelector('a[href*="--id"]');
        // First non-lazy image (has real src) or fall back to master src
        const imgs = [...card.querySelectorAll('img')];
        const realImg = imgs.find(i => i.src && i.src.startsWith('https://img.chrono24.com'));
        const masterImg = imgs.find(i => i.dataset && i.dataset.lazySweetSpotMasterSrc);

        const href = link ? link.getAttribute('href') : null;
        const alt = realImg ? realImg.alt : (masterImg ? masterImg.alt : null);
        // Always prefer master src for consistent 480px quality.
        // Template is "...HASH-Square_SIZE_.jpg" → replace _SIZE_ with 480.
        const masterSrc = masterImg
          ? masterImg.dataset.lazySweetSpotMasterSrc.replace('_SIZE_', '480')
          : null;
        const imgSrc = masterSrc || (realImg ? realImg.src : null);

        return { href, alt, imgSrc };
      });
    });

    await browser.close();
    browser = null;

    // Deduplicate by href
    const seen = new Set();
    const watches = [];
    for (const item of raw) {
      if (!item.href || seen.has(item.href)) continue;
      seen.add(item.href);

      const { brand, model, ref } = parseAlt(item.alt);
      const url = item.href.startsWith('http')
        ? item.href
        : 'https://www.chrono24.com.tr' + item.href;

      // Normalise to Square480; handle both -Square240.jpg and -Square_SIZE_ residuals
      let img = item.imgSrc || null;
      if (img) {
        img = img
          .replace(/Square_SIZE_/g, 'Square480')      // template leftover
          .replace(/-Square\d+\.jpg$/, '-Square480.jpg') // resize any other size
          .replace(/-ExtraLarge\.jpg$/, '-Square480.jpg');
        // Serve through local proxy so hotlink rules never block the browser
        img = '/api/img?url=' + encodeURIComponent(img);
      }

      watches.push({ brand, model, ref, img: img || null, hasImg: !!img, url });
    }

    console.log(`[Scraper] Extracted ${watches.length} unique watches`);
    return watches.length > 0 ? watches : null;

  } catch (e) {
    console.error('[Scraper] Error:', e.message);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// ─── Load watches (cache → scrape → file) ────────────────
async function getWatches() {
  const now = Date.now();
  if (watchCache.data && now - watchCache.ts < CACHE_TTL) {
    return watchCache.data;
  }

  const scraped = await scrapeChrono24();
  if (scraped && scraped.length > 0) {
    watchCache = { data: scraped, ts: now, source: 'chrono24-live' };
    await writeFile(WATCHES_FILE, JSON.stringify(scraped, null, 2), 'utf-8').catch(() => {});
    return scraped;
  }

  // Fallback: watches.json
  try {
    const raw = await readFile(WATCHES_FILE, 'utf-8');
    const data = JSON.parse(raw);
    watchCache = { data, ts: now - CACHE_TTL + 60_000, source: 'file' };
    console.log(`[Watches] Serving ${data.length} watches from watches.json (fallback)`);
    return data;
  } catch {
    console.error('[Watches] watches.json unavailable');
    return [];
  }
}

// ─── Background auto-refresh ──────────────────────────────
async function backgroundRefresh() {
  console.log('[Scraper] Background refresh starting…');
  try {
    const scraped = await scrapeChrono24();
    if (scraped && scraped.length > 0) {
      watchCache = { data: scraped, ts: Date.now(), source: 'chrono24-live' };
      await writeFile(WATCHES_FILE, JSON.stringify(scraped, null, 2), 'utf-8').catch(() => {});
      console.log(`[Scraper] Background refresh done: ${scraped.length} watches`);
    } else {
      console.log('[Scraper] Background refresh: no data, keeping cache');
    }
  } catch (e) {
    console.error('[Scraper] Background refresh error:', e.message);
  }
}

// First refresh 15s after start (let server come up), then every 30 min
setTimeout(backgroundRefresh, 15_000);
setInterval(backgroundRefresh, CACHE_TTL);

// ─── HTTP Server ──────────────────────────────────────────
const server = createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // ── GET /api/watches ─────────────────────────────────
  if (urlPath === '/api/watches') {
    try {
      const watches = await getWatches();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({
        watches,
        count: watches.length,
        source: watchCache.source,
        lastUpdated: new Date(watchCache.ts).toISOString(),
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/img?url=... (image proxy) ───────────────
  // Fetches Chrono24 images server-side so hotlink rules never block the browser.
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
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://www.chrono24.com.tr/',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        timeout: 10000,
      }, (imgRes) => {
        const ct = imgRes.headers['content-type'] || 'image/jpeg';
        res.writeHead(imgRes.statusCode, {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400', // 24h browser cache
          'Access-Control-Allow-Origin': '*',
        });
        imgRes.pipe(res);
      }).on('error', (e) => {
        res.writeHead(502); res.end('Proxy error: ' + e.message);
      });
    } catch (e) {
      res.writeHead(500); res.end('Error: ' + e.message);
    }
    return;
  }

  // ── GET /api/refresh (manual trigger) ────────────────
  if (urlPath === '/api/refresh') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Refresh triggered' }));
    backgroundRefresh(); // non-blocking
    return;
  }

  // ── Static files ──────────────────────────────────────
  const filePath = join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`✓ Privé Watch → http://localhost:${PORT}`);
  console.log(`  /api/watches  — Chrono24 live feed (Puppeteer, cached 30 min)`);
  console.log(`  /api/refresh  — Manual refresh trigger`);
  console.log(`  Source URL    — https://www.chrono24.com.tr/search/index.htm?customerId=36265&dosearch=true`);
});
