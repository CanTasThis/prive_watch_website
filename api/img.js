// Vercel serverless function — image proxy for Chrono24
// Bypasses hotlink protection by fetching server-side with proper headers.
export default async function handler(req, res) {
  const url = req.query.url;

  if (!url || !url.startsWith('https://img.chrono24.com/')) {
    res.status(400).end('Bad request');
    return;
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.chrono24.com.tr/',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });

    if (!upstream.ok) {
      res.status(upstream.status).end('Upstream error');
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const buffer = await upstream.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(Buffer.from(buffer));
  } catch (e) {
    res.status(502).end('Proxy error: ' + e.message);
  }
}
