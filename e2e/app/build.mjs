// Builds the app under test into e2e/.build/ with the environment's addresses (same esbuild options as build.mjs,
// Android target; Capacitor's native plugins replaced by stand-ins, as in a browser there is no native side).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../..');
export const OUT = path.join(ROOT, 'e2e', '.build');

export async function buildApp(state) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Chakra (e2e)</title><link rel="stylesheet" href="app.css"></head><body><div id="app"></div><script src="app.js"></script></body></html>');
  const stubs = { name: 'capacitor-stubs', setup(b) { b.onResolve({ filter: /^@capacitor\// }, (a) => ({ path: path.join(HERE, 'stubs', `capacitor-${a.path.split('/')[1]}.js`) })); } };
  await esbuild.build({
    entryPoints: { app: path.join(HERE, 'entry.js') },
    bundle: true, outdir: OUT, format: 'iife', target: ['chrome100'],
    jsx: 'automatic', jsxImportSource: 'preact', loader: { '.css': 'css', '.woff2': 'file', '.svg': 'dataurl' }, assetNames: 'fonts/[name]',
    define: { __TARGET__: '"android"', __VERSION__: '"e2e"', __BUILD__: '"0"', __E2E__: JSON.stringify(state) },
    plugins: [stubs], logLevel: 'warning',
  });
  return OUT;
}
