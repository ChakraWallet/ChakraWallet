// Smart contracts (Contracts tab): load a contract (bytecode, verified ABI and sources, proxies, standards),
// read it, simulate calls, decode calldata / reverts / events. No UI here.
// ABIs come from Sourcify, the chain's Blockscout and (with a key) Etherscan; unverified contracts are rebuilt from
// the bytecode with WhatsABI (selectors + public signature databases). Only contract addresses leave the device.
import { Interface, AbiCoder, FunctionFragment, ErrorFragment, getAddress, isAddress, zeroPadValue, keccak256, toBeHex, dataSlice } from 'ethers';
import { whatsabi } from '@shazow/whatsabi';
import { rpc, multiCall, RpcError } from './rpc.js';
import { getJson } from './http.js';
import { toHex } from './chains.js';

const coder = AbiCoder.defaultAbiCoder();
const ZERO = /^0x0{40}$/i;

/** WhatsABI provider on our RPC client (fallback across the chain's endpoints). */
export function providerFor(chain) {
  const tag = (b) => (typeof b === 'number' || typeof b === 'bigint' ? toHex(b) : b || 'latest');
  return {
    getCode: (a, b) => rpc(chain, 'eth_getCode', [a, tag(b)]),
    getStorageAt: (a, slot, b) => rpc(chain, 'eth_getStorageAt', [a, typeof slot === 'number' || typeof slot === 'bigint' ? toHex(slot) : slot, tag(b)]),
    call: (tx, b) => rpc(chain, 'eth_call', [{ to: tx.to, data: tx.data }, tag(b)]),
    getAddress: async (name) => { throw new Error(`ENS not supported: ${name}`); },
  };
}

function abiLoader(chain, etherscanKey) {
  const L = whatsabi.loaders;
  const list = [new L.SourcifyABILoader({ chainId: chain.id })];
  if (chain.indexer?.type === 'blockscout') list.push(new L.BlockscoutABILoader({ baseURL: `${chain.indexer.url}/api` }));
  if (etherscanKey) list.push(new L.EtherscanV2ABILoader({ apiKey: etherscanKey, chainId: chain.id }));
  return new L.MultiABILoader(list);
}
const SOURCE_NAMES = { SourcifyABILoader: 'sourcify', BlockscoutABILoader: 'blockscout', EtherscanV2ABILoader: 'etherscan' };

// ------------------------------------------------------------ functions of a contract
/**
 * Normalised function list: { key, name, selector, signature, inputs, outputs, mutability, read, payable,
 * guessed (from bytecode + signature databases), unknown (selector only), fragment (ethers, null if unknown), from }.
 */
export function functionsOf(abi, { guessed = false, from = 'main' } = {}) {
  const out = [];
  for (const item of abi || []) {
    if (item.type !== 'function') continue;
    let fragment = null;
    if (item.name) {
      try {
        fragment = FunctionFragment.from({
          type: 'function', name: item.name, inputs: item.inputs || [], outputs: item.outputs || [],
          stateMutability: item.stateMutability || (item.payable ? 'payable' : item.constant ? 'view' : 'nonpayable'),
        });
      } catch { fragment = null; }
    }
    const selector = fragment ? fragment.selector : item.selector;
    if (!selector) continue;
    const mutability = fragment ? fragment.stateMutability : item.stateMutability || (item.payable ? 'payable' : 'nonpayable');
    out.push({
      key: fragment ? fragment.format('sighash') : selector, name: fragment ? fragment.name : null, selector,
      signature: fragment ? fragment.format('sighash') : null, inputs: fragment ? fragment.inputs : [], outputs: fragment ? fragment.outputs : [],
      mutability, read: mutability === 'view' || mutability === 'pure', payable: mutability === 'payable',
      guessed: guessed || !!item.sig, unknown: !fragment, fragment, alts: item.sigAlts || [], from,
    });
  }
  return out.sort((a, b) => (a.unknown - b.unknown) || String(a.name || a.selector).localeCompare(String(b.name || b.selector)));
}

/** Implementation functions first; the proxy's own ones (admin, upgrade) are added when their selector isn't there. */
function mergeFns(primary, secondary) {
  const seen = new Set(primary.map((f) => f.selector));
  return [...primary, ...secondary.filter((f) => !seen.has(f.selector))];
}

// ------------------------------------------------------------ load
async function autoloadOne(chain, address, provider, etherscanKey) {
  const base = { provider, abiLoader: abiLoader(chain, etherscanKey), loadContractResult: true, followProxies: false, onError: () => false };
  try {
    return await whatsabi.autoload(address, base);
  } catch {
    // a signature database is down: keep the selectors, without names
    return whatsabi.autoload(address, { ...base, signatureLookup: false });
  }
}

function describe(r) {
  const verified = !!r.abiLoadedFrom;
  const c = r.contractResult;
  return {
    verified,
    source: verified ? SOURCE_NAMES[r.abiLoadedFrom?.name] || 'other' : null,
    name: (verified && c?.name) || null,
    compiler: c?.compilerVersion || null, evmVersion: c?.evmVersion || null, runs: c?.runs ?? null,
    abi: r.abi, getSources: verified && c?.getSources ? () => c.getSources() : null,
    isFactory: !!r.isFactory,
  };
}

const cache = new Map(); // `${chainId}:${address}` -> loaded contract (this session)

/**
 * Everything about a contract:
 * { address, chainId, hasCode, codeSize, code, verified, source, name, compiler, evmVersion, runs, abi, fns, events, errors,
 *   proxy: { kind, implementation, impl: {verified, name, source, compiler...} } | null, standards: [...] }
 */
/** customAbi: an ABI the user gave for this address (used when the contract isn't verified). */
export async function loadContract(chain, address, { etherscanKey, fresh, customAbi } = {}) {
  address = getAddress(address);
  const key = `${chain.id}:${address}`;
  if (!fresh && cache.has(key)) return cache.get(key);
  const provider = providerFor(chain);
  const code = await provider.getCode(address);
  if (!code || code === '0x') return { address, chainId: chain.id, hasCode: false };
  // EIP-7702: an account that delegates its code to a contract
  if (/^0xef0100[0-9a-f]{40}$/i.test(code)) return { address, chainId: chain.id, hasCode: false, delegatedTo: getAddress('0x' + code.slice(8)) };
  const r = await autoloadOne(chain, address, provider, etherscanKey);
  const main = describe(r);
  let fns = functionsOf(r.abi, { guessed: !main.verified });
  let abi = main.verified ? r.abi : [];
  let proxy = null;
  for (const resolver of r.proxies || []) {
    const kind = resolver.name || 'Proxy';
    if (/diamond/i.test(kind)) { proxy = { kind, implementation: null, impl: null }; break; } // facets depend on the selector
    let implementation = null;
    try { implementation = await resolver.resolve(provider, address); } catch { /* not resolvable */ }
    if (!implementation || ZERO.test(implementation) || !isAddress(implementation)) continue;
    implementation = getAddress(implementation);
    const ir = await autoloadOne(chain, implementation, provider, etherscanKey).catch(() => null);
    const impl = ir ? describe(ir) : null;
    if (impl) {
      fns = mergeFns(functionsOf(ir.abi, { guessed: !impl.verified, from: 'impl' }), fns);
      if (impl.verified) abi = [...ir.abi, ...abi.filter((x) => x.type === 'function' && !ir.abi.some((y) => y.type === 'function' && y.name === x.name))];
    }
    proxy = { kind, implementation, impl };
    break;
  }
  let custom = false;
  if (customAbi?.length && !(main.verified || proxy?.impl?.verified)) {
    abi = customAbi; custom = true;
    fns = mergeFns(functionsOf(customAbi), fns.filter((f) => f.unknown));
  }
  const iface = abi.length ? safeInterface(abi) : null;
  const out = {
    address, chainId: chain.id, hasCode: true, code, codeSize: (code.length - 2) / 2,
    ...main, abi, fns, iface, custom,
    events: iface ? iface.fragments.filter((f) => f.type === 'event') : [],
    errors: iface ? iface.fragments.filter((f) => f.type === 'error') : [],
    constructorInputs: iface?.deploy?.inputs || [],
    proxy,
  };
  out.standards = await detectStandards(chain, address, fns).catch(() => []);
  if (out.standards.includes('erc20')) out.token = await tokenInfo(chain, address).catch(() => null);
  cache.set(key, out);
  return out;
}

export function safeInterface(abi) {
  try { return new Interface(abi); } catch { /* duplicate or broken entries: keep the valid ones */ }
  const ok = [];
  for (const x of abi) { try { new Interface([x]); ok.push(x); } catch { /* skip */ } }
  return new Interface(ok);
}

// ------------------------------------------------------------ standards
const ERC165 = new Interface(['function supportsInterface(bytes4) view returns (bool)']);
const IDS = { erc721: '0x80ac58cd', erc1155: '0xd9b67a26' };
const has = (fns, ...sels) => sels.every((s) => fns.some((f) => f.selector === s));

/** 'erc20' | 'erc721' | 'erc1155' | 'erc4626' | 'erc165' found on the contract. */
export async function detectStandards(chain, address, fns) {
  const out = [];
  const res = await multiCall(chain, [IDS.erc721, IDS.erc1155, '0x01ffc9a7', '0xffffffff'].map((id) => ({ to: address, data: ERC165.encodeFunctionData('supportsInterface', [id]) })));
  const yes = (r) => { try { return !!r && ERC165.decodeFunctionResult('supportsInterface', r)[0]; } catch { return false; } };
  if (yes(res[2]) && !yes(res[3])) {
    out.push('erc165');
    if (yes(res[0])) out.push('erc721');
    if (yes(res[1])) out.push('erc1155');
  }
  // ERC-20: totalSupply, balanceOf, transfer, allowance, approve (an ERC-721 shares balanceOf / approve, not transfer)
  if (!out.includes('erc721') && has(fns, '0x18160ddd', '0x70a08231', '0xa9059cbb', '0xdd62ed3e', '0x095ea7b3')) out.push('erc20');
  if (has(fns, '0x38d52e0f', '0xc6e6f592', '0x07a2d13a')) out.push('erc4626'); // asset, convertToShares, convertToAssets
  return out;
}

const T20 = new Interface(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
async function tokenInfo(chain, address) {
  const [n, s, d] = await multiCall(chain, ['name', 'symbol', 'decimals'].map((f) => ({ to: address, data: T20.encodeFunctionData(f) })));
  const dec = (f, r) => { try { return r ? T20.decodeFunctionResult(f, r)[0] : null; } catch { return null; } };
  const decimals = dec('decimals', d);
  return { name: dec('name', n), symbol: dec('symbol', s), decimals: decimals == null ? null : Number(decimals) };
}

// ------------------------------------------------------------ calls
/** Calldata of a function (known fragment) with already coerced arguments. */
export function encodeCall(fn, args) {
  if (fn.unknown) throw new Error('unknown function');
  return Interface.from([fn.fragment]).encodeFunctionData(fn.fragment, args);
}

export function decodeResult(fn, data) {
  if (!fn.fragment || !fn.fragment.outputs.length) return null;
  return Interface.from([fn.fragment]).decodeFunctionResult(fn.fragment, data);
}

/** Revert data out of an RPC error (nodes put it in different places). */
export function revertData(e) {
  const pick = (d) => (typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d) ? d : null);
  const d = e?.data;
  return pick(d) || pick(d?.data) || pick(d?.originalError?.data) || pick(e?.error?.data) || null;
}

const PANIC = { 0x00: 'generic', 0x01: 'assert', 0x11: 'overflow', 0x12: 'divZero', 0x21: 'enum', 0x22: 'storage', 0x31: 'popEmpty', 0x32: 'outOfBounds', 0x41: 'memory', 0x51: 'zeroFunction' };
let sigLookup = null;
const signatures = () => (sigLookup ??= whatsabi.loaders.defaultSignatureLookup);

/**
 * What a revert means: { kind: 'empty' | 'reason' | 'panic' | 'custom' | 'raw', message?, code?, panic?, name?, args?, signature?, data }.
 * Custom errors come from the ABI, then from the public signature databases.
 */
export async function decodeRevert(data, iface, { lookup = true } = {}) {
  if (!data || data === '0x') return { kind: 'empty', data: data || '0x' };
  const sel = data.slice(0, 10).toLowerCase();
  try {
    if (sel === '0x08c379a0') return { kind: 'reason', message: coder.decode(['string'], dataSlice(data, 4))[0], data };
    if (sel === '0x4e487b71') { const code = Number(coder.decode(['uint256'], dataSlice(data, 4))[0]); return { kind: 'panic', code, panic: PANIC[code] || 'generic', data }; }
  } catch { /* malformed: raw */ }
  if (iface) {
    try { const e = iface.parseError(data); if (e) return { kind: 'custom', name: e.name, signature: e.signature, args: e.args, inputs: e.fragment.inputs, data }; } catch { /* not in the ABI */ }
  }
  if (lookup && data.length >= 10) {
    const sigs = await signatures().loadFunctions(sel).catch(() => []);
    for (const s of sigs) {
      try {
        const f = ErrorFragment.from(`error ${s}`);
        const args = coder.decode(f.inputs, dataSlice(data, 4));
        return { kind: 'custom', name: f.name, signature: f.format('sighash'), args, inputs: f.inputs, data, guessed: true };
      } catch { /* try the next one */ }
    }
  }
  return { kind: 'raw', data };
}

/** eth_call as `from` (simulation of a write too): { ok, result } | { ok: false, revert, message }. */
export async function simulate(chain, { from, to, data, value, block = 'latest' }) {
  const tx = { to: to || undefined, data, ...(from ? { from } : {}), ...(value ? { value: toHex(value) } : {}) };
  try {
    return { ok: true, result: await rpc(chain, 'eth_call', [tx, block]) };
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    return { ok: false, revert: revertData(e), message: e.message };
  }
}

/** Every read function without arguments, in a few multicalls: Map key -> { ok, value | error }. */
export async function readOverview(chain, address, fns) {
  const list = fns.filter((f) => f.read && !f.unknown && f.inputs.length === 0).slice(0, 60);
  const res = await multiCall(chain, list.map((f) => ({ to: address, data: encodeCall(f, []) })));
  const out = new Map();
  list.forEach((f, i) => {
    if (res[i] == null) { out.set(f.key, { ok: false }); return; }
    try { out.set(f.key, { ok: true, value: decodeResult(f, res[i]), raw: res[i] }); } catch { out.set(f.key, { ok: true, raw: res[i] }); }
  });
  return { list, values: out };
}

// ------------------------------------------------------------ calldata decoder
/**
 * Decodes transaction input: with the contract's functions when given, else with the public signature databases.
 * -> { selector, name, signature, inputs, args, guessed } | { selector, unknown: true }
 */
export async function decodeCalldata(data, fns = []) {
  data = String(data || '').trim();
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) throw new Error('bad calldata');
  const selector = data.slice(0, 10).toLowerCase();
  const fn = fns.find((f) => f.selector === selector && !f.unknown);
  if (fn) {
    const args = Interface.from([fn.fragment]).decodeFunctionData(fn.fragment, data);
    return { selector, name: fn.name, signature: fn.signature, inputs: fn.inputs, args, guessed: false };
  }
  const sigs = await signatures().loadFunctions(selector).catch(() => []);
  for (const s of sigs) {
    try {
      const f = FunctionFragment.from(`function ${s}`);
      const args = coder.decode(f.inputs, dataSlice(data, 4));
      return { selector, name: f.name, signature: f.format('sighash'), inputs: f.inputs, args, guessed: true, alts: sigs.filter((x) => x !== s) };
    } catch { /* next */ }
  }
  return { selector, unknown: true };
}

// ------------------------------------------------------------ storage
export const SLOTS = {
  eip1967Implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  eip1967Admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  eip1967Beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
};

/** Normalises a slot typed by the user: decimal or hex number -> 32-byte hex. */
export function slotHex(input) {
  const s = String(input).trim();
  if (!s) throw new Error('empty slot');
  const n = /^0x[0-9a-fA-F]+$/.test(s) ? BigInt(s) : /^\d+$/.test(s) ? BigInt(s) : null;
  if (n == null || n < 0n || n >= 1n << 256n) throw new Error('bad slot');
  return toBeHex(n, 32);
}

export const readSlot = (chain, address, slot, block = 'latest') => rpc(chain, 'eth_getStorageAt', [address, slotHex(slot), block]);

/** Slot of mapping[key] at `base`: keccak256(abi.encode(key, base)). keyType: 'address' | 'uint256' | 'bytes32' | ... */
export function mappingSlot(keyType, key, base) {
  return keccak256(coder.encode([keyType, 'uint256'], [key, BigInt(slotHex(base))]));
}

/** Address stored in a slot word, or null. */
export const wordToAddress = (word) => (word && word.length === 66 && /^0x0{24}/i.test(word) && !/^0x0{64}$/i.test(word) ? getAddress(dataSlice(word, 12)) : null);
export const addressToWord = (a) => zeroPadValue(getAddress(a), 32);

// ------------------------------------------------------------ activity (events, transactions)
/** Recent events of the contract, newest first: [{ block, tx, index, topics, data, decoded? }]. */
export async function recentLogs(chain, address, iface, { limit = 40 } = {}) {
  let logs = null;
  if (chain.indexer?.type === 'blockscout') {
    const r = await getJson(`${chain.indexer.url}/api/v2/addresses/${address}/logs`, { label: 'Blockscout', timeout: 15000 }).catch(() => null);
    if (r?.items) logs = r.items.map((x) => ({ block: x.block_number, tx: x.transaction_hash || x.tx_hash, index: x.index, topics: (x.topics || []).filter(Boolean), data: x.data || '0x', remote: x.decoded }));
  }
  if (!logs) {
    const head = Number(BigInt(await rpc(chain, 'eth_blockNumber', [])));
    let span = 2000;
    for (;;) {
      try {
        const raw = await rpc(chain, 'eth_getLogs', [{ address, fromBlock: toHex(Math.max(0, head - span)), toBlock: 'latest' }]);
        logs = raw.map((x) => ({ block: Number(BigInt(x.blockNumber)), tx: x.transactionHash, index: Number(BigInt(x.logIndex)), topics: x.topics, data: x.data })).reverse();
        break;
      } catch (e) {
        if (span <= 100) throw e;
        span = Math.floor(span / 4); // the node limits the range
      }
    }
  }
  return logs.slice(0, limit).map((l) => {
    let decoded = null;
    if (iface) { try { const p = iface.parseLog({ topics: l.topics, data: l.data }); if (p) decoded = { name: p.name, signature: p.signature, args: p.args, inputs: p.fragment.inputs }; } catch { /* not in the ABI */ } }
    if (!decoded && l.remote?.method_call) decoded = { name: l.remote.method_call.split('(')[0], signature: l.remote.method_call, params: l.remote.parameters || [] };
    return { ...l, decoded };
  });
}

/** Recent transactions to the contract (Blockscout chains only), newest first. */
export async function recentTxs(chain, address, { limit = 25 } = {}) {
  if (chain.indexer?.type !== 'blockscout') return null;
  const r = await getJson(`${chain.indexer.url}/api/v2/addresses/${address}/transactions`, { label: 'Blockscout', timeout: 15000 });
  return (r?.items || []).slice(0, limit).map((x) => ({
    hash: x.hash, from: x.from?.hash, to: x.to?.hash, method: x.method || x.decoded_input?.method_call?.split('(')[0] || null,
    time: x.timestamp ? Date.parse(x.timestamp) : null, ok: x.status !== 'error' && x.result !== 'error', value: x.value || '0', block: x.block_number ?? x.block,
  }));
}
