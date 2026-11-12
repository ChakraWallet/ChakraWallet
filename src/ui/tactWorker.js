// Tact compiler in a Web Worker (Android app only, bundled as tact-worker.js: ~10 MB, loaded the first time the TON
// studio compiles). The compilation itself is in shared/ton/tactCompile.js.
// Messages in:  { id, type: 'compile', files: { path: text }, main }
// Messages out: { id, type: 'result', ok, errors: [{ file, line, col, message }], contracts: [...] } | { id, type: 'error', message }
import { compileTactProject } from '../shared/ton/tactCompile.js';

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'compile') self.postMessage({ id: m.id, type: 'result', ...(await compileTactProject({ files: m.files, main: m.main })) });
  } catch (err) {
    self.postMessage({ id: m.id, type: 'error', message: err?.message || String(err) });
  }
};
