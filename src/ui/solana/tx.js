// Solana transactions from the screens: estimate (simulation: the compute units it needs, whether it would fail),
// priority fee, then sign (background, after the password) and broadcast, with a fresh blockhash at that moment (a
// blockhash lasts about a minute: the review screen may stay open longer).
import { bg } from '../../shared/ext.js';
import { t } from '../../shared/i18n.js';
import { buildTransaction, computeBudget, PROGRAMS, parseTransaction, serializeTransaction, compileMessage, unsignedTransaction, signTransaction } from '../../shared/solana/tx.js';
import { latestBlockhash, simulate, priorityPrice, sendRaw, waitConfirmed, failReason, lookupTables as loadTables } from '../../shared/solana/api.js';
import { toBase64, fromBase64, addressBytes, concat } from '../../shared/solana/core.js';

export const BASE_FEE = 5000n; // lamports per signature
const MAX_UNITS = 1_400_000;
const PROBE_HASH = PROGRAMS.system; // any 32 bytes: the simulation replaces it

const writableOf = (ixs) => [...new Set(ixs.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey)))];
const budget = (limit, price) => [computeBudget.unitLimit(limit), computeBudget.unitPrice(price)];

/** A simulation's error, readable: known cases translated, else the program's own message. */
export function simText(err, logs = []) {
  const s = JSON.stringify(err || '') + ' ' + logs.join(' ');
  if (/AccountNotFound|no record of a prior credit/i.test(s)) return t('sol.err.noSol');
  if (/insufficient lamports|InsufficientFundsForFee|insufficient funds for fee/i.test(s)) return t('sol.err.noSolFee');
  if (/InsufficientFundsForRent|insufficient funds for rent/i.test(s)) return t('sol.err.rent');
  if (/custom program error: 0x1\b|insufficient funds/i.test(s)) return t('sol.err.noFunds');
  if (/BlockhashNotFound|expired/i.test(s)) return t('sol.err.expired');
  return t('sol.err.sim', { reason: failReason({ data: { err } }, logs).slice(0, 220) });
}

/**
 * Plans a transaction of instructions: simulated without a priority fee, to learn the compute units and whether it
 * would fail. -> { limit, price (micro-lamports per unit), fee (lamports), units, problem (text | null), logs, sim }
 * opts.signers: how many signatures it carries (5000 lamports each); opts.accounts: addresses whose state after the
 * transaction is wanted (sim.accounts).
 */
export async function plan(chain, { payer, instructions, lookupTables = null, signers = 1, accounts = null }) {
  // instructions that set their own compute budget (a service's) are simulated and priced as they are: a second
  // budget instruction would make the network refuse the transaction
  const own = ownBudget(instructions);
  if (own) {
    const sim = await simulate(chain, buildTransaction({ payer, recentBlockhash: PROBE_HASH, lookupTables, instructions }), { accounts })
      .catch((e) => ({ err: e.message, logs: e.data?.logs || [] }));
    const limit = own.limit ?? 200_000;
    const fee = BASE_FEE * BigInt(signers) + BigInt(Math.ceil((limit * (own.price || 0)) / 1e6));
    return { limit, price: own.price || 0, units: sim.unitsConsumed || 0, fee, own: true, problem: sim.err ? simText(sim.err, sim.logs || []) : null, logs: sim.logs || [], sim };
  }
  const probe = buildTransaction({ payer, recentBlockhash: PROBE_HASH, lookupTables, instructions: [...budget(MAX_UNITS, 0), ...instructions] });
  const [sim, price] = await Promise.all([
    simulate(chain, probe, { accounts }).catch((e) => ({ err: e.message, logs: e.data?.logs || [] })),
    priorityPrice(chain, writableOf(instructions)),
  ]);
  const units = sim.unitsConsumed || 0;
  const limit = units ? Math.min(MAX_UNITS, Math.ceil(units * 1.2) + 1000) : 200_000;
  const fee = BASE_FEE * BigInt(signers) + BigInt(Math.ceil((limit * price) / 1e6));
  return { limit, price, units, fee, problem: sim.err ? simText(sim.err, sim.logs || []) : null, logs: sim.logs || [], sim };
}

/** The compute budget a list of instructions sets itself: { limit, price } (either may be missing), or null. */
export function ownBudget(instructions) {
  const mine = instructions.filter((ix) => ix.programId === PROGRAMS.computeBudget);
  if (!mine.length) return null;
  const out = {};
  for (const ix of mine) {
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.length);
    if (ix.data[0] === 2 && ix.data.length >= 5) out.limit = dv.getUint32(1, true);
    if (ix.data[0] === 3 && ix.data.length >= 9) out.price = Number(dv.getBigUint64(1, true));
  }
  return out;
}

/** Readable reason of a refused broadcast. */
const sendText = (e) => (e?.data?.err || e?.data?.logs ? simText(e.data.err, e.data.logs || []) : e?.message || String(e));

/**
 * Builds (fresh blockhash), signs (the account's key in the background: auth(fn) asks the password once; extra keys,
 * e.g. a new account's, here) and broadcasts. -> { hash, wait: Promise<{ hash }> }
 */
export async function sendInstructions(chain, { account, payer, instructions, limit, price, lookupTables = null, extraSeeds = [], auth, title }) {
  const { blockhash, lastValidBlockHeight } = await latestBlockhash(chain);
  const all = ownBudget(instructions) ? instructions : [...budget(limit, price), ...instructions];
  let bytes = buildTransaction({ payer, recentBlockhash: blockhash, lookupTables, instructions: all });
  if (extraSeeds.length) bytes = signTransaction(bytes, extraSeeds).bytes;
  return signAndSend(chain, { account, bytes, lastValidBlockHeight, auth, title });
}

/**
 * Signs a ready transaction (wire bytes) with the account's key and broadcasts it. -> { hash, wait }
 * send(bytes): a channel of its own (e.g. Jito, MEV protection) -> the signature, or null to use the usual nodes.
 */
export async function signAndSend(chain, { account, bytes, lastValidBlockHeight = null, auth, title, send = null }) {
  const r = await auth((password) => bg('solanaSign', { from: account.address, txs: [toBase64(bytes)], password }), title);
  const signed = fromBase64(r.txs[0]);
  let hash, resend = null;
  try {
    hash = send ? await send(signed) : null;
    if (hash) resend = send;
    else hash = await sendRaw(chain, signed);
  } catch (e) { throw new Error(sendText(e)); }
  // rejects with code 'failed' (on chain, with the reason), 'expired' (never landed) or 'late' (no answer yet)
  const wait = waitConfirmed(chain, hash, { bytes: signed, lastValidBlockHeight, resend }).catch((e) => {
    const err = new Error(e.code === 'failed' ? simText(e.data?.err) : e.code === 'expired' ? t('sol.err.expired') : t('tx.late'));
    err.code = e.code === 'failed' || e.code === 'expired' ? e.code : 'late';
    throw err;
  });
  return { hash, wait };
}

/**
 * A transaction made by a service (swap, bridge): a version 0 or legacy message, unsigned. When the account is its
 * only signer, the blockhash is renewed (the service's may be about to expire); otherwise it's signed as it is.
 */
export async function freshen(chain, bytes) {
  const tx = parseTransaction(bytes);
  if (tx.msg.header.signatures !== 1) return { bytes, lastValidBlockHeight: null };
  const { blockhash, lastValidBlockHeight } = await latestBlockhash(chain);
  const m = tx.message;
  // the blockhash sits right after the static keys: find it by position
  const start = (tx.msg.version === 'legacy' ? 0 : 1) + 3;
  const nKeys = tx.msg.keys.length;
  const lenBytes = nKeys < 128 ? 1 : 2;
  const at = start + lenBytes + nKeys * 32;
  const out = concat([m.slice(0, at), addressBytes(blockhash), m.slice(at + 32)]);
  return { bytes: serializeTransaction(tx.signatures.map(() => new Uint8Array(64)), out), lastValidBlockHeight };
}

/** The accounts of a version 0 transaction's lookup tables, to read it ({ [table]: [addresses] }). */
export const tablesOf = (chain, msg) => loadTables(chain, msg.lookups.map((l) => l.key));

export { compileMessage, unsignedTransaction };
