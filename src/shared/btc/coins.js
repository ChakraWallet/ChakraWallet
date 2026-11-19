// Which of an account's coins a send may use. A coin may carry an inscription (Ordinals) or runes: spent in a plain
// send, they would go to the recipient or to the miner. The protection works without any service:
//  - a coin created by a transaction with a runestone or an inscription envelope (read from the transaction itself);
//  - a coin of 10,000 sats or less (where inscriptions live, "postage"), unless an indexer says it's clean.
// With UniSat (the free key on mainnet, Testnet4 without one) the coins that really carry inscriptions or runes are
// known exactly. The user can also freeze a coin (never spent) or allow a protected one (Coins page).
import { local } from '../ext.js';
import { getTx } from './esplora.js';
import { hasInscription, hasRunestone } from './runes.js';
import { unisatReady, inscriptionUtxos, runeBalances, runeUtxos } from './unisat.js';

export const SMALL = 10_000n;
export const outpoint = (c) => `${c.txid}:${c.vout}`;

const FLAGS_KEY = (chain) => `btctxflags:${chain.id}`;
/** What the transactions that created coins carry: { [txid]: 'i' | 'r' | 'ir' | '' } (a txid's content never changes). */
async function txFlags(chain, txids, known = {}) {
  const all = await local.get(FLAGS_KEY(chain), {});
  const missing = txids.filter((id) => all[id] === undefined && known[id] === undefined);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(3, missing.length) }, async () => {
    while (i < missing.length) {
      const id = missing[i++];
      try {
        const tx = await getTx(chain, id);
        if (tx) all[id] = `${hasInscription(tx) ? 'i' : ''}${hasRunestone(tx) ? 'r' : ''}`;
      } catch { /* unknown: treated as possibly carrying something */ }
    }
  }));
  const ids = Object.keys(all);
  if (ids.length > 3000) for (const id of ids.slice(0, ids.length - 3000)) delete all[id];
  await local.set(FLAGS_KEY(chain), all).catch(() => {});
  return { ...all, ...known };
}

const PREFS_KEY = (chain, a) => `btccoins:${chain.id}:${a.id}`;
/** The user's choices on coins: { frozen: [outpoint], allowed: [outpoint] }. */
export const coinPrefs = async (chain, a) => ({ frozen: [], allowed: [], ...(await local.get(PREFS_KEY(chain, a), {})) });
export async function setCoinPref(chain, a, op, pref) {
  await local.update(PREFS_KEY(chain, a), {}, (p) => {
    const frozen = new Set(p.frozen || []), allowed = new Set(p.allowed || []);
    frozen.delete(op); allowed.delete(op);
    if (pref === 'frozen') frozen.add(op);
    if (pref === 'allowed') allowed.add(op);
    return { frozen: [...frozen], allowed: [...allowed] };
  });
}

/**
 * The coins with what protects them: each gets protect ('inscription' | 'runes' | 'small' | 'unknown' | null),
 * inscriptions / runes when known, frozen, allowed, spendable (a plain send may use it).
 * sent: the transactions this wallet sent ({ [txid]: entry with a plan }): their flags are known without asking.
 * -> { coins, precise (UniSat answered for every address), runes: [{ id, … }] (balances, when known) }
 */
export async function markCoins(chain, a, coins, sent = {}) {
  const prefs = await coinPrefs(chain, a);
  const frozen = new Set(prefs.frozen), allowed = new Set(prefs.allowed);
  // 1) exactly, from UniSat
  const exact = new Map(); // outpoint -> { inscriptions, runes }
  const preciseAddr = new Set();
  const runes = [];
  if (unisatReady(chain)) {
    const addrs = [...new Set(coins.map((c) => c.address))];
    for (const address of addrs) {
      try {
        const [ins, bal] = await Promise.all([inscriptionUtxos(chain, address), runeBalances(chain, address)]);
        for (const u of ins) exact.set(`${u.txid}:${u.vout}`, { inscriptions: u.inscriptions, runes: [] });
        for (const r of bal) {
          if (r.amount <= 0n) continue;
          runes.push({ ...r, address });
          for (const u of await runeUtxos(chain, address, r.id)) {
            const k = `${u.txid}:${u.vout}`;
            const e = exact.get(k) || { inscriptions: [], runes: [] };
            for (const x of u.runes) if (!e.runes.some((y) => y.id === x.id)) e.runes.push(x);
            exact.set(k, e);
          }
        }
        preciseAddr.add(address);
      } catch { /* this address: the protection without services */ }
    }
  }
  // 2) without services: what the creating transactions carry
  const known = {};
  // this wallet's own transactions: a runestone it wrote; 'c' (clean) when it spent no protected coin
  for (const [txid, e] of Object.entries(sent)) known[txid] = e.plan?.outputs?.some((o) => String(o.script || '').startsWith('6a5d')) ? 'r' : e.plan?.clean ? 'c' : '';
  const needFlags = coins.filter((c) => !preciseAddr.has(c.address) || !c.confirmed).map((c) => c.txid);
  const flags = needFlags.length ? await txFlags(chain, [...new Set(needFlags)], known) : known;
  const out = coins.map((c) => {
    const op = outpoint(c);
    const e = exact.get(op);
    let protect = null;
    if (e?.inscriptions?.length) protect = 'inscription';
    else if (e?.runes?.length) protect = 'runes';
    else if (!preciseAddr.has(c.address) || !c.confirmed) {
      const f = flags[c.txid];
      if (f === 'c') protect = null;
      else if (f === undefined) protect = c.value <= SMALL ? 'small' : null;
      else if (f.includes('i') && c.value <= SMALL * 10n) protect = 'inscription';
      else if (f.includes('r')) protect = 'runes';
      else if (c.value <= SMALL) protect = 'small';
    }
    const isFrozen = frozen.has(op), isAllowed = allowed.has(op);
    return { ...c, protect, inscriptions: e?.inscriptions || [], runes: e?.runes || [], frozen: isFrozen, allowed: isAllowed, spendable: !isFrozen && (!protect || isAllowed) };
  });
  return { coins: out, precise: coins.length > 0 && coins.every((c) => preciseAddr.has(c.address)), runes };
}
