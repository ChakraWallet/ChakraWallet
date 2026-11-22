// Error reports, kept on the device. The same code runs in the browser extension (popup and background), in the Android
// app and, later, in the iOS app: errors are caught here, cleaned of anything personal (scrub) and stored in a short
// local log (storage.local "crashLog"). Nothing is sent anywhere from this module: sending a report is always the
// user's choice, and they see its text first.
//
// What is caught:
//   - JavaScript errors and unhandled promise rejections (installCrashHandlers), minus well-known noise (network
//     failures, aborted requests, browser quirks);
//   - screens that fail to draw (ui/crash.jsx: reportError with kind 'render');
//   - crashes of the native app, collected at the next start from the platform's "Crash" plugin:
//       pending() -> { reports: [{ kind, at, message, stack, thread? }] }   clear() -> {}
//     kind: 'java' (Android uncaught exception), 'anr' (app not responding), 'native' (crash in native code),
//     'webview' (the web renderer crashed). Android: CrashPlugin.java. iOS: the same plugin name and methods (e.g. from
//     MetricKit's crash and hang diagnostics, plus an uncaught-exception handler), so nothing here changes.
//
// A report never holds keys, recovery phrases, addresses, amounts or URL parameters: scrub() removes them from every
// message and stack. It does hold the app version, the platform, the OS and device model (from the user agent), the
// screen on screen and the code location.
import { LangEn } from 'ethers';
import { local } from './ext.js';

const KEY = 'crashLog';
const MAX_REPORTS = 20;
const MAX_MESSAGE = 500;
const MAX_STACK = 6000;

/* global __TARGET__, __VERSION__, __BUILD__ */
const TARGET = typeof __TARGET__ !== 'undefined' ? __TARGET__ : 'test';
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0';
const BUILD = typeof __BUILD__ !== 'undefined' ? __BUILD__ : '';

// ---------------------------------------------------------------- scrubbing
const B58 = '1-9A-HJ-NP-Za-km-z';
const RULES = [
  // URLs: keep scheme, host and path (a stack frame needs them), drop query and fragment
  [/\b((?:https?|wss?|chrome-extension|moz-extension|capacitor|file):\/\/[^\s?#'"()]*)[?#][^\s'"()]*/g, '$1?…'],
  // extension ids in stack frames (chrome-extension://<32 letters>/, moz-extension://<uuid>/): same for everybody
  [/\b(chrome-extension:\/\/)[a-p]{32}/g, '$1<ext>'],
  [/\b(moz-extension:\/\/)[0-9a-f-]{36}/g, '$1<ext>'],
  // hex: EVM addresses, keys, hashes, calldata, raw TON addresses (wc:hex)
  [/\b0x[0-9a-fA-F]{8,}/g, '0x…'],
  [/\b-?\d:[0-9a-fA-F]{64}\b/g, '<addr>'],
  [/\b[0-9a-fA-F]{24,}\b/g, '<hex>'],
  // Bitcoin bech32 (bc1…, tb1…), extended keys (xpub/xprv/…), base58 (Bitcoin, Tron, Solana addresses and keys, WIF)
  [/\b(?:bc|tb|bcrt)1[02-9ac-hj-np-z]{8,}\b/gi, '<addr>'],
  [/\b[xyztuv](?:pub|prv)[1-9A-HJ-NP-Za-km-z]{20,}\b/g, '<xkey>'],
  [new RegExp(`\\b[${B58}]{25,}\\b`, 'g'), '<b58>'],
  // TON user-friendly addresses (48 base64url characters, e.g. EQ…, UQ…)
  [/(^|[^A-Za-z0-9_+/=-])[A-Za-z0-9_-]{48}(?![A-Za-z0-9_+/=-])/g, '$1<addr>'],
  // long base64 blobs (signed transactions, BOCs, payloads): mixed case and digits, unlike a plain path
  [/[A-Za-z0-9+/]{40,}={0,2}/g, (m) => (/\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) ? '<data>' : m)],
  // e-mail addresses
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'],
];
// recovery phrases (BIP39, also used by TON): 5 or more words of the list in a row become <words>
const WORDS = /\b[a-z]{3,8}(?:\s+[a-z]{3,8}){4,}\b/g;
const isWord = (w) => LangEn.wordlist().getWordIndex(w) >= 0;
function hidePhrases(text) {
  return text.replace(WORDS, (m) => {
    const ws = m.split(/\s+/), out = [];
    for (let i = 0; i < ws.length;) {
      let j = i;
      while (j < ws.length && isWord(ws[j])) j++;
      if (j - i >= 5) { out.push('<words>'); i = j; } else { out.push(ws[i]); i++; }
    }
    return out.join(' ');
  });
}
// amounts and other long numbers in a message (not in stacks, where line:column numbers are needed)
const NUMBER = /\b\d+(?:[.,]\d+)?\b/g;

/** Remove addresses, keys, hashes, amounts and URL parameters from a text. `numbers`: also replace numbers of 5+ digits. */
export function scrub(text, { numbers = false } = {}) {
  let s = String(text ?? '');
  for (const [re, to] of RULES) s = s.replace(re, to);
  s = hidePhrases(s);
  if (numbers) s = s.replace(NUMBER, (n) => (n.replace(/\D/g, '').length >= 5 ? '<n>' : n));
  return s;
}

// ---------------------------------------------------------------- noise
// Errors that say nothing about a bug in Chakra: the network, the user leaving a page, browser quirks.
const NOISE = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /Failed to fetch|NetworkError when attempting|Load failed|Network request failed|ERR_NETWORK|ERR_INTERNET_DISCONNECTED/i,
  /Extension context invalidated|Receiving end does not exist|message port closed|disconnected port/i,
  /The (?:operation|user) (?:was )?abort|signal is aborted|AbortError|TimeoutError/i,
];
const isNoise = (name, message) => /^(AbortError|TimeoutError)$/.test(name || '') || NOISE.some((re) => re.test(message || ''));

// ---------------------------------------------------------------- context
let where = 'app';
let screen = '';
/** The screen on show, recorded with a report (e.g. "wallet:swap"). */
export const setCrashScreen = (name) => { screen = String(name || ''); };

/** OS, device and browser engine from the user agent, e.g. { os: 'Android 14; Pixel 7', engine: 'Chrome 131' }. */
export function deviceInfo(ua = globalThis.navigator?.userAgent || '') {
  const inner = (ua.match(/\(([^)]*)\)/)?.[1] || '')
    .split(';').map((x) => x.trim()).filter((x) => x && !/^(wv|U|K|Linux|Mobile|rv:.*|x11|Win64|x64)$/i.test(x))
    .map((x) => x.replace(/\s*Build\/.*$/, '')).join('; ');
  const eng = ua.match(/\b(Firefox|Edg|OPR|Chrome|Version)\/(\d+)/g)?.map((x) => x.replace('/', ' ').replace('Version', 'Safari')) || [];
  const engine = ['Edg', 'OPR', 'Firefox', 'Chrome', 'Safari'].map((b) => eng.find((x) => x.startsWith(`${b} `))).find(Boolean) || '';
  return { os: inner.slice(0, 80), engine };
}

// ---------------------------------------------------------------- the log
const signature = (r) => `${r.kind}|${r.message}|${(r.stack.split('\n').find((l) => /\d+:\d+/.test(l)) || '').trim()}`;

/** Build a report from an error (or anything thrown). */
export function makeReport(err, { kind = 'error', at = Date.now(), thread } = {}) {
  const e = err instanceof Error ? err : null;
  const name = e?.name && e.name !== 'Error' ? `${e.name}: ` : '';
  const raw = e ? `${name}${e.message}` : typeof err === 'string' ? err : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
  const message = scrub(raw, { numbers: true }).slice(0, MAX_MESSAGE);
  // the first line of a stack repeats the message ("TypeError: …", "java.lang.X: …"): shown once, as the message
  const repeats = new Set([raw, e ? `${e.name}: ${e.message}` : '', e?.message || ''].map((x) => scrub(x).trim()).filter(Boolean));
  const stack = scrub(e?.stack || '').split('\n').filter((l) => l.trim() && !repeats.has(l.trim())).join('\n').slice(0, MAX_STACK);
  const { os, engine } = deviceInfo();
  const r = {
    kind, where, at, lastAt: at, count: 1, message, stack, screen: scrub(screen),
    app: `${VERSION}${BUILD ? ` (${BUILD})` : ''}`, platform: TARGET, os, engine,
  };
  if (thread) r.thread = scrub(thread);
  r.sig = signature(r);
  return r;
}

let queue = Promise.resolve();
/** Add a report to the local log: the same error again only counts once more; the oldest go first past MAX_REPORTS. */
export function recordReport(r) {
  queue = queue.then(async () => {
    const log = await local.get(KEY, []);
    const same = log.find((x) => x.sig === r.sig);
    if (same) { same.count += r.count; same.lastAt = Math.max(same.lastAt, r.at); same.ask ||= r.ask; } else log.push(r);
    log.sort((a, b) => a.lastAt - b.lastAt);
    await local.set(KEY, log.slice(-MAX_REPORTS));
  }).catch(() => {}); // never let error reporting throw an error of its own
  return queue;
}

/** Record an error caught by the app (e.g. a screen that failed to draw). */
export function reportError(err, opts = {}) {
  const name = err?.name, message = err?.message ?? String(err);
  if (isNoise(name, message)) return queue;
  return recordReport(makeReport(err, opts));
}

/** The reports kept on the device, newest first. */
export async function crashLog() {
  return (await local.get(KEY, [])).slice().sort((a, b) => b.lastAt - a.lastAt);
}
export const clearCrashLog = () => local.set(KEY, []);

/** A crash that closed the app and that the user hasn't been asked about yet (the newest), or null. */
export async function crashToAsk() {
  await nativeCollected;
  return (await crashLog()).find((r) => r.ask) || null;
}
/** The user saw the question about this crash (sent it or not): don't ask again. */
export function markAsked(sig) {
  queue = queue.then(async () => {
    const log = await local.get(KEY, []);
    for (const r of log) if (r.sig === sig) delete r.ask;
    await local.set(KEY, log);
  }).catch(() => {});
  return queue;
}

// ---------------------------------------------------------------- native crashes (Android now, iOS later)
let nativeCollected = Promise.resolve();
/**
 * Move the crashes the native app saved before it closed into the log (once per start). They closed the app, so the
 * app asks the user about them once (ask: crashToAsk / markAsked).
 */
export function collectNativeCrashes(plugin = globalThis.__CK_CRASH__) {
  if (!plugin?.pending) return nativeCollected;
  nativeCollected = (async () => {
    try {
      const { reports = [] } = await plugin.pending();
      for (const n of reports) {
        const err = Object.assign(new Error(n.message || n.kind), { stack: n.stack || '' });
        await recordReport({ ...makeReport(err, { kind: n.kind || 'native', at: n.at || Date.now(), thread: n.thread }), ask: true });
      }
      await plugin.clear();
    } catch { /* the plugin is missing or failed: nothing to collect */ }
  })();
  return nativeCollected;
}

// ---------------------------------------------------------------- sending (always by the user)
// Two ways, both started by the user after reading the report: an e-mail (we see their address) or a GitHub issue
// (public). The text is in English (it's for the developers); the user may add a description in any language.
export const SUPPORT_EMAIL = 'info@chakrawallet.dev';
export const ISSUES_URL = 'https://github.com/ChakraWallet/ChakraWallet/issues/new';
const MAILTO_MAX = 2000; // mailto: links longer than this are cut by some systems (the full text: Copy, or GitHub)
const GITHUB_MAX = 7000; // GitHub refuses longer "new issue" links

const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
/** The app and the device, the first line of every report (also of a message without an error). */
export function aboutLine() {
  const { os, engine } = deviceInfo();
  return ['Chakra ' + `${VERSION}${BUILD ? ` (${BUILD})` : ''}`, TARGET, os, engine].filter(Boolean).join(' · ');
}

/** The report as plain text, as the user sees it before sending. `stackMax`: cut the stack to fit a link. */
export function reportText(r, stackMax = MAX_STACK) {
  if (!r) return aboutLine();
  const seen = r.count > 1 ? ` · ×${r.count}` : '';
  const head = [`Chakra ${r.app} · ${r.platform}${r.os ? ` · ${r.os}` : ''}${r.engine ? ` · ${r.engine}` : ''}`,
    `${r.kind} · ${r.where}${r.screen ? ` · ${r.screen}` : ''}${r.thread ? ` · thread ${r.thread}` : ''} · ${when(r.lastAt)}${seen}`, r.message];
  const stack = r.stack.length > stackMax ? `${r.stack.slice(0, stackMax)}\n…` : r.stack;
  return [...head, stack].filter(Boolean).join('\n');
}

const title = (r) => (r ? `Error: ${r.message.split('\n')[0]}`.slice(0, 90) : '');
const fit = (r, build, max) => { // the longest stack that keeps the whole thing under max
  let n = MAX_STACK, out = build(reportText(r, n));
  while (out.length > max && n > 200) { n = Math.floor(n * 0.7); out = build(reportText(r, n)); }
  return out;
};

const mailBody = (text) => `What happened (optional):\n\n\n---\n${text}\n`;
/** E-mail parts { to, subject, body } with the whole report (the Android app's mail intent has no length limit). */
export function emailParts(r) {
  return { to: SUPPORT_EMAIL, subject: r ? `[Chakra] ${title(r)}` : '[Chakra] Support', body: mailBody(reportText(r)) };
}
/** The same as a mailto: link (browser extension), with the stack cut to fit the link. */
export function mailtoUrl(r) {
  const { to, subject } = emailParts(r);
  return fit(r, (text) => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody(text))}`, MAILTO_MAX);
}

/** A "new issue" link on GitHub with title and report filled in (the user can still edit them before posting). */
export function githubIssueUrl(r) {
  const build = (text) => `${ISSUES_URL}?title=${encodeURIComponent(title(r))}&body=${encodeURIComponent(
    `**What happened** (optional):\n\n\n**Report** (no addresses, keys or amounts)\n\n\`\`\`\n${text}\n\`\`\`\n`)}`;
  return fit(r, build, GITHUB_MAX);
}

// ---------------------------------------------------------------- global handlers
let installed = false;
/**
 * Catch uncaught errors and unhandled rejections of this JavaScript context. `place`: 'ui', 'background' or 'app'
 * (Android/iOS: background and UI share one page). Safe to call more than once: the first call wins.
 */
export function installCrashHandlers(place) {
  if (installed || typeof globalThis.addEventListener !== 'function') return;
  installed = true;
  where = place;
  globalThis.addEventListener('error', (ev) => {
    if (ev.target && ev.target !== globalThis && ev.target.tagName) return; // a failed <img>/<script> load, not an error
    reportError(ev.error || ev.message, { kind: 'error' });
  });
  globalThis.addEventListener('unhandledrejection', (ev) => reportError(ev.reason, { kind: 'rejection' }));
  collectNativeCrashes();
}
