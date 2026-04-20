// Vercel serverless function (CommonJS) — image proxy for Chrono24.
// Fetches images server-side with proper headers to bypass hotlink protection.
const https = require('https');

module.exports = function handler(req, res) {
  const url = (req.query && req.query.url) || '';

  if (!url || !url.startsWith('https://img.chrono24.com/')) {
    res.status(400).end('Bad request');
    return;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).end('Invalid URL');
    return;
  }

  const options = {
    hostname: parsed.hostname,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://www.chrono24.com.tr/',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
    timeout: 12000,
  };

  const upstream = https.request(options, (imgRes) => {
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(imgRes.statusCode);
    imgRes.pipe(res);
  });

  upstream.on('error', (e) => {
    if (!res.headersSent) {
      res.status(502).end('Proxy error: ' + e.message);
    }
  });

  upstream.on('timeout', () => {
    upstream.destroy();
    if (!res.headersSent) res.status(504).end('Timeout');
  });

  upstream.end();
};
