// What a WalletConnect session gives a dapp: namespaces (CAIP-25) of chains, methods and events, and the accounts on
// them (docs/specs/clients/sign/namespaces.md). The dapp proposes required and optional namespaces; Chakra grants the
// chains it has (switched on), never fewer methods and events than the required ones, and the chosen account's
// addresses. A required chain Chakra doesn't have makes the proposal fail (code 5100), as the spec asks.

// Chakra's ids of the networks of other families (shared/solana/api.js, shared/tron/api.js)
const SOL_MAINNET = -501, SOL_DEVNET = -502, TRON_MAINNET = -195, TRON_NILE = -196;

export const EVM_METHODS = [
  'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v4', 'eth_signTypedData_v3', 'eth_sendTransaction',
  'eth_accounts', 'eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_watchAsset',
];
export const EVM_EVENTS = ['chainChanged', 'accountsChanged'];
/** Solana's chains: the genesis hash (its first 32 characters), and the ids WalletConnect used before. */
export const SOLANA_CHAINS = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': SOL_MAINNET, 'solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ': SOL_MAINNET,
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': SOL_DEVNET, 'solana:8E9rvCKLFQia2Y35HvivUyiBAefHaWdo': SOL_DEVNET,
};
export const SOLANA_METHODS = ['solana_signTransaction', 'solana_signAllTransactions', 'solana_signAndSendTransaction', 'solana_signMessage', 'solana_getAccounts', 'solana_requestAccounts'];
/** Tron's chains: the low 4 bytes of the genesis block id, as TronLink's eth_chainId. */
export const TRON_CHAINS = { 'tron:0x2b6653dc': TRON_MAINNET, 'tron:0xcd8690dc': TRON_NILE };
export const TRON_METHODS = ['tron_signTransaction', 'tron_signMessage'];

const NS = /^[-a-z0-9]{3,8}$/;
const CAIP2 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/;
const uniq = (a) => [...new Set(a)];
const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);

/** Chakra's id of a CAIP-2 chain (eip155:8453 -> 8453, the Solana and Tron ids -> theirs), or null. */
export function chainIdOf(caip) {
  const m = CAIP2.exec(String(caip || ''));
  if (!m) return null;
  if (m[1] === 'eip155') return /^\d{1,15}$/.test(m[2]) && Number(m[2]) > 0 ? Number(m[2]) : null;
  return SOLANA_CHAINS[caip] ?? TRON_CHAINS[caip] ?? null;
}

/** A proposal's namespaces, by namespace: { [ns]: { chains, methods, events } } (keys like "eip155:1" folded in). */
function fold(spaces) {
  const out = {};
  if (!spaces || typeof spaces !== 'object') return out;
  for (const [key, v] of Object.entries(spaces)) {
    const m = CAIP2.exec(key);
    const ns = m ? m[1] : key;
    if (!NS.test(ns)) throw Object.assign(new Error(`Bad namespace ${key}`), { code: 5104 });
    const chains = m ? [key] : strings(v?.chains);
    if (chains.some((c) => !CAIP2.test(c) || !c.startsWith(`${ns}:`))) throw Object.assign(new Error(`Bad chains in namespace ${key}`), { code: 5100 });
    const o = (out[ns] ||= { chains: [], methods: [], events: [] });
    o.chains = uniq([...o.chains, ...chains]);
    o.methods = uniq([...o.methods, ...strings(v?.methods)]);
    o.events = uniq([...o.events, ...strings(v?.events)]);
  }
  return out;
}

/**
 * What Chakra can grant for a proposal. supported: { [ns]: { chains: [caip], methods, events } } (Chakra's chains
 * switched on, its methods). -> { namespaces: { [ns]: { chains, methods, events } }, required: [ns], missing: [caip],
 * unsupported: [caip] (optional chains left out) } or throws { code, message } when the proposal can't be granted.
 */
export function planSession({ requiredNamespaces, optionalNamespaces } = {}, supported) {
  const req = fold(requiredNamespaces), opt = fold(optionalNamespaces);
  const required = Object.keys(req);
  if (required.some((ns) => !req[ns].chains.length)) throw Object.assign(new Error('Chains must not be empty'), { code: 5100 });
  // nothing asked: any chain of Ethereum's family
  const asked = Object.keys(req).length || Object.keys(opt).length ? [...new Set([...Object.keys(req), ...Object.keys(opt)])] : ['eip155'];
  const namespaces = {}, missing = [], unsupported = [];
  for (const ns of asked) {
    const s = supported[ns], r = req[ns], o = opt[ns];
    const wanted = r || o ? uniq([...(r?.chains || []), ...(o?.chains || [])]) : s?.chains || [];
    const chains = wanted.filter((c) => s?.chains.includes(c));
    for (const c of wanted) if (!chains.includes(c)) (r?.chains.includes(c) ? missing : unsupported).push(c);
    if (!chains.length) continue;
    namespaces[ns] = { chains, methods: uniq([...s.methods, ...(r?.methods || [])]), events: uniq([...s.events, ...(r?.events || [])]) };
  }
  if (missing.length) throw Object.assign(new Error(`Chakra doesn't have these networks: ${missing.join(', ')}`), { code: 5100, missing });
  if (!Object.keys(namespaces).length) throw Object.assign(new Error('None of the requested networks is in Chakra'), { code: 5100, missing: unsupported });
  return { namespaces, required, missing, unsupported };
}

/**
 * The session's namespaces for the chosen account. addresses: { eip155?, solana?, tron? } (its address on each family,
 * null when it has none). -> { namespaces, lacking: [required ns with no address] }.
 */
export function sessionNamespaces(plan, addresses) {
  const namespaces = {}, lacking = [];
  for (const [ns, v] of Object.entries(plan.namespaces)) {
    const a = addresses[ns];
    if (!a) { if (plan.required.includes(ns)) lacking.push(ns); continue; }
    namespaces[ns] = { chains: v.chains, accounts: v.chains.map((c) => `${c}:${a}`), methods: v.methods, events: v.events };
  }
  return { namespaces, lacking };
}
