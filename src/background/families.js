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

// ---------------------------------------------------------------- Bitcoin (wallets imported from other Bitcoin apps)
// w.bitcoin = [{ address (its first receive address on mainnet: the account's id), secret, scheme, index }], type
// 'bitcoin'. scheme 'wif': a private key (WIF, compressed: K…/L…, c… on test networks); 'bip39': a phrase of another
// app, `index` its account; 'electrum': an Electrum seed. Accounts of the phrase and Ethereum keys need no entry.
// Format checks only (the extension has no Bitcoin library): the app derives the addresses from the secret.
registerFamily('bitcoin', {
  clean(x) {
    const scheme = String(x?.scheme || ''), address = String(x?.address || '').trim();
    const secret = scheme === 'wif' ? String(x?.secret || '').trim() : String(x?.secret || '').trim().toLowerCase().split(/\s+/).join(' ');
    const index = Number(x?.index || 0);
    if (!/^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address)) return null;
    if (!Number.isInteger(index) || index < 0 || index > 1000) return null;
    if (scheme === 'wif' && !/^[KLc][1-9A-HJ-NP-Za-km-z]{51}$/.test(secret)) return null;
    if ((scheme === 'bip39' || scheme === 'electrum') && !/^[a-z]+( [a-z]+){11,23}$/.test(secret)) return null;
    if (!['wif', 'bip39', 'electrum'].includes(scheme)) return null;
    return { address, secret, scheme, index };
  },
});
