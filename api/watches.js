// Vercel serverless function — serves watches.json
// Data is updated automatically by GitHub Actions (.github/workflows/update-watches.yml)
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default function handler(req, res) {
  try {
    const raw = readFileSync(join(__dirname, '..', 'watches.json'), 'utf-8');
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
    res.status(500).json({ error: e.message, watches: [], count: 0 });
  }
}
