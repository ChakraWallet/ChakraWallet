// Tact compilation (TON studio, Android app): runs in the worker (ui/tactWorker.js) and in the tests.
// Uses the compiler's browser entry (virtual file system, FunC compiled to WebAssembly). Besides code and ABI it
// returns how Tact lays out the init arguments and every type of the ABI in cells (the same allocation its
// TypeScript bindings use), so the app builds init data and message bodies without the bindings (see tact.js).
import { Buffer } from './buffer.js';
import { run } from '@tact-lang/compiler/dist/browser.js';
import { allocate, getAllocationOperationFromField } from '@tact-lang/compiler/dist/storage/allocator.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const text = (b) => Buffer.from(b, 'base64').toString('utf8');

/** "…/main.tact:12:5: message" -> { file, line, col, message } */
function parseError(msg, files) {
  const s = String(msg).replace(/^Error:\s*/, '');
  const m = /([^\s:]+\.tact):(\d+):(\d+):\s*([\s\S]*)$/.exec(s);
  if (!m) return { file: null, line: null, col: null, message: s.trim() };
  const tail = m[1].replace(/^(\.\.\/)+|^\.\//, '');
  const file = Object.keys(files).find((f) => f === tail || f.endsWith('/' + tail) || tail.endsWith(f)) || tail;
  return { file, line: Number(m[2]), col: Number(m[3]), message: m[4].trim() };
}

/** Allocations of the ABI types (dependencies first), as the TypeScript bindings compute them. */
function typeAllocations(abi) {
  const out = {};
  const pending = [...abi.types];
  for (let guard = 0; pending.length && guard < 1000; guard++) {
    const ty = pending.shift();
    try {
      const ops = ty.fields.map((f) => ({ name: f.name, type: f.type, op: getAllocationOperationFromField(f.type, (s) => { if (!out[s]) throw new Error('later'); return out[s].size; }) }));
      const headerBits = ty.header ? 32 : 0;
      const root = allocate({ reserved: { bits: headerBits, refs: 0 }, ops });
      out[ty.name] = { size: { bits: root.size.bits + headerBits, refs: root.size.refs }, root, header: ty.header ?? null };
    } catch (e) {
      if (e.message === 'later') pending.push(ty);
    }
  }
  return out;
}

/**
 * files { path: text }, main (entry file) -> { ok, errors: [{ file, line, col, message }], contracts: [{ name, code (base64 BoC),
 *   abi, types (allocations), init, compiler, bindings? (TypeScript wrapper, when asked) }] }
 */
export function compileTactProject({ files, main, bindings = false }) {
  const vfs = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, b64(v)]));
  const errors = [];
  const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: (m) => errors.push(parseError(m, files)) };
  const config = { projects: [{ name: 'p', path: `./${main}`, output: './output', options: {} }] };
  return run({ config, files: vfs, logger }).then((r) => {
    const contracts = [];
    for (const [k, v] of Object.entries(vfs)) {
      const m = /^output\/p_(.+)\.pkg$/.exec(k);
      if (!m) continue;
      const pkg = JSON.parse(text(v));
      const abi = JSON.parse(pkg.abi);
      const types = typeAllocations(abi);
      let init = null;
      if (pkg.init) {
        let allocation = null, unsupported = false;
        try {
          const ops = pkg.init.args.map((a) => ({ name: a.name, type: a.type, op: getAllocationOperationFromField(a.type, (s) => { if (!types[s]) throw new Error('type'); return types[s].size; }) }));
          allocation = allocate({ reserved: { bits: pkg.init.prefix ? pkg.init.prefix.bits : 0, refs: 1 }, ops });
        } catch { unsupported = true; }
        init = { kind: pkg.init.kind, args: pkg.init.args, prefix: pkg.init.prefix || null, system: pkg.init.deployment?.system ?? null, allocation, unsupported };
      }
      const ts = bindings ? vfs[`output/p_${m[1]}.ts`] : null;
      contracts.push({ name: pkg.name, code: pkg.code, abi, types, init, compiler: pkg.compiler?.version || null, ...(ts ? { bindings: text(ts) } : {}) });
    }
    // errors of a failed build without location (e.g. "Tact compilation failed") are only noise next to the real ones
    const real = errors.filter((e) => e.file || !/compilation failed/i.test(e.message));
    return { ok: r.ok && contracts.length > 0, errors: real.length ? real : errors, contracts };
  });
}
