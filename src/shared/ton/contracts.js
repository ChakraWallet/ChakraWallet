// Contracts on TON (Android app): open a contract (state, interfaces, get methods, verified sources), run get methods
// and read their results, emulate a message before it is signed, follow the chain of transactions after sending.
// No keys here: emulation signs with a throwaway key (TonAPI doesn't check the signature), real sends go through the
// background (tonSend).
import { Buffer } from './buffer.js';
import { Address, Cell, loadStateInit } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { tonapiAccount, tonapiInspect, tonapiJetton, tonapiEmulate } from './tonapi.js';
import { tonAccount, tonAddressInfo, tonRunGetMethod, tonTraceByTx, tonWaitApplied } from './api.js';
import { walletContract, signTransfer } from './core.js';
import { readStack, stackArg, cellAddress, cellText, parseContent } from './cells.js';

const DUMMY = keyPairFromSeed(Buffer.alloc(32, 7)); // emulation only: never a real key
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "0:ABC…" / EQ… / UQ… -> lower-case raw form (the key used to store and compare addresses), or null. */
export function rawAddress(text) {
  try { return Address.parse(String(text).trim()).toRawString(); } catch { return null; }
}
export const sameAddress = (a, b) => !!a && !!b && rawAddress(a) === rawAddress(b);
/** Contracts are shown bounceable (EQ…), wallets non-bounceable (UQ…), as explorers do. */
export const showAddress = (a, { testnet = false, wallet = false } = {}) => {
  try { return Address.parse(typeof a === 'string' ? a : a.toRawString()).toString({ urlSafe: true, bounceable: !wallet, testOnly: testnet }); } catch { return String(a); }
};

// ------------------------------------------------------------ kinds and known get methods
const KINDS = [
  ['jetton_master', /^jetton_master/], ['jetton_wallet', /^jetton_wallet/], ['nft_collection', /^nft_collection/],
  ['nft_sale', /^nft_(sale|auction)/], ['nft_item', /^(nft_item|teleitem|sbt|nft_)/], ['wallet', /^wallet/],
  ['dex', /^(stonfi|dedust|tonco|megaton|bidask|swap_coffee)/], ['dns', /^dns/],
];
/** Kind of a contract from its TonAPI interfaces: jetton_master, jetton_wallet, nft_collection, nft_item, wallet, dex… or null. */
export function kindOf(interfaces = []) {
  for (const [k, re] of KINDS) if (interfaces.some((i) => re.test(i))) return k;
  return null;
}
/** Wallet version from the interfaces (e.g. wallet_v5r1 -> v5r1). */
export const walletVersionOf = (interfaces = []) => (interfaces.map((i) => /^wallet_(v\d+r\d+|highload\w*|v\d+\w*)/i.exec(i)?.[1]).find(Boolean) || null);

/**
 * Get methods of the standards (TEP-74 jettons, TEP-62/66 NFT, wallets): arguments and the meaning of each result.
 * Result types: amount (token units), bool, address, content (TEP-64), code, int, time, hex, cell, any.
 */
export const GETTERS = {
  get_jetton_data: { args: [], out: [['total_supply', 'amount'], ['mintable', 'bool'], ['admin', 'address'], ['content', 'content'], ['wallet_code', 'code']] },
  get_wallet_data: { args: [], out: [['balance', 'amount'], ['owner', 'address'], ['jetton', 'address'], ['wallet_code', 'code']] },
  get_wallet_address: { args: [['owner_address', 'address']], out: [['wallet_address', 'address']] },
  get_collection_data: { args: [], out: [['next_item_index', 'int'], ['content', 'content'], ['owner', 'address']] },
  get_nft_address_by_index: { args: [['index', 'int']], out: [['address', 'address']] },
  get_nft_data: { args: [], out: [['init', 'bool'], ['index', 'int'], ['collection', 'address'], ['owner', 'address'], ['content', 'cell']] },
  get_nft_content: { args: [['index', 'int'], ['individual_content', 'cell']], out: [['content', 'content']] },
  royalty_params: { args: [], out: [['numerator', 'int'], ['denominator', 'int'], ['destination', 'address']] },
  get_editor: { args: [], out: [['editor', 'address']] },
  get_authority_address: { args: [], out: [['authority', 'address']] },
  get_revoked_time: { args: [], out: [['revoked_time', 'time']] },
  get_next_admin_address: { args: [], out: [['next_admin', 'address']] },
  get_status: { args: [], out: [['status', 'int']] },
  seqno: { args: [], out: [['seqno', 'int']] },
  get_public_key: { args: [], out: [['public_key', 'hex']] },
  get_subwallet_id: { args: [], out: [['subwallet_id', 'int']] },
  get_wallet_id: { args: [], out: [['wallet_id', 'int']] },
  is_signature_allowed: { args: [], out: [['signature_allowed', 'bool']] },
  get_plugin_list: { args: [], out: [['plugins', 'any']] },
};
/** Get methods every contract of a kind has, also when TonAPI can't read the names from the code. */
const BY_KIND = {
  jetton_master: ['get_jetton_data', 'get_wallet_address'], jetton_wallet: ['get_wallet_data'],
  nft_collection: ['get_collection_data', 'get_nft_address_by_index', 'get_nft_content', 'royalty_params'], nft_item: ['get_nft_data'],
  wallet: ['seqno', 'get_public_key'],
};
const OVERVIEW_MAX = 4;

// ------------------------------------------------------------ opening a contract
/**
 * Everything the contract page shows first:
 * { chainId, address (raw), status, balance, interfaces, kind, walletVersion, name, isScam, codeHash, compiler,
 *   sources, disassembled, code, methods: [{ name, id, known }], jetton (master info) }
 */
export async function loadTonContract(chain, input) {
  const raw = rawAddress(input);
  if (!raw) throw new Error('address');
  const acc = await tonapiAccount(chain, raw).catch(() => null);
  const c = {
    chainId: chain.id, address: raw, status: acc?.status || 'nonexist', balance: acc?.balance ?? 0n, interfaces: acc?.interfaces || [],
    name: acc?.name || null, isScam: !!acc?.isScam, isWallet: !!acc?.isWallet, kind: null, walletVersion: null, codeHash: null, compiler: null,
    sources: null, disassembled: null, code: null, methods: [], jetton: null, partial: !acc,
  };
  if (!acc) { // TonAPI unreachable: TON Center still says what's there
    const info = await tonAddressInfo(chain, raw);
    Object.assign(c, { status: info.status, balance: info.balance, code: info.code });
  }
  c.kind = kindOf(c.interfaces);
  c.walletVersion = c.kind === 'wallet' ? walletVersionOf(c.interfaces) : null;
  if (c.status !== 'active') return c;
  const ins = await tonapiInspect(chain, raw).catch(() => null);
  if (ins) Object.assign(c, { code: ins.code, codeHash: ins.codeHash, compiler: ins.compiler, sources: ins.sources, disassembled: ins.disassembled });
  if (!c.codeHash && c.code) { try { c.codeHash = Cell.fromBase64(c.code).hash().toString('hex'); } catch { /* bad code */ } }
  const names = new Map();
  for (const m of ins?.methods || []) names.set(m.name || `#${m.id}`, { name: m.name || null, id: m.id });
  for (const n of [...(acc?.getMethods || []), ...(BY_KIND[c.kind] || [])]) if (!names.has(n)) names.set(n, { name: n, id: null });
  c.methods = [...names.values()].map((m) => ({ ...m, known: (m.name && GETTERS[m.name]) || null }))
    .sort((a, b) => (!!b.known - !!a.known) || String(a.name ?? '~').localeCompare(String(b.name ?? '~')));
  if (c.kind === 'jetton_master') c.jetton = await tonapiJetton(chain, raw).catch(() => null);
  if (!c.name && c.jetton?.name) c.name = c.jetton.name;
  return c;
}

/** Data cell of a contract (base64 BoC) and its size, from TON Center. */
export async function contractData(chain, address) {
  const info = await tonAddressInfo(chain, address);
  return { data: info.data, code: info.code };
}

// ------------------------------------------------------------ get methods
/** Runs a get method: method = name or numeric id; args = [{ type, value }] (see cells.ARG_TYPES). */
export async function runGetter(chain, address, method, args = []) {
  const r = await tonRunGetMethod(chain, address, method, args.map(stackArg));
  return { exitCode: r.exitCode, gasUsed: r.gasUsed, items: readStack(r.stack), ok: r.exitCode === 0 || r.exitCode === 1 };
}

/**
 * A stack item read with a type hint (see GETTERS) or guessed:
 * { t: 'int' | 'bool' | 'amount' | 'time' | 'address' | 'text' | 'content' | 'code' | 'hex' | 'cell' | 'tuple' | 'null' | 'unknown', … }
 */
export function interpret(item, hint, ctx = {}) {
  if (!item || item.kind === 'null') return { t: 'null' };
  if (item.kind === 'tuple') return { t: 'tuple', items: item.items.map((x) => interpret(x, null, ctx)) };
  if (item.kind === 'unknown') return { t: 'unknown', raw: item.raw };
  if (item.kind === 'num') {
    const v = item.value;
    if (hint === 'bool') return { t: 'bool', v: v !== 0n };
    if (hint === 'amount') return { t: 'amount', v, decimals: ctx.decimals ?? 9, symbol: ctx.symbol || null };
    if (hint === 'time') return { t: 'time', v: Number(v) * 1000 };
    if (hint === 'hex') return { t: 'hex', v: v.toString(16).padStart(64, '0') };
    return { t: 'int', v };
  }
  const cell = item.cell;
  if (hint === 'code') return { t: 'code', hash: cell.hash().toString('hex'), cell };
  if (hint === 'address' || hint == null) {
    const a = cellAddress(cell);
    if (a !== undefined) return { t: 'address', v: a };
  }
  if (hint === 'content' || hint == null) {
    const c = hint === 'content' || cell.bits.length >= 8 ? parseContent(cell) : null;
    const link = c?.uri && (hint === 'content' || /^(https?|ipfs|tonstorage):\/\//i.test(c.uri));
    if (c && (link || Object.keys(c.onchain || {}).length)) return { t: 'content', v: c };
  }
  if (hint == null || hint === 'cell') {
    const text = cellText(cell);
    if (text && text.length > 1) return { t: 'text', v: text, cell };
  }
  return { t: 'cell', cell };
}

/** Results of the standard get methods without arguments, run at once for the overview: [{ method, values: [...] , error }] */
export async function readTonOverview(chain, c, ctx = {}) {
  const list = c.methods.filter((m) => m.known && m.known.args.length === 0).slice(0, OVERVIEW_MAX);
  const out = [];
  let token = ctx.token || (c.jetton ? { decimals: c.jetton.decimals, symbol: c.jetton.symbol } : null);
  for (const m of list) {
    try {
      const r = await runGetter(chain, c.address, m.name);
      if (!r.ok) { out.push({ method: m, exitCode: r.exitCode }); continue; }
      // a jetton wallet: its balance is in the units of its jetton (decimals from the master)
      if (m.name === 'get_wallet_data' && !token) {
        const master = r.items[2]?.cell && cellAddress(r.items[2].cell);
        if (master) { const j = await tonapiJetton(chain, master.toRawString()).catch(() => null); if (j) token = { decimals: j.decimals, symbol: j.symbol, master: master.toRawString() }; }
      }
      out.push({ method: m, values: m.known.out.map(([name, type], i) => ({ name, ...interpret(r.items[i], type, token || {}) })) });
    } catch (e) { out.push({ method: m, error: e.message }); }
  }
  return { rows: out, token };
}

/** Off-chain metadata JSON (TEP-64 link), for names and images; null if it can't be read. */
export async function fetchMetadata(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

// ------------------------------------------------------------ exit codes
/** Standard TVM / TON exit codes (and Tact's 128-138) with a description (i18n key: tonc.exit.<code>). */
export const KNOWN_EXIT = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, -14, 32, 33, 34, 35, 36, 37, 38, 40, 43, 128, 129, 130, 131, 132, 133, 134, 135, 136, 138, 65535];
/** Key suffix of a known exit code (tonc.exit.<suffix>), or null. */
export const exitKey = (code) => (KNOWN_EXIT.includes(Number(code)) ? (Number(code) < 0 ? `m${-Number(code)}` : String(Number(code))) : null);

// ------------------------------------------------------------ messages: emulation, sending, trace
/** UI message { to, value, bounce, body?: base64, init?: base64 } -> the form signTransfer takes. */
const toInternal = (m) => ({
  to: Address.parse(m.to), value: BigInt(m.value), bounce: !!m.bounce,
  body: m.body ? Cell.fromBase64(m.body) : undefined, init: m.init ? loadStateInit(Cell.fromBase64(m.init).beginParse()) : undefined,
});

const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const norm = (a) => rawAddress(a) || String(a || '').toLowerCase();

/** One transaction, from TonAPI's or TON Center's format, as the screens show it. */
function step(depth, account, interfaces, compute, action, aborted, inMsg, fees) {
  const skipped = !!compute?.skipped;
  const noState = skipped && /no_state/.test(String(compute?.skip_reason ?? compute?.reason ?? ''));
  const computeFailed = !skipped && compute && compute.success === false;
  const actionFailed = !!action && action.success === false;
  return {
    depth, account: norm(account), interfaces: interfaces || [],
    ok: !computeFailed && !actionFailed && (!skipped || noState || !aborted),
    exitCode: skipped ? null : compute?.exit_code ?? null, noState, actionCode: actionFailed ? action.result_code ?? null : null,
    bounced: !!inMsg?.bounced, op: inMsg?.op_code ?? inMsg?.opcode ?? null, opName: inMsg?.decoded_op_name || null, value: big(inMsg?.value),
    fees: big(fees),
  };
}

/**
 * Emulates sending messages from a wallet (nothing is broadcast): { ok, bounced, steps, net (change of the wallet's
 * balance, nanoGRAM, negative = spent), risk, deployed }.
 * wallet: { publicKey (hex), version }.
 */
export async function emulateMessages(chain, wallet, messages) {
  const w = walletContract(Buffer.from(wallet.publicKey, 'hex'), { version: wallet.version, testnet: !!chain.testnet });
  const acc = await tonAccount(chain, w.address.toString());
  const deployed = acc.status === 'active';
  const signed = signTransfer({
    wallet: w, secretKey: DUMMY.secretKey, seqno: deployed ? acc.seqno : 0, deployed, timeout: Math.floor(Date.now() / 1000) + 300, messages: messages.map(toInternal),
  });
  const r = await tonapiEmulate(chain, signed.boc);
  const steps = [];
  const walk = (n, depth) => {
    if (!n?.transaction) return;
    const tx = n.transaction;
    steps.push(step(depth, tx.account?.address, n.interfaces, tx.compute_phase, tx.action_phase, tx.aborted, tx.in_msg, tx.total_fees));
    for (const ch of n.children || []) walk(ch, depth + 1);
  };
  walk(r.trace, 0);
  return {
    ok: steps.every((s) => s.ok), bounced: steps.some((s) => s.bounced), steps, net: walletNet(steps, w.address.toRawString()), risk: r.risk || null,
    balance: acc.balance, deployed, wallet: w.address.toRawString(),
  };
}

/** Change of the wallet's balance over a trace: what it sent and paid, minus what came back (excesses, bounces). */
export function walletNet(steps, wallet) {
  const me = norm(wallet);
  let net = 0n;
  steps.forEach((s) => {
    if (s.depth === 0) net -= s.fees;
    else if (s.depth === 1) net -= s.value; // messages the wallet sent
    if (s.depth > 0 && s.account === me) net += s.value - s.fees; // excesses and bounces back to the wallet
  });
  return net;
}

/** TON Center trace -> { complete, ok, bounced, steps }. */
export function summarizeTrace(tr) {
  const steps = [];
  const walk = (n, depth) => {
    const tx = tr.transactions?.[n?.tx_hash];
    if (!tx) return;
    const d = tx.description || {};
    steps.push(step(depth, tx.account, null, d.compute_ph, d.action, d.aborted, tx.in_msg, tx.total_fees));
    for (const ch of n.children || []) walk(ch, depth + 1);
  };
  walk(tr.trace, 0);
  const complete = tr.trace_info ? tr.trace_info.trace_state === 'complete' || (tr.trace_info.pending_messages === 0 && !tr.is_incomplete) : !tr.is_incomplete;
  return { complete, ok: steps.every((s) => s.ok), bounced: steps.some((s) => s.bounced), steps };
}

/**
 * After tonSend: waits for the wallet to apply the message, then follows the trace until every message has been
 * processed. onUpdate({ phase: 'applied' | 'trace', trace?, txHash }) on the way. -> { txHash, trace (summary) | null }.
 */
export async function followSend(chain, sent, onUpdate, { timeoutMs = 150000 } = {}) {
  const t0 = Date.now();
  const applied = await tonWaitApplied(chain, sent.wallet, sent.seqno, { hash: sent.hash, timeoutMs: 120000 });
  onUpdate?.({ phase: 'applied', txHash: applied.txHash });
  if (!applied.txHash) return { txHash: null, trace: null };
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const tr = await tonTraceByTx(chain, applied.txHash).catch(() => null);
    if (tr) {
      last = summarizeTrace(tr);
      onUpdate?.({ phase: 'trace', trace: last, txHash: applied.txHash });
      if (last.complete) break;
    }
    await sleep(3000);
  }
  return { txHash: applied.txHash, trace: last };
}
