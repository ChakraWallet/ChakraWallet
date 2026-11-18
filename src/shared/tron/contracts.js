// Tron contracts (Contracts tab): a contract read from the network with the ABI it was deployed with (Tron keeps it on
// chain), its functions called (reads) or sent (writes), and new contracts deployed from the Solidity studio. The TVM
// runs Solidity like the EVM; what differs is around it: addresses are T… (the same 20 bytes inside the calls), a
// deployment is a CreateSmartContract with the ABI and the energy settings, and its cost is energy.
import { Interface, ParamType } from 'ethers';
import { tronApi } from './api.js';
import { toBase58, toEvmAddress, isAddress } from './core.js';

const lc = (s) => String(s || '').toLowerCase();
const MUT = { 1: 'pure', 2: 'view', 3: 'nonpayable', 4: 'payable' };
const TYPE = { 1: 'constructor', 2: 'function', 3: 'event', 4: 'fallback', 5: 'receive', 6: 'error' };
const typeName = (t) => (t === 'trcToken' ? 'uint256' : t); // a TRC-10 id: a number

/** Tron's ABI (getcontract: { entrys }) -> a standard JSON ABI. */
export function standardAbi(abi) {
  const list = Array.isArray(abi) ? abi : abi?.entrys || [];
  return list.map((e) => {
    const type = lc(typeof e.type === 'number' ? TYPE[e.type] : e.type) || 'function';
    const mut = lc(typeof e.stateMutability === 'number' ? MUT[e.stateMutability] : e.stateMutability) || (e.constant ? 'view' : e.payable ? 'payable' : 'nonpayable');
    const params = (xs) => (xs || []).map((p) => ({ name: p.name || '', type: typeName(p.type), ...(p.indexed ? { indexed: true } : {}) }));
    return { type, name: e.name, inputs: params(e.inputs), ...(type === 'function' ? { outputs: params(e.outputs), stateMutability: mut } : {}), ...(type === 'event' ? { anonymous: !!e.anonymous } : {}), ...(type === 'constructor' ? { stateMutability: mut } : {}) };
  }).filter((e) => ['function', 'event', 'constructor', 'error', 'fallback', 'receive'].includes(e.type));
}

/** A standard JSON ABI -> Tron's ABI message for a deployment (proto.js 'ABI'). */
export function tronAbi(abi) {
  const T = { constructor: 1, function: 2, event: 3, fallback: 4, receive: 5, error: 6 };
  const M = { pure: 1, view: 2, nonpayable: 3, payable: 4 };
  const param = (p) => ({ indexed: !!p.indexed, name: p.name || '', type: p.type === 'tuple' || p.type.startsWith('tuple[') ? ParamType.from(p).format('sighash') : p.type });
  return {
    entrys: (abi || []).filter((e) => T[e.type]).map((e) => ({
      anonymous: !!e.anonymous, constant: e.stateMutability === 'view' || e.stateMutability === 'pure', name: e.name || '', inputs: (e.inputs || []).map(param),
      outputs: (e.outputs || []).map(param), type: T[e.type], payable: e.stateMutability === 'payable', stateMutability: M[e.stateMutability] || 0,
    })),
  };
}

/**
 * A contract on Tron: { address, exists, hasCode, name, abi (standard JSON), iface, reads, writes, owner,
 * userPercent (energy the caller pays, %), energyLimit (owner's energy per call), codeSize } or { exists: false }.
 */
export async function loadTronContract(chain, address, { customAbi = null } = {}) {
  const j = await tronApi(chain, '/wallet/getcontract', { value: address });
  if (!j || !j.contract_address) return { address, exists: false, hasCode: false };
  const abi = customAbi || standardAbi(j.abi);
  let iface = null;
  try { iface = new Interface(abi); } catch { iface = new Interface([]); }
  const fns = iface.fragments.filter((f) => f.type === 'function');
  return {
    address, exists: true, hasCode: true, name: j.name || null, abi, iface, abiOnChain: !!(j.abi?.entrys?.length), custom: !!customAbi,
    reads: fns.filter((f) => f.stateMutability === 'view' || f.stateMutability === 'pure'),
    writes: fns.filter((f) => f.stateMutability !== 'view' && f.stateMutability !== 'pure'),
    owner: j.origin_address ? toBase58(j.origin_address) : null, userPercent: j.consume_user_resource_percent ?? 100,
    energyLimit: Number(j.origin_energy_limit || 0), codeSize: (String(j.bytecode || '').length / 2) | 0,
  };
}

// ------------------------------------------------------------ arguments and results
/** A value typed by the user for a parameter -> the value ethers encodes (addresses: T… or 0x, given as 0x). */
export function argOf(param, text) {
  const p = ParamType.from(param);
  const conv = (pt, v) => {
    if (pt.baseType === 'array') return (Array.isArray(v) ? v : []).map((x) => conv(pt.arrayChildren, x));
    if (pt.baseType === 'tuple') return pt.components.map((c, i) => conv(c, Array.isArray(v) ? v[i] : v?.[c.name]));
    if (pt.baseType === 'address') {
      const s = String(v ?? '').trim();
      if (isAddress(s)) return toEvmAddress(s);
      if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s;
      throw Object.assign(new Error('bad address'), { param: pt.name });
    }
    if (pt.baseType === 'bool') return v === true || String(v).trim().toLowerCase() === 'true';
    if (/^u?int/.test(pt.baseType)) { const s = String(v ?? '').trim(); if (!/^-?\d+$/.test(s)) throw Object.assign(new Error('bad number'), { param: pt.name }); return BigInt(s); }
    return v;
  };
  const raw = String(text ?? '').trim();
  const v = p.baseType === 'array' || p.baseType === 'tuple' ? JSON.parse(raw || '[]') : raw;
  return conv(p, v);
}

/** A decoded result -> plain values for the screen (addresses as T…, numbers as text). */
export function showValue(param, v) {
  const p = ParamType.from(param);
  const conv = (pt, x) => {
    if (pt.baseType === 'array') return Array.from(x || []).map((y) => conv(pt.arrayChildren, y));
    if (pt.baseType === 'tuple') return Object.fromEntries(pt.components.map((c, i) => [c.name || String(i), conv(c, x?.[i])]));
    if (pt.baseType === 'address') return toBase58(x) || String(x);
    if (typeof x === 'bigint') return x.toString();
    return x;
  };
  return conv(p, v);
}

// ------------------------------------------------------------ deployment
/**
 * The CreateSmartContract of a compiled contract: bytecode with the constructor's arguments, its ABI (so explorers and
 * this app read it later), the caller paying all the energy of its calls (100%) and the owner's cap for when it shares.
 */
export function deployContract(owner, { bytecode, abi, name, callValue = 0n, userPercent = 100, energyLimit = 10_000_000 }) {
  return {
    type: 'CreateSmartContract',
    parameter: {
      owner_address: owner,
      new_contract: {
        origin_address: owner, abi: tronAbi(abi), bytecode: String(bytecode).replace(/^0x/, ''), call_value: BigInt(callValue),
        consume_user_resource_percent: userPercent, name: String(name || 'Contract').slice(0, 32), origin_energy_limit: energyLimit,
      },
    },
  };
}

/**
 * Energy a deployment takes, estimated (the network can't simulate one): storing the code (200 a byte, as on the EVM),
 * running the constructor, and a margin.
 */
export const deployEnergy = (runtimeBytes, initBytes) => Math.ceil(200 * runtimeBytes + 60 * initBytes + 120_000);
