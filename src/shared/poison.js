// Address-poisoning protection: scammers create addresses with the same first and last characters as one you
// already sent to, and plant fake transfers in your history hoping you copy theirs.
import { loadHistory } from './history.js';
import { local } from './ext.js';

const strip = (a) => String(a || '').toLowerCase().replace(/^0x/, '');
const prefixLen = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };

/** Same start and end (>= 3 characters each) but a different address. */
export function lookalike(a, b) {
  const x = strip(a), y = strip(b);
  if (!x || !y || x === y || x.length !== 40 || y.length !== 40) return false;
  const pre = prefixLen(x, y), suf = prefixLen([...x].reverse().join(''), [...y].reverse().join(''));
  return pre >= 3 && suf >= 3;
}

/** Remember a recipient the user really sent to (from this app). */
export async function rememberRecipient(address) {
  await local.update('recipients', [], (l) => [address.toLowerCase(), ...l.filter((x) => x !== address.toLowerCase())].slice(0, 200));
}

/**
 * known: addresses you trust (your accounts, past real recipients); poisoned: counterparties of the fake
 * transfers found in the recent history (the scammer's look-alike addresses).
 */
export async function addressBook(chain, me, ownAccounts, opts) {
  const known = new Set([...ownAccounts.map((a) => a.toLowerCase()), ...(await local.get('recipients', []))]);
  const poisoned = new Set();
  try {
    const log = (await local.get('txlog', {}))[`${chain.id}:${me.toLowerCase()}`] || [];
    const h = await loadHistory(chain, me, null, { ...opts, localLog: log });
    for (const it of h.items) {
      if (it.spam) { for (const x of it.transfers) if (x.counterparty) poisoned.add(x.counterparty.toLowerCase()); }
      else if (it.kind === 'send' && it.sentByMe && it.counterparty) known.add(it.counterparty.toLowerCase());
    }
  } catch { /* history unavailable: own accounts and saved recipients only */ }
  for (const p of poisoned) known.delete(p);
  return { known, poisoned };
}

/** Verdict for a recipient: { level: 'known'|'poisoned'|'lookalike'|null, similar } */
export function checkRecipient(to, book) {
  const a = String(to || '').toLowerCase();
  if (!book || !/^0x[0-9a-f]{40}$/.test(a)) return { level: null };
  if (book.poisoned.has(a)) return { level: 'poisoned', similar: [...book.known].find((k) => lookalike(k, a)) || null };
  if (book.known.has(a)) return { level: 'known' };
  const similar = [...book.known].find((k) => lookalike(k, a));
  return similar ? { level: 'lookalike', similar } : { level: null };
}
