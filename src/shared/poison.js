// Address-poisoning protection: scammers create addresses with the same first and last characters as one you
// already sent to, and plant fake transfers in your history hoping you copy theirs.
// The rules about addresses are a "kit" per family of networks: EVM's here (the default), TON's in its driver
// (src/ui/ton/driver.js, poisonKit). A kit: { canonical(text) -> the address' identity or null, lookalike(a, b) on
// canonical forms, display(canonical) -> the form shown and compared by eye, store: where recipients are remembered }.
import { loadHistory } from './history.js';
import { local } from './ext.js';

const strip = (a) => String(a || '').toLowerCase().replace(/^0x/, '');
/** Length of the common start of two strings. */
export const prefixLen = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
/** Length of the common end of two strings. */
export const suffixLen = (a, b) => prefixLen([...a].reverse().join(''), [...b].reverse().join(''));

/** Same start and end (>= 3 characters each) but a different address. */
export function lookalike(a, b) {
  const x = strip(a), y = strip(b);
  if (!x || !y || x === y || x.length !== 40 || y.length !== 40) return false;
  return prefixLen(x, y) >= 3 && suffixLen(x, y) >= 3;
}

/** EVM addresses: identity = lower-case hex. */
export const EVM_KIT = {
  canonical: (a) => { const s = String(a || '').trim(); return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null; },
  lookalike,
  display: (a) => a,
  store: 'recipients',
};

/** Remember a recipient the user really sent to (from this app). */
export async function rememberRecipient(address, kit = EVM_KIT) {
  const a = kit.canonical(address);
  if (!a) return;
  await local.update(kit.store, [], (l) => [a, ...l.filter((x) => x !== a)].slice(0, 200));
}

/**
 * known: addresses you trust (your accounts, past real recipients); poisoned: counterparties of the fake
 * transfers found in the recent history (the scammer's look-alike addresses). All in canonical form.
 * opts.history(chain, me, cursor, opts): the family's history (default: EVM's).
 */
export async function addressBook(chain, me, ownAccounts, opts = {}, kit = EVM_KIT) {
  const { history = loadHistory, ...hopts } = opts;
  const canon = (x) => kit.canonical(x);
  const known = new Set([...ownAccounts.map(canon), ...(await local.get(kit.store, []))].filter(Boolean));
  const poisoned = new Set();
  try {
    const log = (await local.get('txlog', {}))[`${chain.id}:${String(me).toLowerCase()}`] || [];
    const h = await history(chain, me, null, { ...hopts, localLog: log });
    for (const it of h.items) {
      if (it.spam) { for (const x of it.transfers) { const c = canon(x.counterparty); if (c) poisoned.add(c); } }
      else if (it.kind === 'send' && it.sentByMe && it.counterparty) { const c = canon(it.counterparty); if (c) known.add(c); }
    }
  } catch { /* history unavailable: own accounts and saved recipients only */ }
  for (const p of poisoned) known.delete(p);
  return { known, poisoned };
}

/**
 * Verdict for a recipient: { level: 'known'|'poisoned'|'lookalike'|null, similar, shown } — similar and shown in the
 * kit's display form (the two addresses the warning compares character by character).
 */
export function checkRecipient(to, book, kit = EVM_KIT) {
  const a = kit.canonical(to);
  if (!book || !a) return { level: null };
  const shown = kit.display(a);
  const near = () => { const k = [...book.known].find((x) => kit.lookalike(x, a)); return k ? kit.display(k) : null; };
  if (book.poisoned.has(a)) return { level: 'poisoned', similar: near(), shown };
  if (book.known.has(a)) return { level: 'known', shown };
  const similar = near();
  return similar ? { level: 'lookalike', similar, shown } : { level: null };
}
