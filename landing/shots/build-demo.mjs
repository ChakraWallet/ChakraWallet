// Builds the Android app UI for a plain browser, with invented data, into landing/shots/.demo/.
// Same sources and esbuild options as build.mjs (Android target); only the data layer is swapped:
//   src/shared/{portfolio,history,swap}.js -> mocks/*.js (they re-export the real module and override the loaders)
//   @capacitor/*                           -> stubs/*.js (no native side in a browser)
//   every other request                    -> mocks/fetch.js (JSON-RPC, prices, Polymarket)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, '.demo');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const MOCKED = ['portfolio', 'history', 'swap'];
const demoData = {
  name: 'demo-data',
  setup(b) {
    b.onResolve({ filter: /^@capacitor\// }, (a) => ({ path: path.join(HERE, 'stubs', `capacitor-${a.path.split('/')[1]}.js`) }));
    b.onResolve({ filter: new RegExp(`(^|/)(${MOCKED.join('|')})\\.js$`) }, (a) => {
      const target = path.resolve(a.resolveDir, a.path);
      const name = path.basename(target, '.js');
      if (target !== path.join(ROOT, 'src/shared', `${name}.js`)) return undefined;
      if (a.importer.startsWith(path.join(HERE, 'mocks'))) return undefined; // the mock itself imports the real one
      return { path: path.join(HERE, 'mocks', `${name}.js`) };
    });
  },
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>Chakra (demo)</title><link rel="stylesheet" href="app.css" /></head>
<body><div id="app"></div><script src="app.js"></script></body></html>
`);
await esbuild.build({
  entryPoints: { app: path.join(HERE, 'demo-entry.js'), 'vanity-worker': path.join(ROOT, 'src/ui/vanityWorker.js') },
  bundle: true, outdir: OUT, format: 'iife', target: ['chrome100'],
  jsx: 'automatic', jsxImportSource: 'preact', loader: { '.css': 'css', '.woff2': 'file', '.svg': 'dataurl' }, assetNames: 'fonts/[name]',
  nodePaths: [path.join(ROOT, 'node_modules')],
  define: { __TARGET__: '"android"', __VERSION__: JSON.stringify(pkg.version), __BUILD__: '"128"' },
  plugins: [demoData], logLevel: 'warning',
});
console.log('demo build:', path.relative(process.cwd(), OUT));
