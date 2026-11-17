// Solana history from the node alone (any node, no indexer): the wallet's signatures and those of its token accounts
// (a token received doesn't mention the wallet, only its token account), each transaction read and turned into the
// shared history item (classify() in src/shared/history.js): what entered and left the wallet, from its balance changes.
import { rpc, pool, parsedTransaction, keyedNode } from './api.js';
import { tokenAccounts, tokenMetas, shortMint } from './tokens.js';
import { PROGRAMS, WSOL } from './tx.js';

/** Programs with a name of their own in the history: where a swap went, what an operation was. */
export const KNOWN_PROGRAMS = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter',
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: 'Jupiter',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'Meteora',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Metaplex',
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d: 'Metaplex Core',
  src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4: 'deBridge',
  [PROGRAMS.stake]: 'Stake',
  [PROGRAMS.loaderV3]: 'BPF Loader',
};
const SWAPPERS = new Set(['Jupiter', 'Raydium', 'Orca', 'Meteora', 'Pump.fun', 'PumpSwap']);
const RENT_LIKE = 3_000_000n; // SOL that moves with token operations without being a payment: token accounts' rent
const DUST = 100_000n; // 0.0001 SOL received from a stranger: the "address poisoning" dust

/** Every instruction of a parsed transaction, top level and inner, in order. */
function allInstructions(tx) {
  const top = tx.transaction.message.instructions || [];
  const inner = new Map((tx.meta?.innerInstructions || []).map((x) => [x.index, x.instructions]));
  return top.flatMap((ix, i) => [ix, ...(inner.get(i) || [])]);
}

/**
 * One parsed transaction (getTransaction, jsonParsed) as a shared history item, for `owner`.
 * metas: Map mint -> { symbol, decimals, icon, spam, known } (tokens.js).
 */
export function classifySol(chain, owner, sigInfo, tx, metas = new Map()) {
  const base = { hash: sigInfo.signature, time: (sigInfo.blockTime || 0) * 1000, status: sigInfo.err ? 'failed' : 'ok' };
  if (!tx?.meta) return { ...base, kind: 'contract', transfers: [], from: null, to: null, fee: null, sentByMe: false, spam: false, label: null };
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const signers = new Set(tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey));
  const feePayer = keys[0];
  const meIdx = keys.indexOf(owner);
  const fee = BigInt(tx.meta.fee || 0);
  let solDelta = meIdx >= 0 ? BigInt(tx.meta.postBalances[meIdx]) - BigInt(tx.meta.preBalances[meIdx]) : 0n;
  if (feePayer === owner) solDelta += fee;

  // tokens: the owner's balance changes per mint
  const tokenDelta = new Map();
  const ownerOf = new Map(); // token account -> owner
  const bal = (list, sign) => {
    for (const b of list || []) {
      ownerOf.set(keys[b.accountIndex], b.owner);
      if (b.owner !== owner) continue;
      const d = tokenDelta.get(b.mint) || { amount: 0n, decimals: b.uiTokenAmount.decimals };
      d.amount += sign * BigInt(b.uiTokenAmount.amount);
      tokenDelta.set(b.mint, d);
    }
  };
  bal(tx.meta.preTokenBalances, -1n);
  bal(tx.meta.postTokenBalances, 1n);
  for (const [m, d] of tokenDelta) if (d.amount === 0n || m === WSOL) tokenDelta.delete(m); // wrapped SOL: counted as SOL

  const ixs = allInstructions(tx);
  const programs = new Set(ixs.map((ix) => ix.programId));
  const named = [...programs].map((p) => KNOWN_PROGRAMS[p]).filter(Boolean);
  const sysTransfers = ixs.filter((ix) => ix.program === 'system' && /^transfer/.test(ix.parsed?.type || '') && (ix.parsed.info.source === owner || ix.parsed.info.destination === owner));
  const tokTransfers = ixs.filter((ix) => (ix.program === 'spl-token' || ix.programId === PROGRAMS.token2022) && /^transfer/.test(ix.parsed?.type || ''));
  const memoText = ixs.filter((ix) => ix.program === 'spl-memo' && typeof ix.parsed === 'string').map((ix) => ix.parsed).join(' ').trim() || null;

  // SOL that only paid token accounts' rent (or got it back) is part of the cost, not a payment
  let extraFee = 0n;
  const abs = (x) => (x < 0n ? -x : x);
  // (not in a swap: selling a token for a little SOL moves it without a system transfer, through wrapped SOL)
  const swapped = named.some((n) => SWAPPERS.has(n));
  if (tokenDelta.size && !sysTransfers.length && !swapped && abs(solDelta) < RENT_LIKE) { extraFee = -solDelta; solDelta = 0n; }

  const transfers = [];
  if (solDelta !== 0n) {
    const t = sysTransfers.find((ix) => (solDelta < 0n ? ix.parsed.info.source === owner : ix.parsed.info.destination === owner));
    const cp = t ? (solDelta < 0n ? t.parsed.info.destination : t.parsed.info.source) : null;
    transfers.push({ dir: solDelta < 0n ? 'out' : 'in', symbol: chain.native.symbol, decimals: 9, amount: abs(solDelta).toString(), icon: '', native: true, token: null, counterparty: cp && cp !== owner ? cp : null });
  }
  for (const [mint, d] of tokenDelta) {
    const m = metas.get(mint);
    const out = d.amount < 0n;
    const t = tokTransfers.find((ix) => {
      const i = ix.parsed.info;
      return (i.mint ? i.mint === mint : true) && (out ? (i.authority || i.multisigAuthority) === owner || ownerOf.get(i.source) === owner : ownerOf.get(i.destination) === owner);
    });
    const i = t?.parsed.info;
    const cp = i ? (out ? ownerOf.get(i.destination) || i.destination : ownerOf.get(i.source) || i.authority || i.source) : null;
    transfers.push({
      dir: out ? 'out' : 'in', symbol: m?.symbol || shortMint(mint), decimals: m?.decimals ?? d.decimals, amount: abs(d.amount).toString(),
      icon: m?.icon || '', native: false, token: mint, counterparty: cp && cp !== owner ? cp : null, _spam: !!m?.spam, _known: !!m?.known,
    });
  }
  const ins = transfers.filter((x) => x.dir === 'in'), outs = transfers.filter((x) => x.dir === 'out');
  const self = sysTransfers.some((ix) => ix.parsed.info.source === owner && ix.parsed.info.destination === owner);
  const kind = ins.length && outs.length ? 'swap' : outs.length ? 'send' : ins.length ? 'receive' : self ? 'self' : 'contract';
  const sentByMe = feePayer === owner || signers.has(owner);
  const counterparty = kind === 'send' ? outs[0].counterparty : kind === 'receive' ? ins[0].counterparty : null;
  // spam: dust or a flagged token from a stranger, or a transaction that only mentions the wallet (ads in memos)
  const spam = !sentByMe && (
    (kind === 'receive' && ins.every((x) => (x.native ? BigInt(x.amount) <= DUST : x._spam || (!x._known && !metas.get(x.token)?.icon))))
    || kind === 'contract');
  const via = kind === 'swap' ? named.find((n) => SWAPPERS.has(n)) || named[0] || null : null;
  return {
    ...base, kind, transfers: transfers.map(({ _spam, _known, ...x }) => x), spam,
    from: kind === 'receive' ? counterparty : owner, to: kind === 'send' ? counterparty : kind === 'receive' ? owner : null,
    counterparty, sentByMe, comment: memoText && (sentByMe || !spam) ? memoText.slice(0, 280) : null, via,
    label: kind === 'contract' || kind === 'self' ? (named[0] || null) : null,
    fee: sentByMe && feePayer === owner ? (fee + (extraFee > 0n ? extraFee : 0n)).toString() : null,
  };
}

/** Cursor of the history: per address, the last signature already shown (null: nothing more there). */
const readCursor = (c) => { try { return c ? JSON.parse(c) : null; } catch { return null; } };

/**
 * A page of a wallet's history: { items, next, error, unsupported }. The wallet's own signatures and its token
 * accounts', merged by time; `next` continues each list where the page stopped.
 */
export async function loadSolHistory(chain, owner, cursor, { limit = null } = {}) {
  const fast = keyedNode(chain);
  const size = limit || (fast ? 25 : 15);
  let cur = readCursor(cursor);
  if (!cur) {
    const accs = await tokenAccounts(chain, owner).catch(() => []);
    cur = { [owner]: '' };
    for (const a of accs.slice(0, fast ? 30 : 12)) cur[a.account] = '';
  }
  const addrs = Object.keys(cur).filter((a) => cur[a] !== null);
  const lists = await pool(addrs, (a, i) => rpc(chain, 'getSignaturesForAddress', [a, { limit: size, ...(cur[a] ? { before: cur[a] } : {}), commitment: 'confirmed' }], { start: i })
    .then((r) => r.map((s) => ({ ...s, _from: a }))).catch(() => null), fast ? 6 : 2);
  const seen = new Set();
  const merged = lists.flat().filter((s) => s && !seen.has(s.signature) && seen.add(s.signature)).sort((a, b) => (b.slot - a.slot) || ((b.blockTime || 0) - (a.blockTime || 0)));
  const page = merged.slice(0, size);
  // the cursor moves, per address, to the last of its signatures on this page; lists that ran out stop
  const next = { ...cur };
  addrs.forEach((a, i) => {
    const list = lists[i];
    if (!list) return; // that address failed: tried again next time from the same place
    const used = list.filter((s) => page.some((p) => p.signature === s.signature));
    if (used.length) next[a] = used[used.length - 1].signature;
    if (list.length < size && used.length === list.length) next[a] = null;
  });
  const txs = await pool(page, (s, i) => parsedTransaction(chain, s.signature, { start: i }).catch(() => null), fast ? 8 : 2);
  const mints = new Set();
  for (const tx of txs) for (const b of [...(tx?.meta?.preTokenBalances || []), ...(tx?.meta?.postTokenBalances || [])]) if (b.owner === owner) mints.add(b.mint);
  const metas = await tokenMetas(chain, [...mints]).catch(() => new Map());
  const items = page.map((s, i) => classifySol(chain, owner, s, txs[i], metas));
  const more = Object.values(next).some((v) => v !== null) && merged.length > 0;
  return { items, next: more ? JSON.stringify(next) : null, error: null, unsupported: false };
}
