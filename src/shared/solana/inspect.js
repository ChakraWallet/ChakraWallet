// What a Solana transaction made by someone else (a dapp) does to the wallet, before it is signed: its instructions in
// words where the program is known, the dangerous ones (giving away a token account, a spending allowance, the wallet
// account handed to a program), and - from a simulation - how the wallet's SOL and tokens change.
import { PROGRAMS, parseTransaction, parseMessage, messageInstructions, messageAccounts } from './tx.js';
import { addressOf } from './core.js';
import * as b58 from './base58.js';
import { simulate, lookupTables, solBalance, multipleAccounts, rpc, SOL_CHAINS } from './api.js';
import { tokenAccounts, tokenMetas, shortMint } from './tokens.js';
import { programName } from './programs.js';

const u32le = (d, o) => new DataView(d.buffer, d.byteOffset, d.length).getUint32(o, true);
const u64le = (d, o) => new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(o, true);
const isToken = (p) => p === PROGRAMS.token || p === PROGRAMS.token2022;

/** The standard programs' instructions in words: { name, fields } or null. */
export function describeIx(ix) {
  const d = ix.data;
  try {
    if (ix.programId === PROGRAMS.system) {
      const tag = u32le(d, 0);
      if (tag === 2) return { name: 'transfer', fields: { from: ix.keys[0]?.pubkey, to: ix.keys[1]?.pubkey, lamports: u64le(d, 4) } };
      if (tag === 0) return { name: 'createAccount', fields: { from: ix.keys[0]?.pubkey, account: ix.keys[1]?.pubkey, lamports: u64le(d, 4), space: u64le(d, 12), owner: b58.encode(d.slice(20, 52)) } };
      if (tag === 1) return { name: 'assign', fields: { account: ix.keys[0]?.pubkey, owner: b58.encode(d.slice(4, 36)) } };
      if (tag === 8) return { name: 'allocate', fields: { account: ix.keys[0]?.pubkey, space: u64le(d, 4) } };
      if (tag === 4) return { name: 'advanceNonce', fields: { nonceAccount: ix.keys[0]?.pubkey, authority: ix.keys[2]?.pubkey } };
      return { name: `system #${tag}`, fields: {} };
    }
    if (ix.programId === PROGRAMS.computeBudget) {
      if (d[0] === 2) return { name: 'setComputeUnitLimit', fields: { units: u32le(d, 1) } };
      if (d[0] === 3) return { name: 'setComputeUnitPrice', fields: { microLamports: u64le(d, 1) } };
    }
    if (ix.programId === PROGRAMS.memo || ix.programId === PROGRAMS.memoV1) return { name: 'memo', fields: { text: new TextDecoder().decode(d) } };
    if (isToken(ix.programId)) {
      const names = { 3: 'transfer', 7: 'mintTo', 8: 'burn', 9: 'closeAccount', 10: 'freezeAccount', 11: 'thawAccount', 12: 'transferChecked', 4: 'approve', 13: 'approveChecked', 6: 'setAuthority', 15: 'burnChecked', 20: 'initializeMint2', 17: 'syncNative', 1: 'initializeAccount', 18: 'initializeAccount3', 5: 'revoke' };
      const name = names[d[0]] || `token #${d[0]}`;
      const fields = {};
      if ([3, 7, 8, 12, 4, 13, 15].includes(d[0])) fields.amount = u64le(d, 1);
      if (d[0] === 4) Object.assign(fields, { account: ix.keys[0]?.pubkey, delegate: ix.keys[1]?.pubkey, owner: ix.keys[2]?.pubkey });
      if (d[0] === 13) Object.assign(fields, { account: ix.keys[0]?.pubkey, mint: ix.keys[1]?.pubkey, delegate: ix.keys[2]?.pubkey, owner: ix.keys[3]?.pubkey });
      if (d[0] === 6) Object.assign(fields, { account: ix.keys[0]?.pubkey, authorityType: d[1], newAuthority: d[2] ? b58.encode(d.slice(3, 35)) : null, current: ix.keys[1]?.pubkey });
      if (d[0] === 9) Object.assign(fields, { account: ix.keys[0]?.pubkey, destination: ix.keys[1]?.pubkey, owner: ix.keys[2]?.pubkey });
      return { name, fields };
    }
    if (ix.programId === PROGRAMS.ata) return { name: d[0] === 1 ? 'createIdempotent' : 'create', fields: { owner: ix.keys[2]?.pubkey, mint: ix.keys[3]?.pubkey } };
  } catch { /* the raw view */ }
  return null;
}

/**
 * Dangers of the instructions for `owner`: [{ level: 'danger' | 'warn', key, vars }] (i18n keys under sol.risk.).
 * myAccounts: the owner's token accounts (addresses).
 */
export function staticRisks(ixs, owner, myAccounts = new Set()) {
  const out = [];
  for (const ix of ixs) {
    const k = describeIx(ix);
    if (!k) continue;
    if (k.name === 'assign' && k.fields.account === owner) out.push({ level: 'danger', key: 'assign', vars: { program: programName(k.fields.owner) || k.fields.owner } });
    // a durable nonce instead of a recent blockhash: once signed, it can be sent at any time, also much later
    if (k.name === 'advanceNonce') out.push({ level: 'danger', key: 'nonce', vars: {} });
    if (k.name === 'setAuthority' && (myAccounts.has(k.fields.account) || k.fields.current === owner) && (k.fields.authorityType === 2 || k.fields.authorityType === 3)) {
      out.push({ level: 'danger', key: 'tokenOwner', vars: { to: k.fields.newAuthority || '—' } });
    }
    if ((k.name === 'approve' || k.name === 'approveChecked') && k.fields.owner === owner) out.push({ level: 'warn', key: 'delegate', vars: { delegate: k.fields.delegate } });
  }
  return out;
}

/** A token account's data: { mint, owner, amount } (both token programs share the first 165 bytes), or null. */
export function readTokenAccount(data) {
  if (!data || data.length < 165) return null;
  return { mint: addressOf(data.slice(0, 32)), owner: addressOf(data.slice(32, 64)), amount: u64le(data, 64) };
}

/**
 * Everything the approval screen shows of a transaction (wire bytes) for `owner`:
 * { version, signers, instructions: [{ programId, program, known, keys, data }], risks, sim: { ok, err, logs, units },
 *   sol (lamports change, bigint | null), tokens: [{ mint, symbol, decimals, icon, delta (bigint) }] }
 */
export async function analyzeTx(chain, bytes, owner) {
  const tx = parseTransaction(bytes);
  const tables = tx.msg.lookups.length ? await lookupTables(chain, tx.msg.lookups.map((l) => l.key)).catch(() => ({})) : {};
  const ixs = messageInstructions(tx.msg, tables);
  const mine = await tokenAccounts(chain, owner).catch(() => []);
  const myAccounts = new Set(mine.map((a) => a.account));
  const risks = staticRisks(ixs, owner, myAccounts);
  // the accounts to watch: the wallet and the transaction's writable accounts (its token accounts, new ones too). An
  // account the transaction doesn't name can't change; and the node refuses more accounts than the transaction has.
  const inTx = messageAccounts(tx.msg, tables);
  const writable = inTx.filter((a) => a.writable && a.pubkey).map((a) => a.pubkey);
  const watch = [...new Set([owner, ...writable])].slice(0, inTx.length);
  const [before, beforeData, sim] = await Promise.all([
    solBalance(chain, owner).catch(() => null),
    multipleAccounts(chain, watch).catch(() => null),
    simulate(chain, bytes, { accounts: watch }).catch((e) => ({ err: e.message, logs: e.data?.logs || [] })),
  ]);
  let sol = null;
  const deltas = new Map(); // mint -> bigint
  if (!sim.err && sim.accounts) {
    const after = sim.accounts.map((a) => (a ? { lamports: BigInt(a.lamports), owner: a.owner, data: Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0)) } : null));
    if (before != null && after[0]) sol = after[0].lamports - before;
    if (after[0] && after[0].owner !== PROGRAMS.system && beforeData?.[0]?.owner === PROGRAMS.system) risks.push({ level: 'danger', key: 'assign', vars: { program: programName(after[0].owner) || after[0].owner } });
    watch.forEach((addr, i) => {
      if (i === 0) return;
      const pre = beforeData?.[i] && isToken(beforeData[i].owner) ? readTokenAccount(beforeData[i].data) : null;
      const post = after[i] && isToken(after[i].owner) ? readTokenAccount(after[i].data) : null;
      const wasMine = pre?.owner === owner, isMine = post?.owner === owner;
      if (wasMine && post && !isMine) risks.push({ level: 'danger', key: 'tokenOwner', vars: { to: post.owner } });
      if (!wasMine && !isMine) return;
      const mint = (post || pre).mint;
      const d = (isMine ? post.amount : 0n) - (wasMine ? pre.amount : 0n);
      if (d !== 0n) deltas.set(mint, (deltas.get(mint) || 0n) + d);
    });
  }
  // the network the site names must be the transaction's: a mainnet transaction presented as devnet (where the
  // simulation fails and the money has no value) would be signed and then sent on mainnet
  if (!risks.some((r) => r.key === 'nonce')) {
    const valid = (c) => rpc(c, 'isBlockhashValid', [tx.msg.recentBlockhash, { commitment: 'confirmed' }]).then((r) => !!r.value).catch(() => null);
    const other = Object.values(SOL_CHAINS).find((c) => c.id !== chain.id);
    if (other && (await valid(chain)) === false && (await valid(other)) === true) risks.push({ level: 'danger', key: 'wrongNetwork', vars: { network: other.name, declared: chain.name } });
  }
  const metas = deltas.size ? await tokenMetas(chain, [...deltas.keys()]).catch(() => new Map()) : new Map();
  const decimalsOf = (m) => metas.get(m)?.decimals ?? mine.find((a) => a.mint === m)?.decimals ?? 0;
  return {
    version: tx.msg.version, signers: tx.msg.header.signatures,
    instructions: ixs.map((ix) => ({ ...ix, program: programName(ix.programId), known: describeIx(ix) })),
    risks: risks.filter((r, i) => risks.findIndex((x) => x.key === r.key) === i),
    sim: { ok: !sim.err, err: sim.err || null, logs: sim.logs || [], units: sim.unitsConsumed || 0 },
    sol, tokens: [...deltas].map(([mint, delta]) => ({ mint, delta, decimals: decimalsOf(mint), symbol: metas.get(mint)?.symbol || shortMint(mint), icon: metas.get(mint)?.icon || '', known: !!metas.get(mint)?.known })),
  };
}

/**
 * Is a message (bytes) really a transaction in disguise? Signing a transaction's message signs the transaction: a
 * "sign this text" whose bytes read as one would authorise a payment.
 */
export function looksLikeTransaction(bytes) {
  try { parseMessage(bytes); return true; } catch { /* not a message */ }
  try { parseTransaction(bytes); return true; } catch { return false; }
}
