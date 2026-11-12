// Build script: bundles sources with esbuild and produces
//   dist/chrome   (Manifest V3, service worker)
//   dist/firefox  (Manifest V3, background scripts)
//   dist/chakra-chrome.zip, dist/chakra-firefox.zip
import * as esbuild from 'esbuild';
import { zipSync } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { renderIcon } from './scripts/icon.mjs';
import { notificationVector } from './src/shared/mandala.js';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const watch = process.argv.includes('--watch');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// build number: the CI run number (the same as the Android versionCode); empty for local builds
const BUILD = process.env.ANDROID_VERSION_CODE || process.env.GITHUB_RUN_NUMBER || '';

// ---------------------------------------------------------------- manifests
const STORE_TEXTS = {
  en: 'A simple, clear Ethereum wallet. MetaMask compatible: works on every web3 site.',
  it: 'Wallet Ethereum semplice e chiaro. Compatibile con MetaMask: funziona su tutti i siti web3.',
};
function manifest(target) {
  const m = {
    manifest_version: 3,
    name: 'Chakra',
    short_name: 'Chakra',
    version: pkg.version,
    description: '__MSG_extDescription__',
    default_locale: 'en',
    icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    action: {
      default_popup: 'popup.html',
      default_title: 'Chakra',
      default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png' },
    },
    permissions: ['storage', 'alarms', 'unlimitedStorage'],
    host_permissions: ['http://*/*', 'https://*/*'],
    content_scripts: [
      { matches: ['http://*/*', 'https://*/*'], js: ['inpage.js'], run_at: 'document_start', world: 'MAIN', all_frames: false },
      { matches: ['http://*/*', 'https://*/*'], js: ['content.js'], run_at: 'document_start', all_frames: false },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  };
  if (target === 'chrome') {
    m.background = { service_worker: 'background.js' };
    m.minimum_chrome_version = '111';
  } else {
    m.background = { scripts: ['background.js'] };
    m.browser_specific_settings = {
      gecko: {
        id: 'chakra@chakrawallet.dev',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'] },
      },
    };
  }
  return m;
}

// ---------------------------------------------------------------- icons (procedural PNG)
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, rgba, height = size) {
  const raw = Buffer.alloc((size * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
// icons: see scripts/icon.mjs (guilloche rosette + medallion with a wallet)
const drawIcon = (size, mask = 'rounded') => encodePNG(size, renderIcon(size, size, { mask }));

// ---------------------------------------------------------------- build
const entries = {
  background: 'src/background/index.js',
  content: 'src/content.js',
  inpage: 'src/inpage.js',
  popup: 'src/ui/index.jsx',
  'vanity-worker': 'src/ui/vanityWorker.js', // Web Worker for the vanity address search, next to popup.html
};

function copyStatic(outdir, target) {
  fs.mkdirSync(path.join(outdir, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(outdir, 'manifest.json'), JSON.stringify(manifest(target), null, 2));
  // store listing texts (Chrome Web Store / Firefox Add-ons) in English and Italian
  for (const [l, d] of Object.entries(STORE_TEXTS)) {
    fs.mkdirSync(path.join(outdir, '_locales', l), { recursive: true });
    fs.writeFileSync(path.join(outdir, '_locales', l, 'messages.json'), JSON.stringify({ extDescription: { message: d } }, null, 2));
  }
  fs.copyFileSync(path.join(SRC, 'ui', 'popup.html'), path.join(outdir, 'popup.html'));
  for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(outdir, 'icons', `icon${s}.png`), drawIcon(s));
}

function zipDir(dir, out) {
  const files = {};
  const walk = (d, rel = '') => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f), r = rel ? `${rel}/${f}` : f;
      if (fs.statSync(p).isDirectory()) walk(p, r); else files[r] = fs.readFileSync(p);
    }
  };
  walk(dir);
  fs.writeFileSync(out, zipSync(files, { level: 9 }));
}

async function buildTarget(target) {
  const outdir = path.join(DIST, target);
  const opts = {
    entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, path.join(ROOT, v)])),
    bundle: true,
    outdir,
    format: 'iife',
    target: ['chrome111', 'firefox128'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    loader: { '.css': 'css', '.woff2': 'file', '.svg': 'dataurl' },
    assetNames: 'fonts/[name]',
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    define: { __TARGET__: JSON.stringify(target), __VERSION__: JSON.stringify(pkg.version), __BUILD__: JSON.stringify(BUILD) },
    logLevel: 'info',
  };
  copyStatic(outdir, target);
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
  } else {
    await esbuild.build(opts);
    zipDir(outdir, path.join(DIST, `chakra-${target}.zip`));
  }
}

// ---------------------------------------------------------------- Android (Capacitor)
const ANDROID_HTML = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
  <title>Chakra</title>
  <link rel="stylesheet" href="app.css" />
</head>
<body>
  <div id="app"></div>
  <script src="app.js"></script>
</body>
</html>
`;

async function buildAndroid() {
  const outdir = path.join(DIST, 'android-web');
  fs.mkdirSync(outdir, { recursive: true });
  fs.writeFileSync(path.join(outdir, 'index.html'), ANDROID_HTML);
  await esbuild.build({
    entryPoints: {
      app: path.join(SRC, 'mobile', 'index.jsx'), inject: path.join(SRC, 'mobile', 'inject.js'), 'vanity-worker': path.join(SRC, 'ui', 'vanityWorker.js'),
      'solc-worker': path.join(SRC, 'ui', 'solcWorker.js'), // Solidity compiler (Contracts tab), downloads soljson on first use
    },
    bundle: true, outdir, format: 'iife', target: ['chrome100'],
    jsx: 'automatic', jsxImportSource: 'preact', loader: { '.css': 'css', '.woff2': 'file', '.svg': 'dataurl' }, assetNames: 'fonts/[name]', minify: true,
    define: { __TARGET__: '"android"', __VERSION__: JSON.stringify(pkg.version), __BUILD__: JSON.stringify(BUILD) },
    logLevel: 'info',
  });
  // Tact compiler (TON studio, Contracts tab): its own bundle, loaded on the first compilation. The compiler is
  // written for Node: `path`, `process` and `fs` get small browser stand-ins (src/ui/shims).
  const shim = (f) => path.join(SRC, 'ui', 'shims', f);
  await esbuild.build({
    entryPoints: { 'tact-worker': path.join(SRC, 'ui', 'tactWorker.js') },
    bundle: true, outdir, format: 'iife', target: ['chrome100'], minify: true, logLevel: 'info',
    alias: {
      path: shim('path.js'), 'node:path': shim('path.js'), process: shim('process.js'), 'node:process': shim('process.js'),
      fs: shim('empty.js'), 'node:fs': shim('empty.js'), child_process: shim('empty.js'), 'node:buffer': 'buffer',
    },
  });
  // launcher icons (only once the native project exists)
  const res = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
  if (fs.existsSync(res)) {
    // notification icon: the mandala as a white silhouette (same geometry as the launcher icon)
    fs.writeFileSync(path.join(res, 'drawable', 'ic_stat_chakra.xml'), notificationVector());
    const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
    for (const [d, k] of Object.entries(dens)) {
      const dir = path.join(res, `mipmap-${d}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ic_launcher.png'), drawIcon(Math.round(48 * k), 'rounded'));
      fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), drawIcon(Math.round(48 * k), 'circle'));
      // adaptive icon (Android 8+): the launcher shows the central 72dp of a 108dp canvas
      const a = Math.round(108 * k), inset = 18 / 108;
      fs.writeFileSync(path.join(dir, 'ic_launcher_background.png'), encodePNG(a, renderIcon(a, a, { mask: 'none', layers: ['bg', 'rosette'], inset })));
      fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), encodePNG(a, renderIcon(a, a, { mask: 'none', layers: ['glyph'], inset })));
    }
    const adaptive = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@mipmap/ic_launcher_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n';
    fs.writeFileSync(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptive);
    fs.writeFileSync(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptive);
    fs.writeFileSync(path.join(res, 'values', 'ic_launcher_background.xml'),
      '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1B4DDB</color>\n</resources>\n');
    // splash screens: the medallion on the blue surface (same image in light and dark mode)
    for (const f of fs.readdirSync(res).filter((d) => d.startsWith('drawable'))) {
      const file = path.join(res, f, 'splash.png');
      if (!fs.existsSync(file)) continue;
      const head = fs.readFileSync(file).subarray(16, 24);
      const w = head.readUInt32BE(0), h = head.readUInt32BE(4);
      fs.writeFileSync(file, encodePNG(w, renderIcon(w, h, { mask: 'none', inset: 0.28 }), h));
    }
  }
}

const targets = process.argv.includes('--android') ? ['android'] : process.argv.includes('--ext') ? ['chrome', 'firefox'] : ['chrome', 'firefox', 'android'];
for (const t of targets) fs.rmSync(path.join(DIST, t === 'android' ? 'android-web' : t), { recursive: true, force: true });
await Promise.all(targets.map((t) => (t === 'android' ? buildAndroid() : buildTarget(t))));
if (!watch) console.log(`\nBuild complete: ${targets.map((t) => (t === 'android' ? 'dist/android-web' : 'dist/' + t)).join(', ')}`);
