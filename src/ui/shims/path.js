// Minimal POSIX `path` for browser bundles of Node-oriented libraries (the Tact compiler's virtual file system).
const norm = (parts, abs) => {
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(p);
  }
  return out;
};
export const sep = '/';
export const delimiter = ':';
export const isAbsolute = (p) => String(p).startsWith('/');
export function normalize(p) {
  const s = String(p);
  if (!s) return '.';
  const abs = isAbsolute(s), trail = s.endsWith('/');
  const r = norm(s.split('/'), abs).join('/');
  return (abs ? '/' : '') + (r || (abs ? '' : '.')) + (trail && r ? '/' : '');
}
export const join = (...ps) => normalize(ps.filter((x) => x !== '').join('/') || '.');
export function resolve(...ps) {
  let r = '';
  for (let i = ps.length - 1; i >= 0 && !isAbsolute(r); i--) r = ps[i] + (r ? '/' + r : '');
  if (!isAbsolute(r)) r = '/' + r;
  return normalize(r).replace(/(.)\/$/, '$1');
}
export function relative(from, to) {
  const a = resolve(from).split('/').filter(Boolean), b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
export function dirname(p) {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i);
}
export function basename(p, ext) {
  let b = String(p).replace(/\/+$/, '').split('/').pop() || '';
  if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length);
  return b;
}
export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}
export const parse = (p) => ({ root: isAbsolute(p) ? '/' : '', dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p, extname(p)) });
const path = { sep, delimiter, isAbsolute, normalize, join, resolve, relative, dirname, basename, extname, parse };
path.posix = path;
export const posix = path;
export default path;
