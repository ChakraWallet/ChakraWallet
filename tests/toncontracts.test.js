import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, beginCell, Cell, loadMessage } from '@ton/core';
import {
  kindOf, walletVersionOf, interpret, summarizeTrace, walletNet, exitKey, rawAddress, showAddress, sameAddress, emulateMessages, GETTERS, actionFee,
} from '../src/shared/ton/contracts.js';
import { buildOnchainContent, toB64 } from '../src/shared/ton/cells.js';
import { walletContract } from '../src/shared/ton/core.js';
import { keyPairFromSeed } from '@ton/crypto';

const A = Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs');

test('contract kind and wallet version from TonAPI interfaces', () => {
  assert.equal(kindOf(['jetton_master']), 'jetton_master');
  assert.equal(kindOf(['jetton_wallet_v2']), 'jetton_wallet');
  assert.equal(kindOf(['nft_collection', 'nft_item']), 'nft_collection');
  assert.equal(kindOf(['teleitem']), 'nft_item');
  assert.equal(kindOf(['nft_sale_v2']), 'nft_sale');
  assert.equal(kindOf(['wallet_v5r1', 'wallets.WalletV5r1']), 'wallet');
  assert.equal(kindOf(['stonfi_pool_v2']), 'dex');
  assert.equal(kindOf([]), null);
  assert.equal(walletVersionOf(['wallet_v4r2']), 'v4r2');
  assert.ok(GETTERS.get_jetton_data.out.length === 5);
});

test('addresses: raw form for storage, bounceable for contracts, non-bounceable for wallets', () => {
  const raw = A.toRawString();
  assert.equal(rawAddress(A.toString({ bounceable: false })), raw);
  assert.equal(rawAddress('garbage'), null);
  assert.ok(showAddress(raw).startsWith('EQ'));
  assert.ok(showAddress(raw, { wallet: true }).startsWith('UQ'));
  assert.ok(showAddress(raw, { testnet: true }).startsWith('kQ'));
  assert.ok(sameAddress(raw, A.toString()));
});

test('results read with the type of the standard get methods', () => {
  assert.deepEqual(interpret({ kind: 'num', value: -1n }, 'bool'), { t: 'bool', v: true });
  assert.deepEqual(interpret({ kind: 'num', value: 1500n }, 'amount', { decimals: 3, symbol: 'X' }), { t: 'amount', v: 1500n, decimals: 3, symbol: 'X' });
  assert.equal(interpret({ kind: 'num', value: 1700000000n }, 'time').v, 1700000000000);
  assert.equal(interpret({ kind: 'num', value: 255n }, 'hex').v.length, 64);
  assert.deepEqual(interpret({ kind: 'num', value: 5n }), { t: 'int', v: 5n });
  const addr = interpret({ kind: 'slice', cell: beginCell().storeAddress(A).endCell() });
  assert.equal(addr.t, 'address');
  assert.ok(addr.v.equals(A));
  assert.equal(interpret({ kind: 'cell', cell: beginCell().storeAddress(null).endCell() }, 'address').v, null);
  const content = interpret({ kind: 'cell', cell: buildOnchainContent({ name: 'N', symbol: 'S' }) }, 'content');
  assert.deepEqual(content, { t: 'content', v: { onchain: { name: 'N', symbol: 'S' } } });
  const code = beginCell().storeUint(1, 8).endCell();
  assert.equal(interpret({ kind: 'cell', cell: code }, 'code').hash, code.hash().toString('hex'));
  assert.equal(interpret({ kind: 'cell', cell: beginCell().storeStringTail('hello').endCell() }).t, 'text');
  assert.equal(interpret({ kind: 'tuple', items: [{ kind: 'num', value: 1n }] }).items[0].v, 1n);
  assert.deepEqual(interpret({ kind: 'null' }), { t: 'null' });
});

test('exit codes with a description', () => {
  assert.equal(exitKey(65535), '65535');
  assert.equal(exitKey(-14), 'm14');
  assert.equal(exitKey(130), '130');
  assert.equal(exitKey(73), null);
});

const W = '0:' + 'aa'.repeat(32), C = '0:' + 'bb'.repeat(32), J = '0:' + 'cc'.repeat(32);
const tx = (account, { exit = 0, success = true, skipped = false, reason, aborted = false, action = true, bounced = false, value = '0', fees = '0', op }) => ({
  account: account.toUpperCase(), total_fees: fees,
  description: { aborted, compute_ph: skipped ? { skipped: true, reason } : { skipped: false, success, exit_code: exit }, ...(action == null ? {} : { action: { success: action, result_code: action ? 0 : 37 } }) },
  in_msg: { value, bounced, opcode: op },
});

test('trace from TON Center: success, bounce, failure, deposit to an empty address', () => {
  const ok = summarizeTrace({
    trace_info: { trace_state: 'complete', pending_messages: 0 },
    trace: { tx_hash: 'a', children: [{ tx_hash: 'b', children: [{ tx_hash: 'c', children: [] }] }] },
    transactions: { a: tx(W, { fees: '1000', op: '0x7369676e' }), b: tx(C, { value: '50000000', op: '0x00000015' }), c: tx(W, { value: '30000000', op: '0xd53276db' }) },
  });
  assert.equal(ok.complete, true);
  assert.equal(ok.ok, true);
  assert.equal(ok.bounced, false);
  assert.deepEqual(ok.steps.map((s) => [s.depth, s.account]), [[0, W], [1, C], [2, W]]);
  assert.equal(walletNet(ok.steps, W), -1000n - 50000000n + 30000000n);

  const bounced = summarizeTrace({
    trace_info: { trace_state: 'complete' },
    trace: { tx_hash: 'a', children: [{ tx_hash: 'b', children: [{ tx_hash: 'c', children: [] }] }] },
    transactions: { a: tx(W, {}), b: tx(C, { success: false, exit: 65535, aborted: true, action: null, value: '10' }), c: tx(W, { bounced: true, value: '9' }) },
  });
  assert.equal(bounced.ok, false);
  assert.equal(bounced.bounced, true);
  assert.equal(bounced.steps[1].exitCode, 65535);

  const actionFail = summarizeTrace({ trace_info: { trace_state: 'complete' }, trace: { tx_hash: 'a', children: [] }, transactions: { a: tx(W, { action: false }) } });
  assert.equal(actionFail.ok, false);
  assert.equal(actionFail.steps[0].actionCode, 37);

  // GRAM to an address without code, not bounceable: kept there, not a failure
  const deposit = summarizeTrace({
    trace_info: { trace_state: 'complete' },
    trace: { tx_hash: 'a', children: [{ tx_hash: 'b', children: [] }] },
    transactions: { a: tx(W, {}), b: tx(J, { skipped: true, reason: 'cskip_no_state', aborted: true, action: null, value: '5' }) },
  });
  assert.equal(deposit.ok, true);
  assert.equal(deposit.steps[1].noState, true);

  const pending = summarizeTrace({ trace_info: { trace_state: 'pending', pending_messages: 2 }, is_incomplete: true, trace: { tx_hash: 'a', children: [] }, transactions: { a: tx(W, {}) } });
  assert.equal(pending.complete, false);
});

test('emulation: signs with a throwaway key for the real wallet, reads TonAPI\'s trace', async () => {
  const real = keyPairFromSeed(Buffer.alloc(32, 1));
  const wallet = walletContract(real.publicKey, { version: 'v5r1' });
  const raw = wallet.address.toRawString();
  const posted = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/v3/walletInformation')) return new Response(JSON.stringify({ balance: '2000000000', status: 'active', seqno: 7 }), { status: 200 });
    if (u.includes('/v2/wallet/emulate')) {
      posted.push(JSON.parse(opts.body));
      const t = (address, extra) => ({ account: { address }, success: true, aborted: false, total_fees: 0, compute_phase: { skipped: false, success: true, exit_code: 0 }, action_phase: { success: true }, in_msg: { value: 0 }, ...extra });
      return new Response(JSON.stringify({
        trace: {
          transaction: t(raw, { total_fees: 2000000 }), interfaces: ['wallet_v5r1'],
          children: [{ transaction: t(C, { in_msg: { value: 50000000, op_code: '0x00000015' } }), interfaces: ['jetton_master'], children: [{ transaction: t(raw, { total_fees: 100000, in_msg: { value: 30000000, decoded_op_name: 'excess' } }), interfaces: [] }] }],
        },
        risk: { transfer_all_remaining_balance: false, ton: 50000000, jettons: [], nfts: [] },
        event: { extra: -1 },
      }), { status: 200 });
    }
    throw new Error(`unexpected ${u}`);
  };
  try {
    const chain = { id: -239, testnet: false, api: 'https://toncenter.com' };
    const body = toB64(beginCell().storeUint(21, 32).storeUint(0, 64).endCell());
    const r = await emulateMessages(chain, { publicKey: Buffer.from(real.publicKey).toString('hex'), version: 'v5r1' }, [{ to: C, value: '50000000', bounce: true, body }]);
    // the external message goes to the user's real wallet, with its real seqno
    const ext = loadMessage(Cell.fromBase64(posted[0].boc).beginParse());
    assert.ok(ext.info.dest.equals(wallet.address));
    assert.ok(!ext.init); // deployed wallet: no StateInit
    assert.equal(r.ok, true);
    assert.equal(r.deployed, true);
    assert.equal(r.balance, 2000000000n);
    assert.equal(r.wallet, raw);
    assert.equal(r.steps.length, 3);
    assert.equal(r.steps[2].opName, 'excess');
    assert.equal(r.net, -2000000n - 50000000n + (30000000n - 100000n));
  } finally {
    globalThis.fetch = orig;
  }
});

test('history details: fee of an action from its trace (excesses back, transferred GRAM excluded)', async () => {
  const traces = {
    jetton: { trace_info: { trace_state: 'complete' }, trace: { tx_hash: 'a', children: [{ tx_hash: 'b', children: [{ tx_hash: 'c', children: [] }] }] },
      transactions: { a: tx(W, { fees: '2000000' }), b: tx(J, { value: '50000000' }), c: tx(W, { value: '30000000', fees: '0' }) } },
    gram: { trace_info: { trace_state: 'complete' }, trace: { tx_hash: 'a', children: [{ tx_hash: 'b', children: [] }] },
      transactions: { a: tx(W, { fees: '1500000' }), b: tx(C, { value: '7000000000' }) } },
    received: { trace_info: { trace_state: 'complete' }, trace: { tx_hash: 'a', children: [{ tx_hash: 'b', children: [] }] },
      transactions: { a: tx(C, { fees: '1000' }), b: tx(W, { value: '5' }) } },
  };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const id = new URL(String(url)).searchParams.get('trace_id');
    return new Response(JSON.stringify({ traces: traces[id] ? [traces[id]] : [] }), { status: 200 });
  };
  try {
    const chain = { id: -239, api: 'https://toncenter.com' };
    assert.deepEqual(await actionFee(chain, 'jetton', W), { fee: 2000000n + 50000000n - 30000000n });
    assert.deepEqual(await actionFee(chain, 'gram', W, 7000000000n), { fee: 1500000n });
    assert.deepEqual(await actionFee(chain, 'received', W), { bySender: true });
    assert.equal(await actionFee(chain, 'missing', W), null);
  } finally {
    globalThis.fetch = orig;
  }
});
