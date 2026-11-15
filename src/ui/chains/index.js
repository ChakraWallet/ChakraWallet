// Chain drivers: one per family of networks (evm, ton, ...). The wallet screens (home, token details, history,
// receive, send, swap, bridge, accounts) are written once against this interface and never import a network's code;
// a new family (e.g. Solana, Tron) is one more driver. See docs/adding-a-chain.md and src/ui/chains/driver.d.md.
//
// The EVM driver ships everywhere (src/ui/chains/evm.js); others register from their platform module
// (TON: src/mobile/tonPlugin.js, Android app only), so the browser extension never bundles them.
import { useEffect, useState } from 'preact/hooks';

const drivers = new Map();

/** Adds a family's driver (its `kind` is the `kind` of its networks in src/shared/chains.js; EVM networks have none). */
export function registerDriver(driver) {
  for (const k of REQUIRED) if (typeof driver[k] !== 'function') throw new Error(`chain driver "${driver.kind}": ${k}() missing`);
  drivers.set(driver.kind, driver);
}
export const REQUIRED = ['resolveAddresses', 'validateAddress', 'parseQr', 'paymentLink', 'loadPortfolio', 'loadHistory', 'prepareSend', 'confirmSend'];

/** The family of a network: its `kind`, 'evm' when it has none. */
export const familyOf = (chain) => chain?.kind || 'evm';
export const driverFor = (chain) => drivers.get(familyOf(chain)) || drivers.get('evm');
export const driverOf = (kind) => drivers.get(kind) || null;
export const allDrivers = () => [...drivers.values()];

/**
 * The family an account belongs to: accounts from a recovery phrase or an Ethereum key are 'evm' (and have an address
 * on every family that derives one from the phrase); an account imported into one family only has that family as type.
 */
export const accountFamily = (a) => (a?.type && a.type !== 'evm' && drivers.has(a.type) ? a.type : 'evm');
/** Accounts that can be used on EVM networks (dapps, Predictions, Contracts). */
export const isEvmAccount = (a) => accountFamily(a) === 'evm';

/** What a driver supports (missing = false): see driver.d.md. */
export const has = (chain, feature) => !!driverFor(chain).features?.[feature];

// ---------------------------------------------------------------- addresses of the accounts on a network
const resolved = new Map(); // `${chainId}|${accounts signature}` -> Promise<{ [account address]: { address, raw } | null }>

/**
 * Addresses of the given accounts on a network: { [account address]: { address (as shown), raw (as the network's APIs
 * want it) } | null (no key for this network) }. Cached per network and set of accounts.
 */
export function resolveAddresses(chain, accounts) {
  const key = `${chain.id}|${accounts.map((a) => `${a.address}:${a.type || ''}`).join()}`;
  if (!resolved.has(key)) resolved.set(key, Promise.resolve(driverFor(chain).resolveAddresses(chain, accounts)).catch((e) => { resolved.delete(key); throw e; }));
  return resolved.get(key);
}
/** Forget the cached addresses (accounts added, removed, imported). */
export const forgetAddresses = () => resolved.clear();

/** Hook: resolveAddresses for a list of accounts; null while loading. */
export function useAccountAddresses(chain, accounts) {
  const sig = `${chain?.id}|${accounts.map((a) => `${a.address}:${a.type || ''}`).join()}`;
  const sync = driverFor(chain).resolveAddressesSync?.(chain, accounts) || null; // EVM: known at once
  const [map, setMap] = useState(sync);
  useEffect(() => {
    if (sync) { setMap(sync); return undefined; }
    let alive = true;
    setMap(null);
    resolveAddresses(chain, accounts).then((m) => alive && setMap(m)).catch(() => alive && setMap({}));
    return () => { alive = false; };
  }, [sig]);
  return sync || map;
}

// ---------------------------------------------------------------- bridges
/** Networks the bridge screen offers: every driver's bridge networks (EVM: its bridge networks; TON: TON). */
export function bridgeNetworks() {
  const seen = new Set(), out = [];
  for (const d of drivers.values()) for (const c of d.bridge?.chains() || []) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
  return out;
}
/** The bridge that moves funds between two networks (a driver's `bridge`), or null when none does. */
export const bridgeFor = (from, to) => [...drivers.values()].map((d) => d.bridge).find((b) => b?.supports(from, to)) || null;
