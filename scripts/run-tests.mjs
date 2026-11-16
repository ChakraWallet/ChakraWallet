// Unit tests: bundles each tests/*.test.js with esbuild (Capacitor replaced by in-memory stand-ins),
// then runs them with the Node test runner. Usage: npm test  (also runs the i18n check)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TESTS = path.join(ROOT, 'tests');
const OUT = path.join(ROOT, 'node_modules', '.cache', 'chakra-tests');
const only = process.argv.slice(2);

const files = fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.js') && (!only.length || only.some((o) => f.includes(o))));
if (!files.length) { console.error('No tests found'); process.exit(1); }

fs.rmSync(OUT, { recursive: true, force: true });
const capacitor = path.join(TESTS, 'helpers', 'capacitor.js');
await esbuild.build({
  entryPoints: [
    ...files.map((f) => ({ in: path.join(TESTS, f), out: f.replace(/\.js$/, '') })),
    { in: path.join(TESTS, 'shim-entry.js'), out: 'shim.bundle' }, // imported twice by the storage test (restart)
  ],
  outdir: OUT,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.svg': 'dataurl' }, // flags (ui/language.jsx)
  alias: { '@capacitor/preferences': capacitor, '@capacitor/core': capacitor, '@capacitor/app': capacitor },
  external: ['solc', '@tact-lang/compiler', '@ton-community/func-js', 'esbuild'], // compilers (~10 MB each) and esbuild (Tact bindings test) load from node_modules
  // CommonJS packages (e.g. the TON crypto primitives) require Node built-ins: give the ESM bundles a require()
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'error',
});

const r = spawnSync(process.execPath, ['--test', ...files.map((f) => path.join(OUT, f.replace(/\.js$/, '.mjs')))], { stdio: 'inherit', cwd: ROOT });
process.exit(r.status ?? 1);
