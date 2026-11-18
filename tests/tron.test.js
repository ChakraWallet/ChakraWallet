// Tron: addresses, keys (TronLink's path), signatures and the transaction wire format, checked against vectors made
// with TronWeb (tests/fixtures/tron-vectors.json) and against real mainnet transactions (tron-mainnet-txs.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAddress, decodeAddress, toBase58, toHexAddress, toEvmAddress, fromEvmAddress, keyOfPrivate, hdKey, signRawData, recoverSigner,
  fromHex, toHex, messageHashV2, signHash, txIdOf,
} from '../src/shared/tron/core.js';
import { encodeRawData, decodeRawData, RESOURCE, blockRef, encodeMessage, decodeMessage } from '../src/shared/tron/proto.js';
import V from './fixtures/tron-vectors.json';
import MAINNET from './fixtures/tron-mainnet-txs.json';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PK = 'da146374a75310b9666e834ee4ad0866d6f4035967bfc76217c5a495fff9f0d0';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

test('addresses: checksum, prefix, conversions', () => {
  assert.ok(isAddress(USDT));
  assert.ok(isAddress('TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY'));
  assert.ok(!isAddress('TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZZ')); // checksum
  assert.ok(!isAddress('0x928c9af0651632157ef27a2cf17ca72c575a4d21'));
  assert.ok(!isAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')); // a Solana address: 32 bytes
  assert.ok(!isAddress(''));
  assert.equal(toHexAddress('TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY'), '41928c9af0651632157ef27a2cf17ca72c575a4d21');
  assert.equal(toBase58('41928c9af0651632157ef27a2cf17ca72c575a4d21'), 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY');
  assert.equal(toBase58('0x928c9af0651632157ef27a2cf17ca72c575a4d21'), 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY');
  assert.equal(toEvmAddress('TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY'), '0x928c9af0651632157ef27a2cf17ca72c575a4d21');
  assert.equal(fromEvmAddress('0x928C9AF0651632157EF27A2CF17CA72C575A4D21'), 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY');
  assert.equal(decodeAddress('nope'), null);
});

test('keys: private keys and the recovery phrase on TronLink\'s path (TronWeb vectors)', () => {
  assert.equal(keyOfPrivate(PK).address, 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY');
  assert.equal(keyOfPrivate(`0x${PK}`).address, 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY');
  assert.throws(() => keyOfPrivate('1234'));
  assert.throws(() => keyOfPrivate('0'.repeat(64)));
  assert.equal(hdKey(PHRASE, 0).address, 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  assert.equal(toHex(hdKey(PHRASE, 0).privateKey), 'b5a4cea271ff424d7c31dc12a3e43e401df7a40d7412a15750f3f0b6b5449a28');
  assert.equal(hdKey(PHRASE, 1).address, 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK');
  assert.equal(hdKey(PHRASE, 2).address, 'TYJPRrdB5APNeRs4R7fYZSwW3TcrTKw2gx');
});

test('signatures: the same as TronWeb, and the signer recovered', () => {
  const { privateKey } = keyOfPrivate(PK);
  const c0 = V.cases[0];
  const { txID, signature } = signRawData(c0.raw_data_hex, privateKey);
  assert.equal(txID, V.signature.txID);
  assert.equal(signature, V.signature.signature.toLowerCase()); // deterministic (RFC 6979), v = 27 + recovery
  assert.equal(recoverSigner(fromHex(txID), signature), 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY');
  // real mainnet transactions (v written as 0 / 1): the signer is the owner in the transaction
  for (const tx of MAINNET) {
    assert.equal(txIdOf(fromHex(tx.raw_data_hex)), tx.txID);
    assert.equal(recoverSigner(fromHex(tx.txID), tx.signature), toBase58(tx.owner_hex));
  }
});

test('messages: signMessageV2 as TronLink / TronWeb', () => {
  const { privateKey } = keyOfPrivate(PK);
  const sig = signHash(messageHashV2('hello chakra'), privateKey);
  assert.equal(`0x${sig}`, '0xbeea94fc6b93e7e82629f338006e616e1bc0691f90eb700e189c2e9983269ab65eeb7d0450011433ba222a349577b75dc8c2161f0f2269a7749e60a9d8d20ca51b');
});

// the TronWeb vectors use hex addresses and resource names: in the app's form (T…, numbers)
const ADDR = /^(owner_address|to_address|receiver_address|contract_address|vote_address)$/;
function appForm(v) {
  if (Array.isArray(v)) return v.map(appForm);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k,
    ADDR.test(k) ? toBase58(x) : k === 'resource' ? RESOURCE[x] : k === 'asset_name' ? new TextDecoder().decode(fromHex(x)) : appForm(x)]));
}

test('transactions: every contract encoded byte for byte as TronWeb, and decoded back', () => {
  const ref = { ref_block_bytes: V.base.ref_block_bytes, ref_block_hash: V.base.ref_block_hash };
  for (const c of V.cases) {
    assert.ok(!c.err, `${c.type}: ${c.err}`);
    const parameter = appForm(c.value);
    const hex = encodeRawData({
      contract: { type: c.type, parameter }, ref, expiration: V.base.expiration, timestamp: V.base.timestamp,
      fee_limit: c.extra.fee_limit || 0, data: c.extra.data ? new TextDecoder().decode(fromHex(c.extra.data)) : '',
    });
    assert.equal(hex, c.raw_data_hex, c.type);
    const d = decodeRawData(hex);
    assert.equal(d.txID, c.txID);
    assert.equal(d.contracts.length, 1);
    assert.equal(d.contracts[0].type, c.type);
    for (const [k, v] of Object.entries(parameter)) {
      const got = d.contracts[0].parameter[k];
      if (k === 'data') assert.equal(got, v);
      else assert.deepEqual(got ?? (k === 'resource' ? 0 : got), v, `${c.type}.${k}`);
    }
  }
});

test('transactions: real mainnet USDT transfers decoded', () => {
  for (const tx of MAINNET) {
    const d = decodeRawData(tx.raw_data_hex);
    assert.equal(d.txID, tx.txID);
    const c = d.contracts[0];
    assert.equal(c.type, 'TriggerSmartContract');
    assert.equal(c.parameter.owner_address, toBase58(tx.owner_hex));
    assert.equal(c.parameter.contract_address, USDT);
    assert.equal(c.parameter.data, tx.data);
    assert.equal(d.raw.fee_limit, tx.fee_limit);
    assert.equal(d.raw.expiration, tx.expiration);
  }
});

test('transactions: unknown contracts and the permission update are recognised, not read', () => {
  const perm = encodeMessage('AccountPermissionUpdateContract', {
    owner_address: 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY',
    owner: { type: 0, permission_name: 'owner', threshold: 1, keys: [{ address: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', weight: 1 }] },
  });
  const back = decodeMessage('AccountPermissionUpdateContract', perm);
  assert.equal(back.owner.keys[0].address, 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  const raw = toHex(encodeMessage('raw', {
    ref_block_bytes: 'aabb', ref_block_hash: '0011223344556677', expiration: 1, timestamp: 1,
    contract: [{ type: 46, parameter: { type_url: 'type.googleapis.com/protocol.AccountPermissionUpdateContract', value: perm } },
      { type: 6, parameter: { type_url: 'type.googleapis.com/protocol.AssetIssueContract', value: Uint8Array.of(10, 1, 65) } }],
  }));
  const d = decodeRawData(raw);
  assert.equal(d.contracts[0].type, 'AccountPermissionUpdateContract');
  assert.equal(d.contracts[1].type, 'AssetIssueContract');
  assert.equal(d.contracts[1].parameter._raw, '0a0141');
});

test('block reference (TAPOS)', () => {
  const r = blockRef({ blockID: '0000000004d3f0b2b696cdb94aea2633c2f1a8a7c9f0c3b6e3c2a1a0b9c8d7e6', block_header: { raw_data: { number: 80998578, timestamp: 1 } } });
  assert.equal(r.ref_block_bytes, 'f0b2');
  assert.equal(r.ref_block_hash, 'b696cdb94aea2633');
});

// ------------------------------------------------------------ costs (java-tron's rules)
import { costOf, feeLimitFor, bandwidthBytes } from '../src/shared/tron/fees.js';

const PARAMS = { getTransactionFee: 1000, getEnergyFee: 100, getCreateAccountFee: 100000, getCreateNewAccountFeeInSystemContract: 1000000, getMemoFee: 1000000, getMaxFeeLimit: 15000000000 };
const resOf = ({ energy = 0, free = 600, staked = 0 } = {}) => ({
  energy: { available: energy }, bandwidth: { free: { available: free }, staked: { available: staked }, available: free + staked },
});

test('costs: energy, bandwidth, activation and memo', () => {
  // USDT with no energy: free bandwidth covers the bytes, the energy is burnt
  let c = costOf({ res: resOf(), params: PARAMS, bytes: 345, energy: 64285 });
  assert.equal(c.bandwidth.from, 'free');
  assert.equal(c.energy.burn, 6_428_500n);
  assert.equal(c.total, 6_428_500n);
  // the day's free bandwidth used up: the bytes are burnt too
  c = costOf({ res: resOf({ free: 100 }), params: PARAMS, bytes: 345, energy: 64285 });
  assert.equal(c.bandwidth.burn, 345_000n);
  assert.equal(c.total, 6_773_500n);
  // enough energy (staked or rented): only what's missing is burnt
  c = costOf({ res: resOf({ energy: 50000 }), params: PARAMS, bytes: 345, energy: 64285 });
  assert.equal(c.energy.covered, 50000);
  assert.equal(c.energy.burn, 1_428_500n);
  // TRX to an address never used: the free bandwidth doesn't pay an activation
  c = costOf({ res: resOf(), params: PARAMS, bytes: 268, createsAccount: true });
  assert.equal(c.bandwidth.burn, 100_000n);
  assert.equal(c.activation, 1_000_000n);
  assert.equal(c.total, 1_100_000n);
  c = costOf({ res: resOf({ staked: 5000 }), params: PARAMS, bytes: 268, createsAccount: true });
  assert.equal(c.bandwidth.from, 'staked');
  assert.equal(c.total, 1_000_000n);
  // a note costs a fixed fee
  c = costOf({ res: resOf(), params: PARAMS, bytes: 280, memo: true });
  assert.equal(c.total, 1_000_000n);
});

test('costs: fee limit with room, between 15 TRX and the network maximum; bytes of a transaction', () => {
  assert.equal(feeLimitFor(0, resOf({ energy: 0 }), PARAMS), 15_000_000);
  assert.equal(feeLimitFor(64285, resOf({ energy: 100000 }), PARAMS), 15_000_000);
  const l = feeLimitFor(130000, resOf(), PARAMS);
  assert.ok(l > 130000 * 100 * 1.3 && l < 40_000_000, String(l));
  assert.equal(feeLimitFor(1e12, resOf(), PARAMS), 15_000_000_000);
  assert.equal(bandwidthBytes('00'.repeat(100)), 100 + 134);
});

// ------------------------------------------------------------ resources: stake, votes, delegation, permissions, rent
import { stakeOverview, permissionsOf, voteApr, coverage, stakeTx, unstakeTx, delegateTx, voteTx, claimTx, withdrawTx, cancelUnstakeTx } from '../src/shared/tron/resources.js';
import { rentQuote, rentTx, returnTx } from '../src/shared/tron/rent.js';
import { TRON_CHAINS } from '../src/shared/tron/api.js';

const ME_T = 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY', OTHER_T = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';

test('stake overview: own stake, delegated part, unstaking, votes (as the node answers)', () => {
  const now = Date.now();
  const acc = {
    address: ME_T, frozenV2: [{ amount: 7_000_000 }, { type: 'ENERGY', amount: 49_000_000 }, { type: 'TRON_POWER' }],
    delegated_frozenV2_balance_for_bandwidth: 2_000_000, account_resource: { delegated_frozenV2_balance_for_energy: 33_000_000 },
    unfrozenV2: [{ unfreeze_amount: 5_000_000, unfreeze_expire_time: now - 1000 }, { type: 'ENERGY', unfreeze_amount: 3_000_000, unfreeze_expire_time: now + 86400e3 }],
    votes: [{ vote_address: OTHER_T, vote_count: 60 }],
  };
  const s = stakeOverview(acc);
  assert.equal(s.energy, 49_000_000n); assert.equal(s.bandwidth, 7_000_000n);
  assert.equal(s.delegatedEnergy, 33_000_000n); assert.equal(s.delegatedBandwidth, 2_000_000n);
  assert.equal(s.withdrawable, 5_000_000n, 'only the ready one');
  assert.deepEqual(s.unstaking.map((u) => u.resource), ['BANDWIDTH', 'ENERGY']);
  assert.deepEqual(s.power, { total: 91, used: 60 });
  assert.deepEqual(stakeOverview({}).power, { total: 0, used: 0 });
});

test('permissions: a new account is safe; other keys are an alarm', () => {
  assert.equal(permissionsOf({ address: ME_T }, ME_T).safe, true);
  const safe = { owner_permission: { keys: [{ address: ME_T, weight: 1 }] }, active_permission: [{ keys: [{ address: ME_T, weight: 1 }] }] };
  assert.equal(permissionsOf(safe, ME_T).safe, true);
  const taken = { owner_permission: { keys: [{ address: OTHER_T, weight: 1 }] }, active_permission: [{ keys: [{ address: ME_T, weight: 1 }, { address: OTHER_T, weight: 1 }] }] };
  const p = permissionsOf(taken, ME_T);
  assert.equal(p.safe, false); assert.deepEqual(p.others, [OTHER_T]);
});

test('votes: yearly return of a Super Representative', () => {
  const list = Array.from({ length: 130 }, (_, i) => ({ address: `SR${i}`, votes: 1e9 - i * 1e6, rank: i + 1 }));
  const params = { getWitnessPayPerBlock: 8e6, getWitness127PayPerBlock: 128e6 };
  const top = voteApr(list[0], list, params, 0), kept = voteApr(list[0], list, params, 20);
  assert.ok(top > 0.01 && top < 0.2, String(top));
  assert.ok(Math.abs(kept - top * 0.8) < 1e-12, 'brokerage kept by the SR');
  assert.ok(voteApr(list[30], list, params, 0) < voteApr(list[20], list, params, 0), 'no block rewards outside the top 27');
  assert.equal(voteApr(list[129], list, params, 0), 0, 'outside the 127: nothing');
  assert.equal(voteApr(list[0], list, params, null), null);
});

test('coverage of the usual operations', () => {
  assert.deepEqual(coverage({ energy: { available: 140_000 }, bandwidth: { available: 600 } }), { tokens: 2, sends: 2 }); // TRX sends: 268 bytes
});

test('resource operations encode as Tron transactions', () => {
  const ref = { ref_block_bytes: 'aabb', ref_block_hash: '0011223344556677' };
  const enc = (c) => decodeRawData(encodeRawData({ contract: c, ref, expiration: 1, timestamp: 1 })).contracts[0];
  assert.deepEqual(enc(stakeTx(ME_T, 5_000_000n, 'ENERGY')).parameter, { owner_address: ME_T, frozen_balance: 5_000_000, resource: 1 });
  assert.deepEqual(enc(unstakeTx(ME_T, 1_000_000n, 'BANDWIDTH')).parameter, { owner_address: ME_T, unfreeze_balance: 1_000_000 });
  const d = enc(delegateTx(ME_T, OTHER_T, 2_000_000n, 'ENERGY', 3)).parameter;
  assert.equal(d.lock, true); assert.equal(d.lock_period, 3 * 28800, 'in blocks of 3 s');
  assert.equal(enc(delegateTx(ME_T, OTHER_T, 2_000_000n, 'ENERGY')).parameter.lock, undefined);
  assert.deepEqual(enc(voteTx(ME_T, [{ address: OTHER_T, count: 10 }, { address: ME_T, count: 0 }])).parameter.votes, [{ vote_address: OTHER_T, vote_count: 10 }]);
  for (const c of [claimTx(ME_T), withdrawTx(ME_T), cancelUnstakeTx(ME_T)]) assert.equal(enc(c).parameter.owner_address, ME_T);
  const market = 'TU2MJ5Veik1LRAgjeSzEdvmDYx7mefJZvd';
  const r = enc(rentTx(ME_T, ME_T, 6_732_000_000n, 46_240_000n, market));
  assert.equal(r.parameter.contract_address, market); assert.equal(r.parameter.call_value, 46_240_000);
  assert.equal(r.parameter.data.slice(0, 8), 'fd8527a1', 'rentResource(address,uint256,uint256)');
  assert.equal(enc(returnTx(ME_T, ME_T, 1n, market)).parameter.data.slice(0, 8), 'af6f4896', 'returnResource(address,uint256,uint256)');
});

test('rent quote: deposit, fee and the cost of burning instead (the market\'s rate read on chain)', async () => {
  const real = globalThis.fetch;
  const RATE = 5_592_965_890n; // per sun per second, x1e18 (read on mainnet)
  globalThis.fetch = async () => new Response(JSON.stringify({ result: { result: true }, constant_result: [RATE.toString(16).padStart(64, '0')], transaction: { ret: [{}] } }), { status: 200 });
  try {
    const terms = { stable: 5_061_665_456n, minFee: 20_000_000n, feeRatio: 80_000_000_000_000n, threshold: 0n, paused: false };
    const q = await rentQuote(TRON_CHAINS[-195], { terms, energyPerDay: 65000, days: 7, energyPerTrx: 9.6561, energyFee: 100 });
    assert.equal(q.amount, 6_732_000_000n);
    assert.equal(q.rentPerDay, (q.amount * RATE * 86400n + 10n ** 18n - 1n) / 10n ** 18n);
    assert.equal(q.fee, 20_000_000n, 'the minimum fee');
    assert.ok(q.prepay > q.rent + q.fee, 'a day more of deposit');
    assert.equal(q.burn, 45_500_000n, '65,000 energy a day for 7 days at 100 sun');
  } finally { globalThis.fetch = real; }
});

// ------------------------------------------------------------ swaps (SUN.io's Smart Router)
import { versionLens, swapCalldata } from '../src/ui/tron/swap.js';
import { Interface } from 'ethers';

test('swap: the router\'s versionLen and calldata (checked by simulating real routes on mainnet)', () => {
  assert.deepEqual(versionLens(['v1']), [2]);
  assert.deepEqual(versionLens(['v2', 'v3']), [2, 1]); // TRX > WTRX > USDT
  assert.deepEqual(versionLens(['v2', 'v3', 'v3']), [2, 1, 1]); // TRX > WTRX > USD1 > USDT
  const route = { tokens: ['T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', 'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'], poolVersions: ['v2', 'v3'], poolFees: ['0', '500', '0'] };
  const data = swapCalldata(route, { amountIn: 1000_000000n, minOut: 300_000000n, to: ME_T, deadline: 1795000000 });
  const I = new Interface(['function swapExactInput(address[] path, string[] poolVersion, uint256[] versionLen, uint24[] fees, (uint256 amountIn, uint256 amountOutMin, address to, uint256 deadline) data)']);
  const d = I.decodeFunctionData('swapExactInput', `0x${data}`);
  assert.equal(d.path[0], '0x0000000000000000000000000000000000000000', 'TRX: the zero address');
  assert.deepEqual(d.versionLen.map(Number), [2, 1]);
  assert.deepEqual(d.fees.map(Number), [0, 500, 0]);
  assert.equal(d.data.to.toLowerCase(), '0x928c9af0651632157ef27a2cf17ca72c575a4d21', 'the account itself (the router requires to == sender)');
});

// ------------------------------------------------------------ vanity addresses
import { toTronPattern, tronMatches, tronDifficulty, tronExample } from '../src/shared/tron/vanity.js';
import { scanWith, randomScalar } from '../src/ui/vanitySearch.js';
import { encodeAddress } from '../src/shared/tron/core.js';

test('vanity: patterns, matching after the T, difficulty, and keys found by the scanner', () => {
  assert.equal(toTronPattern('Ci l0').pattern, 'CiLo', 'look-alikes for 0 and l');
  assert.equal(toTronPattern('Ciao l0l').pattern, 'CiaoL', 'at most 5 characters');
  assert.ok(tronMatches('TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH', 'ly', 'start'));
  assert.ok(!tronMatches('TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH', 'ly', 'start', false));
  assert.ok(tronMatches('TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH', 'ZYH', 'end', false));
  assert.equal(tronDifficulty('a', 'start', false), Infinity, 'never a lower case letter after the T');
  assert.ok(Math.abs(tronDifficulty('A', 'start', false) - 23.3) < 1);
  assert.ok(Math.abs(tronDifficulty('ab', 'end', false) - 58 * 58) < 1e-6);
  const ex = tronExample('Cia', 'start');
  assert.equal(ex.length, 34); assert.ok(ex.startsWith('TCia'));
  // the scanner finds a key whose Tron address ends as asked, and the key really gives it
  const bytes = new Uint8Array(21); bytes[0] = 0x41;
  let addr = '';
  const r = scanWith((h) => { bytes.set(h.subarray(12, 32), 1); addr = encodeAddress(bytes); return tronMatches(addr, 'z', 'end'); }, randomScalar(4096), 4096);
  assert.ok(r.found, 'one in ~29 matches');
  assert.equal(keyOfPrivate(r.found.privateKey).address, addr);
});

// ------------------------------------------------------------ contracts (Contracts tab)
import { standardAbi, tronAbi, deployContract, argOf, showValue } from '../src/shared/tron/contracts.js';

test('contracts: deployment encoded as TronWeb, ABI both ways, T… addresses in and out of calls', () => {
  const abi = [
    { type: 'constructor', inputs: [{ name: 'supply', type: 'uint256' }], stateMutability: 'nonpayable' },
    { type: 'function', name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
    { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256' }], anonymous: false },
  ];
  const c = deployContract(ME_T, { bytecode: '6080604052348015600f57600080fd5b50', abi, name: 'Token' });
  const hex = encodeRawData({ contract: c, ref: { ref_block_bytes: '73d8', ref_block_hash: 'b696cdb94aea2633' }, expiration: 1795004291000, timestamp: 1795004231554, fee_limit: 1000000000 });
  assert.equal(hex, V.deploy);
  // as the node gives it back (getcontract, visible): names of the enums
  const back = standardAbi({ entrys: [{ type: 'Function', name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'View' }, { type: 'Function', name: 'pay', inputs: [{ name: 'id', type: 'trcToken' }], stateMutability: 'Payable' }] });
  assert.deepEqual(back[0], { type: 'function', name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' });
  assert.equal(back[1].inputs[0].type, 'uint256', 'a TRC-10 id is a number');
  assert.equal(tronAbi(abi).entrys[1].stateMutability, 2);
  assert.equal(argOf({ type: 'address', name: 'a' }, ME_T), '0x928c9af0651632157ef27a2cf17ca72c575a4d21');
  assert.deepEqual(argOf({ type: 'address[]', name: 'a' }, JSON.stringify([ME_T])), ['0x928c9af0651632157ef27a2cf17ca72c575a4d21']);
  assert.equal(argOf({ type: 'uint256', name: 'n' }, '42'), 42n);
  assert.throws(() => argOf({ type: 'address', name: 'a' }, 'nope'));
  assert.equal(showValue({ type: 'address' }, '0x928c9af0651632157ef27a2cf17ca72c575a4d21'), ME_T);
  assert.equal(showValue({ type: 'uint256' }, 5n), '5');
});

import { trc10Id } from '../src/shared/tron/history.js';
test('history: a TRC-10 id written as itself (all digits, which look like hex) or as hex text', () => {
  assert.equal(trc10Id('1007445'), '1007445'); // Nile's faucet token: odd length, not hex
  assert.equal(trc10Id('1002000'), '1002000');
  assert.equal(trc10Id('31303032303030'), '1002000');
  assert.equal(trc10Id(''), '');
});

test('resources: addresses the node writes in hex (votes, permissions) come out as T…', () => {
  const me = 'TPnb4UsuY8G8nwJpsGhYEQDZqWCRkjMGkx';
  const sr = '418440ffd578f7a5abf3537b5f46a6980d382db581'; // listwitnesses answers like this even with visible: true
  const o = stakeOverview({ votes: [{ vote_address: sr, vote_count: 10 }] });
  assert.equal(o.votes[0].address, 'TN2W4cc7a4dsYyTLiLMWa9m7jVpdLjGvYs');
  assert.equal(voteTx(me, o.votes).parameter.votes[0].vote_address, 'TN2W4cc7a4dsYyTLiLMWa9m7jVpdLjGvYs');
  const p = permissionsOf({ owner_permission: { keys: [{ address: '41978f996d6a86def67071d6e4c8e481f19aa4543e' }] }, active_permission: [] }, me);
  assert.equal(p.safe, true);
});
