import { locale } from './i18n.js';
import { displayCurrency } from './fx.js';
import { formatUnits, parseUnits } from 'ethers';

export const shortAddr = (a, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : '');

/** Human amount from raw bigint/str. Max `sig` significant decimals, Italian locale. */
export function fmtAmount(raw, decimals = 18, maxFrac = 6) {
  if (raw === null || raw === undefined) return '–';
  const s = formatUnits(BigInt(raw), decimals);
  return fmtNum(Number(s), maxFrac, s);
}

export function fmtNum(n, maxFrac = 6, exact) {
  if (!isFinite(n)) return '–';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 10 ** -maxFrac) return '< ' + (10 ** -maxFrac).toFixed(maxFrac).replace('.', ',');
  let frac = abs >= 1000 ? 2 : abs >= 1 ? 4 : maxFrac;
  frac = Math.min(frac, maxFrac);
  return n.toLocaleString(locale(), { maximumFractionDigits: frac });
}

/** A USD value shown in the display currency chosen in Settings (see fx.js). */
export function fmtUsd(n) {
  if (n === null || n === undefined || !isFinite(n)) return '';
  const { code, rate } = displayCurrency();
  const v = n * rate;
  const opts = { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (v !== 0 && Math.abs(v) < 0.01) return `< ${(0.01).toLocaleString(locale(), opts)}`;
  return v.toLocaleString(locale(), opts);
}

export const toFloat = (raw, decimals = 18) => Number(formatUnits(BigInt(raw || 0), decimals));

export function parseAmount(str, decimals) {
  const clean = String(str || '').trim().replace(/\s/g, '').replace(',', '.');
  if (!clean || !/^\d*\.?\d*$/.test(clean)) return null;
  try { return parseUnits(clean, decimals); } catch { return null; }
}

/** raw -> plain string for inputs (dot decimal) */
export function rawToInput(raw, decimals) {
  let s = formatUnits(BigInt(raw), decimals);
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return s;
}

export function fmtDateGroup(ms) {
  const d = new Date(ms), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) return 'Oggi';
  if (diff === 1) return 'Ieri';
  return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export const fmtTime = (ms) => new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
export const fmtDateTime = (ms) => new Date(ms).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });

/** Deterministic avatar gradient for an address */
export function hexToUtf8(hex) {
  try {
    if (!/^0x[0-9a-f]*$/i.test(hex)) return hex;
    const bytes = new Uint8Array(hex.slice(2).match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) || []);
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0e-\x1f]/.test(s)) return null;
    return s;
  } catch { return null; }
}
