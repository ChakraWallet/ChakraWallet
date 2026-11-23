// What a transaction asked by a dapp would do, before it is signed (EVM networks). eth_simulateV1 runs it on the
// current state of the chain on the network's own public nodes (nothing is broadcast; the same nodes receive the
// transaction when it is sent, so they learn nothing new). From the events it emits, anything a contract does on the
// way included: how the account's balances change (native coin, tokens, NFTs) and the spending permissions it leaves
// behind (ERC-20 approve, NFT approvals, Permit2). No UI here: src/ui/simulation.jsx shows it.
import { id, AbiCoder, getAddress } from 'ethers';
import { alchemyUrl } from './alchemy.js';
import { NATIVE, toHex } from './chains.js';
import { getTokenInfo, multiCall, rpc, erc20 } from './rpc.js';
import { POPULAR_TOKENS } from './tokens.js';

const coder = AbiCoder.defaultAbiCoder();
const TOPIC = {
  transfer: id('Transfer(address,address,uint256)'), // ERC-20 (3 topics), ERC-721 (4), native coin (traceTransfers)
  approval: id('Approval(address,address,uint256)'), // ERC-20 (3 topics), ERC-721 single NFT (4)
  approvalForAll: id('ApprovalForAll(address,address,bool)'),
  single: id('TransferSingle(address,address,address,uint256,uint256)'), // ERC-1155
  batch: id('TransferBatch(address,address,address,uint256[],uint256[])'),
  permit2Approval: id('Approval(address,address,address,uint160,uint48)'),
  permit2Permit: id('Permit(address,address,address,uint160,uint48,uint48)'),
  deposit: id('Deposit(address,uint256)'), // the wrapped coin (WETH...): coin in, tokens out, without a Transfer
  withdrawal: id('Withdrawal(address,uint256)'),
};
/** Uniswap's Permit2: the same address on every network. */
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const ZERO = '0x0000000000000000000000000000000000000000';

/** An amount at or above half the type's range counts as unlimited (dapps ask for the maximum). */
export const isUnlimited = (v, bits = 256) => BigInt(v) >= 1n << BigInt(bits - 1);

const topicAddr = (t) => '0x' + String(t).slice(-40).toLowerCase();

/** The network's wrapped coin (WETH, WPOL, WBNB...): its address, lowercase, or null. */
export const wrappedNative = (chain) => POPULAR_TOKENS[chain?.id]?.find((tk) => tk.symbol.toUpperCase() === `W${chain.native.symbol}`.toUpperCase())?.address || null;

// JSON-RPC errors that mean "this transaction can't run" (insufficient funds, bad nonce...: eth_simulateV1's -380xx),
// not "this node can't simulate"
const TX_ERROR = (code) => code <= -38000 && code > -38100;

/**
 * Runs tx = { from, to, value, data } on the latest block. -> the call's result ({ status, logs, error, gasUsed }),
 * or null when no node of the network can simulate (Avalanche's public nodes, a custom network...).
 * A node that doesn't know eth_simulateV1, is busy or unreachable: the next one (then Alchemy, with a key).
 */
export async function simulateTx(chain, tx) {
  const urls = [...(chain.rpc || [])];
  const alchemy = alchemyUrl(chain);
  if (alchemy) urls.push(alchemy);
  const call = { from: tx.from, ...(tx.to ? { to: tx.to } : {}), value: toHex(BigInt(tx.value || 0)), input: tx.data && tx.data !== '0x' ? tx.data : '0x' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [call] }], traceTransfers: true, validation: false }, 'latest'] });
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.error) {
        if (TX_ERROR(json.error.code)) return { status: '0x0', logs: [], error: { message: json.error.message } };
        continue;
      }
      const c = json.result?.[0]?.calls?.[0];
      if (c) return c;
    } catch { /* next node */ }
  }
  return null;
}

/**
 * What the simulated call does to `owner` (pure: no network). -> { failed, reason } |
 * { failed: false, changes: [{ kind: 'native'|'erc20'|'nft', token, id?, delta }],
 *   approvals: [{ kind: 'erc20'|'all'|'nft'|'permit2', token, spender, amount?, id?, expiration?, revoke }] }
 * changes: net amounts (in minus out; NFT: count), without the ones that come back. approvals: the last one for each
 * token and spender, revocations included (revoke: true). wrapped: the network's wrapped coin (wrappedNative), whose
 * Deposit and Withdrawal events move its tokens without a Transfer.
 */
export function analyzeCall(call, owner, { wrapped = null } = {}) {
  if (!call) return null;
  if (call.status !== '0x1') return { failed: true, reason: String(call.error?.message || '').replace(/^execution reverted:?\s*/i, '') };
  const me = owner.toLowerCase();
  const moves = new Map();
  const move = (kind, token, tokenId, delta) => {
    if (!delta) return;
    const key = `${kind}:${token}:${tokenId ?? ''}`;
    const m = moves.get(key) || { kind, token, ...(tokenId != null ? { id: tokenId } : {}), delta: 0n };
    m.delta += delta;
    moves.set(key, m);
  };
  const side = (from, to, v) => (from === me ? -v : 0n) + (to === me ? v : 0n);
  const approvals = new Map();
  for (const log of call.logs || []) {
    const a = String(log.address).toLowerCase();
    const tp = (log.topics || []).map((x) => String(x).toLowerCase());
    try {
      if (tp[0] === TOPIC.transfer && tp.length === 3) {
        move(a === NATIVE ? 'native' : 'erc20', a, null, side(topicAddr(tp[1]), topicAddr(tp[2]), BigInt(log.data)));
      } else if (tp[0] === TOPIC.transfer && tp.length === 4) {
        move('nft', a, BigInt(tp[3]), side(topicAddr(tp[1]), topicAddr(tp[2]), 1n));
      } else if (tp[0] === TOPIC.single && tp.length === 4) {
        const [nid, v] = coder.decode(['uint256', 'uint256'], log.data);
        move('nft', a, nid, side(topicAddr(tp[2]), topicAddr(tp[3]), v));
      } else if (tp[0] === TOPIC.batch && tp.length === 4) {
        const [ids, vals] = coder.decode(['uint256[]', 'uint256[]'], log.data);
        ids.forEach((nid, k) => move('nft', a, nid, side(topicAddr(tp[2]), topicAddr(tp[3]), vals[k])));
      } else if (a === wrapped && (tp[0] === TOPIC.deposit || tp[0] === TOPIC.withdrawal) && tp.length === 2 && topicAddr(tp[1]) === me) {
        move('erc20', a, null, (tp[0] === TOPIC.deposit ? 1n : -1n) * BigInt(log.data));
      } else if (a === PERMIT2 && (tp[0] === TOPIC.permit2Approval || tp[0] === TOPIC.permit2Permit) && topicAddr(tp[1]) === me) {
        const token = topicAddr(tp[2]), spender = topicAddr(tp[3]);
        const [amount, expiration] = coder.decode(['uint160', 'uint48'], log.data.slice(0, 130));
        approvals.set(`permit2:${token}:${spender}`, { kind: 'permit2', token, spender, amount, expiration: Number(expiration), revoke: amount === 0n });
      } else if (tp[0] === TOPIC.approval && tp.length === 3 && topicAddr(tp[1]) === me) {
        const spender = topicAddr(tp[2]), amount = BigInt(log.data);
        approvals.set(`erc20:${a}:${spender}`, { kind: 'erc20', token: a, spender, amount, revoke: amount === 0n });
      } else if (tp[0] === TOPIC.approval && tp.length === 4 && topicAddr(tp[1]) === me) {
        const spender = topicAddr(tp[2]);
        approvals.set(`nft:${a}:${tp[3]}`, { kind: 'nft', token: a, spender, id: BigInt(tp[3]), revoke: spender === ZERO });
      } else if (tp[0] === TOPIC.approvalForAll && tp.length === 3 && topicAddr(tp[1]) === me) {
        const spender = topicAddr(tp[2]);
        approvals.set(`all:${a}:${spender}`, { kind: 'all', token: a, spender, revoke: BigInt(log.data) === 0n });
      }
    } catch { /* a log that only looks like a standard one */ }
  }
  return { failed: false, changes: [...moves.values()].filter((m) => m.delta !== 0n), approvals: [...approvals.values()] };
}

/** EIP-7702: the contract an account delegates its code to, from its code (0xef0100 + address), or null. */
export const delegateOf = (code) => (/^0xef0100[0-9a-f]{40}$/i.test(String(code || '')) ? getAddress('0x' + code.slice(8)) : null);

/** What an address is: 'contract', 'delegated' (an ordinary account running a contract's code, EIP-7702) or 'account'. */
export async function addressKind(chain, address) {
  const code = await rpc(chain, 'eth_getCode', [address, 'latest']);
  if (!code || code === '0x') return 'account';
  return delegateOf(code) ? 'delegated' : 'contract';
}

const nameIface = erc20; // name() and symbol() of an NFT collection have the same signatures

/**
 * The analysis with what the screen needs: tokens (symbol, decimals), NFT collections (name), what each spender is
 * (spenderKind), and whether a token leaves entirely (all: the whole balance; most: 95% or more of the coin).
 * Each lookup may fail: what's missing stays out (the screen shows the address).
 */
export async function explainCall(chain, analysis, owner) {
  if (!analysis || analysis.failed) return analysis;
  const tokens = new Set([
    ...analysis.changes.filter((c) => c.kind === 'erc20').map((c) => c.token),
    ...analysis.approvals.filter((a) => a.kind === 'erc20' || a.kind === 'permit2').map((a) => a.token),
  ]);
  const collections = new Set([...analysis.changes.filter((c) => c.kind === 'nft'), ...analysis.approvals.filter((a) => a.kind === 'all' || a.kind === 'nft')].map((x) => x.token));
  const spenders = new Set(analysis.approvals.filter((a) => !a.revoke).map((a) => a.spender));
  const outs = analysis.changes.filter((c) => c.kind === 'erc20' && c.delta < 0n);

  const [infos, names, kinds, balances, nativeBalance] = await Promise.all([
    Promise.all([...tokens].map((tk) => getTokenInfo(chain, tk).catch(() => null))),
    multiCall(chain, [...collections].map((c) => ({ to: c, data: nameIface.encodeFunctionData('name') }))).catch(() => []),
    Promise.all([...spenders].map((s) => addressKind(chain, s).catch(() => null))),
    multiCall(chain, outs.map((c) => ({ to: c.token, data: erc20.encodeFunctionData('balanceOf', [owner]) }))).catch(() => []),
    analysis.changes.some((c) => c.kind === 'native' && c.delta < 0n) ? rpc(chain, 'eth_getBalance', [owner, 'latest']).then(BigInt).catch(() => null) : null,
  ]);
  const info = new Map([...tokens].map((tk, i) => [tk, infos[i]]));
  const name = new Map([...collections].map((c, i) => {
    try { return [c, names[i] ? erc20.decodeFunctionResult('name', names[i])[0] : null]; } catch { return [c, null]; }
  }));
  const kind = new Map([...spenders].map((s, i) => [s, kinds[i]]));
  const balance = new Map(outs.map((c, i) => [c.token, balances[i] ? BigInt(balances[i]) : null]));

  const changes = analysis.changes.map((c) => {
    if (c.kind === 'native') return { ...c, symbol: chain.native.symbol, decimals: chain.native.decimals, most: c.delta < 0n && nativeBalance != null && nativeBalance > 0n && -c.delta * 100n >= nativeBalance * 95n };
    if (c.kind === 'erc20') {
      const tk = info.get(c.token);
      const bal = balance.get(c.token);
      return { ...c, symbol: tk?.symbol, decimals: tk?.decimals, all: c.delta < 0n && bal != null && -c.delta >= bal };
    }
    return { ...c, collection: name.get(c.token) || null };
  });
  const approvals = analysis.approvals.map((a) => ({
    ...a,
    symbol: info.get(a.token)?.symbol, decimals: info.get(a.token)?.decimals,
    collection: name.get(a.token) || null,
    spenderKind: kind.get(a.spender) || null,
    unlimited: a.amount != null && isUnlimited(a.amount, a.kind === 'permit2' ? 160 : 256),
  }));
  return { failed: false, changes, approvals };
}

/**
 * How serious it is: 'ack' when a permission goes to an ordinary account (an address without a contract: that's how
 * wallet drainers collect), 'danger' for unlimited permissions or a whole balance leaving, else null.
 */
export function riskOf(explained) {
  if (!explained || explained.failed) return null;
  const live = explained.approvals.filter((a) => !a.revoke);
  if (live.some((a) => a.spenderKind === 'account' || a.spenderKind === 'delegated')) return 'ack';
  if (live.some((a) => a.unlimited || a.kind === 'all') || explained.changes.some((c) => c.all || c.most)) return 'danger';
  return null;
}
