// Families of networks with keys of their own, besides Ethereum's (src/background/vault.js).
//
// Every account of a recovery phrase has an address on every family: each family derives its own key from the phrase
// (TON: background/ton.js). Wallets imported from another app of one family are stored in the vault per wallet as
//   w[kind] = [{ address, secret, ...family fields }]      and their accounts have   type = kind
// (TON: w.ton = [{ address: "0:…", secret: hex, version }], type 'ton' - the format the vault always had).
//
// A family registers here how to check one of those entries, so the vault can store, back up and restore them without
// knowing anything else about the family. Validation is plain data checks (no network library): it is registered in the
// browser extension too, so a backup made by the app keeps its TON accounts after a round trip through the extension.
import * as b58 from '../shared/solana/base58.js';
import { keyOfPrivate } from '../shared/tron/core.js';

const families = new Map();

/**
 * spec: { clean(entry) -> { address, secret, ... } | null } - an entry from the vault or a backup, normalised, or null
 * when invalid. The address is the account's address as stored (its id in the vault).
 */
export function registerFamily(kind, spec) { families.set(kind, { kind, ...spec }); }
export const familyKinds = () => [...families.keys()];
export const familyOf = (kind) => families.get(kind) || null;

// ---------------------------------------------------------------- TON (wallets imported from other TON apps)
export const TON_VERSIONS = ['v5r1', 'v4r2', 'v3r2'];
registerFamily('ton', {
  clean: (x) => (x && /^-?\d+:[0-9a-f]{64}$/i.test(x.address) && /^[0-9a-f]{64}$/i.test(x.secret) && TON_VERSIONS.includes(x.version)
    ? { address: x.address.toLowerCase(), secret: x.secret.toLowerCase(), version: x.version }
    : null),
});

// ---------------------------------------------------------------- Solana (wallets imported from other Solana apps)
// w.solana = [{ address (base58), secret: base58 of the 64-byte key, as Phantom exports it }], type 'solana'.
// Base58 is case-sensitive: kept as it is. The key's public half must be the address.
registerFamily('solana', {
  clean(x) {
    try {
      const a = String(x?.address || ''), s = String(x?.secret || '');
      const pub = b58.decode(a), key = b58.decode(s);
      return pub.length === 32 && key.length === 64 && key.slice(32).every((v, i) => v === pub[i]) ? { address: a, secret: s } : null;
    } catch { return null; }
  },
});

// ---------------------------------------------------------------- Tron (wallets imported from other Tron apps)
// w.tron = [{ address (T…), secret: the private key, 64 hex characters as TronLink exports it }], type 'tron'. The key
// must give the address. (Accounts of the phrase and Ethereum keys need no entry: they have their Tron key already.)
registerFamily('tron', {
  clean(x) {
    try {
      const a = String(x?.address || ''), s = String(x?.secret || '').toLowerCase().replace(/^0x/, '');
      return /^[0-9a-f]{64}$/.test(s) && keyOfPrivate(s).address === a ? { address: a, secret: s } : null;
    } catch { return null; }
  },
});
