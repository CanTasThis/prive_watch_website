#!/usr/bin/env node
// Standalone Chrono24 scraper — runs locally or via GitHub Actions.
// Writes output to watches.json in the same directory.
// Usage: node scrape.mjs
import { writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCHES_FILE = join(__dirname, 'watches.json');
const SEARCH_URL = 'https://www.chrono24.com.tr/search/index.htm?customerId=36265&dosearch=true';

const KNOWN_BRANDS = [
  'Patek Philippe', 'Audemars Piguet', 'Jaeger-LeCoultre',
  'A. Lange & Söhne', 'F.P. Journe', 'Tag Heuer', 'TagHeuer',
  'Rolex', 'Omega', 'Cartier', 'IWC', 'Breitling', 'Panerai',
  'Hublot', 'Tudor', 'Bulgari', 'Bvlgari', 'Chopard', 'Zenith',
  'Longines', 'Tissot', 'Rado', 'Seiko', 'Grand Seiko',
  'Vacheron Constantin', 'Girard-Perregaux', 'Ulysse Nardin',
  'Blancpain', 'Breguet', 'Piaget', 'Roger Dubuis', 'Bell & Ross',
  'Richard Mille', 'Glashütte', 'Nomos', 'H. Moser',
];

function parseAlt(alt) {
  if (!alt) return { brand: 'Diğer', model: '', ref: '' };
  let brand = 'Diğer';
  let rest = alt;
  const sorted = [...KNOWN_BRANDS].sort((a, b) => b.length - a.length);
  for (const b of sorted) {
    if (alt.toLowerCase().startsWith(b.toLowerCase())) {
      brand = b === 'Bvlgari' ? 'Bulgari' : b === 'TagHeuer' ? 'Tag Heuer' : b;
      rest = alt.slice(b.length).trim();
      break;
    }
    if (alt.toLowerCase().includes(b.toLowerCase())) {
      brand = b === 'Bvlgari' ? 'Bulgari' : b === 'TagHeuer' ? 'Tag Heuer' : b;
      rest = alt.replace(new RegExp(b, 'i'), '').trim();
      break;
    }
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  let ref = '';
  let model = rest;
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    if (/\d/.test(last) || /[A-Z]+-\d+/.test(last)) {
      ref = last;
      model = tokens.slice(0, -1).join(' ');
    }
  }
  return { brand, model: model || rest, ref };
}

async function scrape() {
  let puppeteer;
  try {
    // Support both local (node_modules) and GitHub Actions (global install)
    const localPath = join(__dirname, 'node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js');
    puppeteer = (await import(localPath)).default;
  } catch {
    try {
      puppeteer = (await import('puppeteer')).default;
    } catch (e) {
      console.error('Puppeteer not found:', e.message);
      process.exit(1);
    }
  }

  console.log('[Scraper] Launching browser…');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    console.log('[Scraper] Loading', SEARCH_URL);
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    const raw = await page.evaluate(() => {
      return [...document.querySelectorAll('.wt-listing-item')].map(card => {
        const link = card.querySelector('a[href*="--id"]');
        const imgs = [...card.querySelectorAll('img')];
        const masterImg = imgs.find(i => i.dataset && i.dataset.lazySweetSpotMasterSrc);
        const realImg = imgs.find(i => i.src && i.src.startsWith('https://img.chrono24.com'));
        const masterSrc = masterImg
          ? masterImg.dataset.lazySweetSpotMasterSrc.replace('_SIZE_', '480')
          : null;
        return {
          href: link ? link.getAttribute('href') : null,
          alt: (masterImg || realImg) ? (masterImg || realImg).alt : null,
          imgSrc: masterSrc || (realImg ? realImg.src : null),
        };
      });
    });

    await browser.close();

    const seen = new Set();
    const watches = [];
    for (const item of raw) {
      if (!item.href || seen.has(item.href)) continue;
      seen.add(item.href);
      const { brand, model, ref } = parseAlt(item.alt);
      const url = item.href.startsWith('http')
        ? item.href
        : 'https://www.chrono24.com.tr' + item.href;
      let img = item.imgSrc || null;
      if (img) {
        img = img
          .replace(/Square_SIZE_/g, 'Square480')
          .replace(/-Square\d+\.jpg$/, '-Square480.jpg')
          .replace(/-ExtraLarge\.jpg$/, '-Square480.jpg');
        // Store as proxy path for both local and Vercel
        img = '/api/img?url=' + encodeURIComponent(img);
      }
      watches.push({ brand, model, ref, img, hasImg: !!img, url });
    }

    await writeFile(WATCHES_FILE, JSON.stringify(watches, null, 2), 'utf-8');
    console.log(`[Scraper] Done — ${watches.length} watches written to watches.json`);
    return watches.length;
  } catch (e) {
    await browser.close().catch(() => {});
    console.error('[Scraper] Error:', e.message);
    process.exit(1);
  }
}

scrape();
