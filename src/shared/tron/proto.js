// Tron transactions in their wire format (protobuf): built here for what the app sends, and decoded from the bytes for
// everything that is signed (the app's own transactions and the dapps' ones), so the approval screens show what the
// signature really authorises, never a description given by a node or a dapp. Only the messages of a transaction and
// the contracts Chakra knows; any other contract is decoded as its type with its raw bytes.
// Field numbers: java-tron's protocol (Tron.proto, contract/*.proto).
import { encodeAddress, toHexAddress, fromHex, toHex, concat, txIdOf, utf8 } from './core.js';

// ------------------------------------------------------------ wire format
const WT = { VARINT: 0, I64: 1, LEN: 2, I32: 5 };

function varint(n) {
  let v = BigInt(n);
  if (v < 0n) v &= (1n << 64n) - 1n; // two's complement, as int64 is written
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Uint8Array.from(out);
}
const tag = (field, wt) => varint((field << 3) | wt);

function readVarint(buf, pos) {
  let v = 0n, shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('protobuf: truncated varint');
    const b = buf[pos++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [v, pos];
    shift += 7n;
    if (shift > 70n) throw new Error('protobuf: varint too long');
  }
}
/** Raw fields of a message: [{ field, wt, value (bigint | Uint8Array) }], in order. */
export function readFields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let key; [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n), wt = Number(key & 7n);
    if (wt === WT.VARINT) { let v; [v, pos] = readVarint(buf, pos); out.push({ field, wt, value: v }); }
    else if (wt === WT.LEN) {
      let len; [len, pos] = readVarint(buf, pos);
      const end = pos + Number(len);
      if (end > buf.length) throw new Error('protobuf: truncated field');
      out.push({ field, wt, value: buf.slice(pos, end) }); pos = end;
    } else if (wt === WT.I64) { out.push({ field, wt, value: buf.slice(pos, pos + 8) }); pos += 8; }
    else if (wt === WT.I32) { out.push({ field, wt, value: buf.slice(pos, pos + 4) }); pos += 4; }
    else throw new Error(`protobuf: wire type ${wt}`);
  }
  return out;
}

// ------------------------------------------------------------ schemas
// [field number, name, type]; types: int (int64/int32/enum, a number or a bigint), bool, bytes, string, address (bytes
// written as T…), or the name of a message; `[]` after the type: repeated. Fields are written in this order, as java-tron
// does, and left out when empty or zero (proto3).
const S = {
  raw: [[1, 'ref_block_bytes', 'bytes'], [3, 'ref_block_num', 'int'], [4, 'ref_block_hash', 'bytes'], [8, 'expiration', 'int'],
    [9, 'auths', 'bytes[]'], [10, 'data', 'bytes'], [11, 'contract', 'Contract[]'], [12, 'scripts', 'bytes'], [14, 'timestamp', 'int'], [18, 'fee_limit', 'int']],
  SignedTransaction: [[1, 'raw_data', 'bytes'], [2, 'signature', 'bytes[]']], // Transaction: what is broadcast
  Contract: [[1, 'type', 'int'], [2, 'parameter', 'Any'], [3, 'provider', 'bytes'], [4, 'ContractName', 'bytes'], [5, 'Permission_id', 'int']],
  Any: [[1, 'type_url', 'string'], [2, 'value', 'bytes']],
  TransferContract: [[1, 'owner_address', 'address'], [2, 'to_address', 'address'], [3, 'amount', 'int']],
  TransferAssetContract: [[1, 'asset_name', 'string'], [2, 'owner_address', 'address'], [3, 'to_address', 'address'], [4, 'amount', 'int']],
  TriggerSmartContract: [[1, 'owner_address', 'address'], [2, 'contract_address', 'address'], [3, 'call_value', 'int'], [4, 'data', 'bytes'],
    [5, 'call_token_value', 'int'], [6, 'token_id', 'int']],
  CreateSmartContract: [[1, 'owner_address', 'address'], [2, 'new_contract', 'SmartContract'], [3, 'call_token_value', 'int'], [4, 'token_id', 'int']],
  SmartContract: [[1, 'origin_address', 'address'], [2, 'contract_address', 'address'], [3, 'abi', 'ABI'], [4, 'bytecode', 'bytes'],
    [5, 'call_value', 'int'], [6, 'consume_user_resource_percent', 'int'], [7, 'name', 'string'], [8, 'origin_energy_limit', 'int'],
    [9, 'code_hash', 'bytes'], [10, 'trx_hash', 'bytes'], [11, 'version', 'int']],
  ABI: [[1, 'entrys', 'Entry[]']],
  Entry: [[1, 'anonymous', 'bool'], [2, 'constant', 'bool'], [3, 'name', 'string'], [4, 'inputs', 'Param[]'], [5, 'outputs', 'Param[]'],
    [6, 'type', 'int'], [7, 'payable', 'bool'], [8, 'stateMutability', 'int']],
  Param: [[1, 'indexed', 'bool'], [2, 'name', 'string'], [3, 'type', 'string']],
  FreezeBalanceV2Contract: [[1, 'owner_address', 'address'], [2, 'frozen_balance', 'int'], [3, 'resource', 'int']],
  UnfreezeBalanceV2Contract: [[1, 'owner_address', 'address'], [2, 'unfreeze_balance', 'int'], [3, 'resource', 'int']],
  WithdrawExpireUnfreezeContract: [[1, 'owner_address', 'address']],
  CancelAllUnfreezeV2Contract: [[1, 'owner_address', 'address']],
  DelegateResourceContract: [[1, 'owner_address', 'address'], [2, 'resource', 'int'], [3, 'balance', 'int'], [4, 'receiver_address', 'address'],
    [5, 'lock', 'bool'], [6, 'lock_period', 'int']],
  UnDelegateResourceContract: [[1, 'owner_address', 'address'], [2, 'resource', 'int'], [3, 'balance', 'int'], [4, 'receiver_address', 'address']],
  VoteWitnessContract: [[1, 'owner_address', 'address'], [2, 'votes', 'Vote[]'], [3, 'support', 'bool']],
  Vote: [[1, 'vote_address', 'address'], [2, 'vote_count', 'int']],
  WithdrawBalanceContract: [[1, 'owner_address', 'address']],
  AccountUpdateContract: [[1, 'account_name', 'string'], [2, 'owner_address', 'address']],
  AccountCreateContract: [[1, 'owner_address', 'address'], [2, 'account_address', 'address'], [3, 'type', 'int']],
  // only to recognise it (always refused): who would take control of the account
  AccountPermissionUpdateContract: [[1, 'owner_address', 'address'], [2, 'owner', 'Permission'], [3, 'witness', 'Permission'], [4, 'actives', 'Permission[]']],
  Permission: [[1, 'type', 'int'], [2, 'id', 'int'], [3, 'permission_name', 'string'], [4, 'threshold', 'int'], [5, 'parent_id', 'int'],
    [6, 'operations', 'bytes'], [7, 'keys', 'Key[]']],
  Key: [[1, 'address', 'address'], [2, 'weight', 'int']],
  FreezeBalanceContract: [[1, 'owner_address', 'address'], [2, 'frozen_balance', 'int'], [3, 'frozen_duration', 'int'], [10, 'resource', 'int'], [15, 'receiver_address', 'address']],
  UnfreezeBalanceContract: [[1, 'owner_address', 'address'], [10, 'resource', 'int'], [15, 'receiver_address', 'address']],
  UpdateSettingContract: [[1, 'owner_address', 'address'], [2, 'contract_address', 'address'], [3, 'consume_user_resource_percent', 'int']],
  UpdateEnergyLimitContract: [[1, 'owner_address', 'address'], [2, 'contract_address', 'address'], [3, 'origin_energy_limit', 'int']],
  ClearABIContract: [[1, 'owner_address', 'address'], [2, 'contract_address', 'address']],
};

/** Contract types (Transaction.Contract.ContractType) -> name; the parameter's message has the same name. */
export const CONTRACT_TYPES = {
  0: 'AccountCreateContract', 1: 'TransferContract', 2: 'TransferAssetContract', 3: 'VoteAssetContract', 4: 'VoteWitnessContract',
  5: 'WitnessCreateContract', 6: 'AssetIssueContract', 8: 'WitnessUpdateContract', 9: 'ParticipateAssetIssueContract',
  10: 'AccountUpdateContract', 11: 'FreezeBalanceContract', 12: 'UnfreezeBalanceContract', 13: 'WithdrawBalanceContract',
  14: 'UnfreezeAssetContract', 15: 'UpdateAssetContract', 16: 'ProposalCreateContract', 17: 'ProposalApproveContract',
  18: 'ProposalDeleteContract', 19: 'SetAccountIdContract', 20: 'CustomContract', 30: 'CreateSmartContract', 31: 'TriggerSmartContract',
  32: 'GetContract', 33: 'UpdateSettingContract', 41: 'ExchangeCreateContract', 42: 'ExchangeInjectContract', 43: 'ExchangeWithdrawContract',
  44: 'ExchangeTransactionContract', 45: 'UpdateEnergyLimitContract', 46: 'AccountPermissionUpdateContract', 48: 'ClearABIContract',
  49: 'UpdateBrokerageContract', 51: 'ShieldedTransferContract', 52: 'MarketSellAssetContract', 53: 'MarketCancelOrderContract',
  54: 'FreezeBalanceV2Contract', 55: 'UnfreezeBalanceV2Contract', 56: 'WithdrawExpireUnfreezeContract', 57: 'DelegateResourceContract',
  58: 'UnDelegateResourceContract', 59: 'CancelAllUnfreezeV2Contract',
};
export const TYPE_OF = Object.fromEntries(Object.entries(CONTRACT_TYPES).map(([k, v]) => [v, Number(k)]));
/** Resources (ResourceCode). */
export const RESOURCE = { BANDWIDTH: 0, ENERGY: 1, TRON_POWER: 2 };
export const RESOURCE_NAME = { 0: 'BANDWIDTH', 1: 'ENERGY', 2: 'TRON_POWER' };

// ------------------------------------------------------------ encode / decode
const isEmpty = (v) => v == null || v === '' || v === false || v === 0 || v === 0n || (v instanceof Uint8Array && !v.length) || (Array.isArray(v) && !v.length);

function encodeValue(type, v) {
  if (type === 'int') return [WT.VARINT, varint(v)];
  if (type === 'bool') return [WT.VARINT, varint(v ? 1 : 0)];
  if (type === 'string') return [WT.LEN, typeof v === 'string' ? utf8(v) : v];
  if (type === 'bytes') return [WT.LEN, typeof v === 'string' ? fromHex(v) : v];
  if (type === 'address') return [WT.LEN, fromHex(toHexAddress(v))];
  return [WT.LEN, encodeMessage(type, v)];
}

/** A message (plain object, names as in the schema) -> bytes. */
export function encodeMessage(name, obj) {
  const schema = S[name];
  if (!schema) throw new Error(`protobuf: unknown message ${name}`);
  const parts = [];
  for (const [field, key, type] of schema) {
    const rep = type.endsWith('[]');
    const base = rep ? type.slice(0, -2) : type;
    const v = obj?.[key];
    if (isEmpty(v)) continue;
    for (const item of rep ? v : [v]) {
      const [wt, bytes] = encodeValue(base, item);
      parts.push(tag(field, wt), ...(wt === WT.LEN ? [varint(bytes.length), bytes] : [bytes]));
    }
  }
  return concat(parts);
}

function decodeValue(type, f) {
  if (type === 'int') { const n = f.value; return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n; }
  if (type === 'bool') return f.value !== 0n;
  if (type === 'string') return new TextDecoder().decode(f.value);
  if (type === 'bytes') return toHex(f.value);
  if (type === 'address') { try { return encodeAddress(f.value); } catch { return `0x${toHex(f.value)}`; } }
  return decodeMessage(type, f.value);
}

/** Bytes -> plain object of a known message (unknown fields kept in `_unknown`). Bytes as hex, addresses as T…. */
export function decodeMessage(name, buf) {
  const schema = S[name];
  if (!schema) throw new Error(`protobuf: unknown message ${name}`);
  const byField = new Map(schema.map(([field, key, type]) => [field, { key, type }]));
  const out = {};
  for (const f of readFields(buf)) {
    const s = byField.get(f.field);
    if (!s) { (out._unknown ||= []).push(f.field); continue; }
    const rep = s.type.endsWith('[]');
    const base = rep ? s.type.slice(0, -2) : s.type;
    const v = decodeValue(base, f);
    if (rep) (out[s.key] ||= []).push(v); else out[s.key] = v;
  }
  return out;
}

const TYPE_URL = (name) => `type.googleapis.com/protocol.${name}`;

/**
 * A transaction's raw_data bytes (hex) -> { txID, raw: { ref_block_bytes, ..., fee_limit }, contracts: [{ type (name),
 * typeId, parameter (decoded, or { _raw: hex } for contracts Chakra doesn't read), permissionId }] }.
 */
export function decodeRawData(rawDataHex) {
  const bytes = fromHex(rawDataHex);
  const raw = decodeMessage('raw', bytes);
  const contracts = (raw.contract || []).map((c) => {
    const typeId = c.type ?? 0;
    const type = CONTRACT_TYPES[typeId] || `Contract${typeId}`;
    const value = c.parameter?.value ? fromHex(c.parameter.value) : new Uint8Array();
    let parameter;
    try { parameter = S[type] ? decodeMessage(type, value) : { _raw: toHex(value) }; } catch { parameter = { _raw: toHex(value), _bad: true }; }
    return { type, typeId, typeUrl: c.parameter?.type_url || '', parameter, permissionId: c.Permission_id || 0 };
  });
  return { txID: txIdOf(bytes), raw, contracts };
}

/**
 * raw_data of a transaction -> hex. tx: { contract: { type (name), parameter (object) }, ref: { ref_block_bytes,
 * ref_block_hash } (from the block it points to), expiration, timestamp, fee_limit?, data? (memo text) }.
 */
export function encodeRawData({ contract, ref, expiration, timestamp, fee_limit = 0, data = '' }) {
  const value = encodeMessage(contract.type, contract.parameter);
  return toHex(encodeMessage('raw', {
    ref_block_bytes: ref.ref_block_bytes, ref_block_hash: ref.ref_block_hash, expiration, data: data ? utf8(data) : null,
    contract: [{ type: TYPE_OF[contract.type], parameter: { type_url: TYPE_URL(contract.type), value }, Permission_id: contract.permissionId || 0 }],
    timestamp, fee_limit,
  }));
}

/**
 * The reference a transaction carries to a recent block (TAPOS): bytes 6-8 of the block number and bytes 8-16 of the
 * block id. block: { block_header.raw_data.number, blockID } as /wallet/getnowblock gives it.
 */
export function blockRef(block) {
  const num = BigInt(block.block_header.raw_data.number);
  const numBytes = fromHex(num.toString(16).padStart(16, '0'));
  return { ref_block_bytes: toHex(numBytes.slice(6, 8)), ref_block_hash: block.blockID.slice(16, 32), time: block.block_header.raw_data.timestamp };
}
