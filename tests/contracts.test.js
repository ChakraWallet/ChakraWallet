import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import solc from 'solc';
import { Interface, AbiCoder, keccak256 } from 'ethers';
import { functionsOf, decodeRevert, decodeCalldata, slotHex, mappingSlot, wordToAddress, addressToWord, encodeCall, decodeResult, loadContract, revertData, safeInterface } from '../src/shared/contracts.js';
import { RpcError } from '../src/shared/rpc.js';

const coder = AbiCoder.defaultAbiCoder();
const ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' },
  { type: 'error', name: 'InsufficientBalance', inputs: [{ name: 'needed', type: 'uint256' }] },
];

test('functions of an ABI, guessed and unknown entries', () => {
  const fns = functionsOf(ABI);
  assert.deepEqual(fns.map((f) => f.name), ['balanceOf', 'deposit', 'transfer']);
  assert.equal(fns[0].read, true);
  assert.equal(fns[1].payable, true);
  assert.equal(fns[2].selector, '0xa9059cbb');
  const g = functionsOf([{ type: 'function', selector: '0x12345678', stateMutability: 'nonpayable' }, { type: 'function', selector: '0xa9059cbb', sig: 'transfer(address,uint256)', name: 'transfer', inputs: [{ type: 'address', name: '' }, { type: 'uint256', name: '' }] }], { guessed: true });
  assert.equal(g[0].name, 'transfer');
  assert.equal(g[0].guessed, true);
  assert.equal(g[1].unknown, true);
  const data = encodeCall(fns[2], ['0x' + '11'.repeat(20), 5n]);
  assert.equal(data.slice(0, 10), '0xa9059cbb');
  assert.equal(decodeResult(fns[0], coder.encode(['uint256'], [7n]))[0], 7n);
  assert.ok(safeInterface([...ABI, { type: 'function', name: 'bad', inputs: [{ type: 'nope' }] }]).getFunction('transfer'));
});

test('revert reasons', async () => {
  const iface = new Interface(ABI);
  assert.deepEqual(await decodeRevert('0x', iface), { kind: 'empty', data: '0x' });
  const reason = '0x08c379a0' + coder.encode(['string'], ['nope']).slice(2);
  assert.equal((await decodeRevert(reason, iface)).message, 'nope');
  const panic = '0x4e487b71' + coder.encode(['uint256'], [0x11]).slice(2);
  assert.equal((await decodeRevert(panic, iface)).panic, 'overflow');
  const custom = iface.encodeErrorResult('InsufficientBalance', [10n]);
  const c = await decodeRevert(custom, iface);
  assert.equal(c.name, 'InsufficientBalance');
  assert.equal(c.args[0], 10n);
  assert.equal((await decodeRevert('0xdeadbeef', null, { lookup: false })).kind, 'raw');
  assert.equal(revertData(new RpcError('execution reverted', 3, reason)), reason);
  assert.equal(revertData(new RpcError('x', 3, { data: reason })), reason);
});

test('calldata with the contract ABI', async () => {
  const fns = functionsOf(ABI);
  const d = await decodeCalldata(new Interface(ABI).encodeFunctionData('transfer', ['0x' + '22'.repeat(20), 9n]), fns);
  assert.equal(d.name, 'transfer');
  assert.equal(d.args[1], 9n);
  await assert.rejects(decodeCalldata('0x12', fns));
});

test('storage helpers', () => {
  assert.equal(slotHex('0'), '0x' + '00'.repeat(32));
  assert.equal(slotHex('0x10'), '0x' + '00'.repeat(31) + '10');
  assert.throws(() => slotHex('x'));
  const a = '0x' + '33'.repeat(20);
  assert.equal(mappingSlot('address', a, '0'), keccak256(coder.encode(['address', 'uint256'], [a, 0n])));
  assert.equal(wordToAddress(addressToWord(a)).toLowerCase(), a);
  assert.equal(wordToAddress('0x' + '00'.repeat(32)), null);
});

// -------- loadContract on a mocked chain: an address without code, then a real (unverified) contract
test('loadContract: EOA and unverified bytecode', async () => {
  const src = 'pragma solidity ^0.8.20; contract C { uint256 public value; function setValue(uint256 v) external { value = v; } }';
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'C.sol': { content: src } }, settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } } })));
  const runtime = '0x' + out.contracts['C.sol'].C.evm.deployedBytecode.object;
  const C = '0x' + 'cc'.repeat(20), E = '0x' + 'ee'.repeat(20);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://rpc.test')) {
      const { id, method, params } = JSON.parse(opts.body);
      let result = '0x';
      if (method === 'eth_getCode') result = params[0].toLowerCase() === C ? runtime : '0x';
      else if (method === 'eth_getStorageAt') result = '0x' + '00'.repeat(32);
      else if (method === 'eth_call') return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
    }
    return new Response('{}', { status: 404 }); // Sourcify, Blockscout, signature databases: nothing
  };
  try {
    const chain = { id: 31337, name: 'Test', rpc: ['https://rpc.test'] };
    assert.deepEqual(await loadContract(chain, E), { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', chainId: 31337, hasCode: false });
    const c = await loadContract(chain, C);
    assert.equal(c.hasCode, true);
    assert.equal(c.verified, false);
    assert.equal(c.codeSize, (runtime.length - 2) / 2);
    const sels = c.fns.map((f) => f.selector).sort();
    assert.deepEqual(sels, ['0x3fa4f245', '0x55241077']); // value(), setValue(uint256)
    assert.deepEqual(c.standards, []);
    assert.equal(c.proxy, null);
  } finally { globalThis.fetch = realFetch; }
});
