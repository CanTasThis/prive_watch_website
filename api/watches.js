// Vercel serverless function (CommonJS) — serves watches.json
// watches.json is updated every 6h by GitHub Actions → triggers Vercel redeploy.
const { readFileSync } = require('fs');
const { join } = require('path');

module.exports = function handler(req, res) {
  try {
    // process.cwd() is the project root in Vercel's runtime environment.
    // includeFiles in vercel.json ensures watches.json is bundled with this function.
    const watchesPath = join(process.cwd(), 'watches.json');
    const raw = readFileSync(watchesPath, 'utf-8');
    const watches = JSON.parse(raw);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      watches,
      count: watches.length,
      source: 'static',
      lastUpdated: new Date().toISOString(),
    });
  } catch (e) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({ error: e.message, watches: [], count: 0 });
  }
};
