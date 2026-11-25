// Shared helpers for the screenshot scripts: a tiny static server for .demo/ and a Chromium page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DEMO = path.join(HERE, '.demo');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

export function serve() {
  const server = http.createServer((req, res) => {
    const p = path.join(DEMO, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!p.startsWith(DEMO) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

const CHROME = process.env.CHROME_PATH || ['/snap/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));

export async function browser() {
  return chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--hide-scrollbars'] });
}

/**
 * A phone-sized page, or the extension's window (extension: 360x600, a desktop browser). Only the demo server and
 * token icons (public CoinGecko images) may be reached.
 */
export async function phone(b, base, { dark = false, lang = 'en', extension = false } = {}) {
  const ctx = await b.newContext({
    ...(extension ? { viewport: { width: 360, height: 600 }, isMobile: false, hasTouch: false } : { viewport: { width: 393, height: 793 }, isMobile: true, hasTouch: true }),
    deviceScaleFactor: 3,
    colorScheme: dark ? 'dark' : 'light', locale: lang === 'it' ? 'it-IT' : 'en-US', timezoneId: 'Europe/Rome',
  });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base) || u.startsWith('data:') || u.startsWith('https://assets.coingecko.com/coins/images/')) return route.continue();
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn('  [page error]', e.message));
  return page;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
