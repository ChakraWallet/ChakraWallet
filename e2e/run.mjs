// End-to-end tests: local networks + simulated services + the real app in Chromium. Usage:
//   npm run e2e                 every test (e2e/tests/*.test.mjs)
//   npm run e2e -- swap         only the files whose name contains "swap"
// Nothing goes to the internet: the browser may reach 127.0.0.1 only. See e2e/README.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startEvm } from './env/evm.mjs';
import { startServices } from './env/services.mjs';
import { startTcBridge } from './env/tcbridge.mjs';
import { buildApp, OUT } from './app/build.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const only = process.argv.slice(2);
const stops = [];
let code = 1;
try {
  const t0 = Date.now();
  const evm = await startEvm(); stops.push(evm.stop);
  const ton = await import('./env/ton.mjs').then((m) => m.startTon()).catch((e) => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return null; });
  if (ton) stops.push(ton.stop);
  const btc = await import('./env/btc.mjs').then((m) => m.startBtc()); stops.push(btc.stop); // Bitcoin Local (Esplora API)
  const svc = await startServices(evm, { extra: ton?.services || {} }); stops.push(svc.close);
  const tcb = await startTcBridge(); stops.push(tcb.close); // TON Connect bridge
  const state = { services: svc.url, omniston: ton?.omniston || null, tcbridge: tcb.url, evm: evm.networks.map(({ abi, ...n }) => n), ton: ton?.state || null, btc: btc.state };
  await buildApp(state);
  fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify({ ...state, abi: evm.networks[0].abi }));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
  const web = http.createServer((q, r) => {
    const f = path.join(OUT, new URL(q.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
    if (!f.startsWith(OUT) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
  });
  await new Promise((r) => web.listen(9200, '127.0.0.1', r)); stops.push(() => web.close());
  console.log(`environment ready in ${Date.now() - t0} ms`);
  const files = fs.readdirSync(path.join(HERE, 'tests')).filter((f) => f.endsWith('.test.mjs') && (!only.length || only.some((o) => f.includes(o)))).sort().map((f) => path.join(HERE, 'tests', f));
  // asynchronous: this process keeps serving the app and the simulated services while the tests run
  code = await new Promise((resolve) => {
    spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
      stdio: 'inherit', env: { ...process.env, E2E_APP: 'http://127.0.0.1:9200/', E2E_STATE: path.join(OUT, 'state.json') },
    }).on('exit', (c) => resolve(c ?? 1));
  });
} catch (e) {
  console.error(e);
} finally {
  for (const s of stops.reverse()) { try { await s(); } catch { /* already stopped */ } }
}
process.exit(code);
