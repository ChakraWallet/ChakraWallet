// A local Bitcoin network for the end-to-end tests: an Esplora-compatible HTTP API (the endpoints of mempool.space the
// app uses) over a UTXO set kept in memory. Transactions are checked like a node would: every coin spent must exist and
// be unspent, every signature must verify (SegWit v0 ECDSA over BIP143, Taproot key path Schnorr over BIP341), the
// fee must be at least 1 sat/vB; one that spends coins of a transaction still waiting replaces it only following
// BIP125 (more fee in total, a higher rate). Blocks are made on request (POST /mine).
//
// Funds: at start the wallet under test (the test phrase's first account, BIP84 and BIP86, coin type 1) receives
// 0.01 BTC on its first SegWit address and 0.005 BTC on its first Taproot address.
import http from 'node:http';
import crypto from 'node:crypto';
import * as btc from '@scure/btc-signer';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { seedOfPhrase, hdAccountPublic, branchAddress, scriptAddress, toHex, fromHex, decodeAddress } from '../../src/shared/btc/keys.js';
import { MNEMONIC } from './evm.mjs';

export const BTC_ID = -18444; // the local network's id in the app (regtest's port)
export const NET = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export async function startBtc({ port = 9400 } = {}) {
  const txs = new Map(); // txid -> { json, hex, vsize, fee, confirmed, time }
  const spentBy = new Map(); // outpoint -> txid
  let height = 100;
  const now = () => Math.floor(Date.now() / 1000);
  const outOf = (op) => { const [txid, vout] = op.split(':'); return txs.get(txid)?.json.vout[Number(vout)] || null; };

  /** A funding transaction (from outside the wallet): confirmed outputs to the given addresses. */
  function fund(list) {
    const txid = crypto.randomBytes(32).toString('hex');
    const vout = list.map(([address, value]) => ({ scriptpubkey: toHex(decodeAddress(address, NET).script), scriptpubkey_address: address, value }));
    txs.set(txid, { json: { txid, fee: 0, weight: 800, status: { confirmed: true, block_height: height, block_time: now() }, vin: [{ txid: '00'.repeat(32), vout: 0, prevout: null, witness: [] }], vout }, fee: 0, vsize: 200, confirmed: true });
    return txid;
  }
  const acc = hdAccountPublic(seedOfPhrase(MNEMONIC), 1, 0);
  const me = { segwit: branchAddress(acc.branches[0], 0, 0, NET), taproot: branchAddress(acc.branches[1], 0, 0, NET) };
  fund([[me.segwit, 1_000_000], [me.taproot, 500_000]]);

  const hash160 = (b) => ripemd160(sha256(b));
  /** Checks and adds a transaction; -> txid, or throws (the node's refusal). */
  function accept(hex) {
    const tx = btc.Transaction.fromRaw(fromHex(hex), { allowUnknownOutputs: true });
    const prevs = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const x = tx.getInput(i);
      const op = `${toHex(x.txid)}:${x.index}`;
      const prev = outOf(op);
      if (!prev) throw new Error('bad-txns-inputs-missingorspent');
      prevs.push({ op, script: fromHex(prev.scriptpubkey), value: BigInt(prev.value), address: prev.scriptpubkey_address });
    }
    // signatures
    for (let i = 0; i < tx.inputsLength; i++) {
      const w = tx.getInput(i).finalScriptWitness || [];
      const p = prevs[i];
      if (p.script.length === 22 && p.script[0] === 0x00) {
        const [sig, pub] = w;
        if (!sig || !pub || toHex(hash160(pub)) !== toHex(p.script.slice(2))) throw new Error('non-mandatory-script-verify-flag (wrong key)');
        const code = btc.OutScript.encode({ type: 'pkh', hash: p.script.slice(2) });
        const msg = tx.preimageWitnessV0(i, code, sig[sig.length - 1], p.value);
        if (!secp256k1.verify(sig.slice(0, -1), msg, pub, { lowS: true })) throw new Error('non-mandatory-script-verify-flag (Signature must be zero for failed CHECK(MULTI)SIG operation)');
      } else if (p.script.length === 34 && p.script[0] === 0x51) {
        const sig = w[0];
        if (!sig || (sig.length !== 64 && sig.length !== 65)) throw new Error('non-mandatory-script-verify-flag (Invalid Schnorr signature size)');
        const msg = tx.preimageWitnessV1(i, prevs.map((x) => x.script), sig.length === 65 ? sig[64] : btc.SigHash.DEFAULT, prevs.map((x) => x.value));
        if (!schnorr.verify(sig.slice(0, 64), msg, p.script.slice(2))) throw new Error('non-mandatory-script-verify-flag (Invalid Schnorr signature)');
      } else throw new Error('unsupported input type in the local network');
    }
    const inSum = prevs.reduce((s, x) => s + x.value, 0n);
    let outSum = 0n;
    const vout = [];
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      outSum += o.amount;
      vout.push({ scriptpubkey: toHex(o.script), scriptpubkey_address: scriptAddress(o.script, NET), value: Number(o.amount) });
    }
    const fee = inSum - outSum, vsize = tx.vsize;
    if (fee < BigInt(vsize)) throw new Error('min relay fee not met');
    // conflicts: replacement (BIP125) or refusal
    const conflicts = new Set(prevs.map((p) => spentBy.get(p.op)).filter(Boolean));
    for (const c of conflicts) {
      const old = txs.get(c);
      if (old.confirmed) throw new Error('bad-txns-inputs-missingorspent');
      if (fee < old.fee + BigInt(vsize) || Number(fee) / vsize <= Number(old.fee) / old.vsize) throw new Error(`insufficient fee, rejecting replacement ${c}`);
    }
    for (const c of conflicts) evict(c);
    const txid = tx.id;
    const json = { txid, fee: Number(fee), weight: vsize * 4, status: { confirmed: false }, vin: prevs.map((p, i) => ({ txid: p.op.split(':')[0], vout: Number(p.op.split(':')[1]), prevout: { scriptpubkey: toHex(p.script), scriptpubkey_address: p.address, value: Number(p.value) }, witness: (tx.getInput(i).finalScriptWitness || []).map(toHex) })), vout };
    txs.set(txid, { json, hex, fee, vsize, confirmed: false, time: now() });
    for (const p of prevs) spentBy.set(p.op, txid);
    return txid;
  }
  /** Drops a transaction still waiting (replaced): its coins are unspent again, its outputs gone. */
  function evict(txid) {
    const t = txs.get(txid);
    for (const v of t.json.vin) spentBy.delete(`${v.txid}:${v.vout}`);
    txs.delete(txid);
    for (const [op, by] of [...spentBy]) if (op.startsWith(`${txid}:`)) evict(by);
  }
  function mine() {
    height++;
    for (const t of txs.values()) if (!t.confirmed) { t.confirmed = true; t.json.status = { confirmed: true, block_height: height, block_time: now() }; }
  }

  const touches = (t, a) => t.json.vout.some((o) => o.scriptpubkey_address === a) || t.json.vin.some((v) => v.prevout?.scriptpubkey_address === a);
  function stats(a) {
    const s = { chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } };
    for (const t of txs.values()) {
      if (!touches(t, a)) continue;
      const k = t.confirmed ? s.chain_stats : s.mempool_stats;
      k.tx_count++;
      for (const o of t.json.vout) if (o.scriptpubkey_address === a) k.funded_txo_sum += o.value;
      for (const v of t.json.vin) if (v.prevout?.scriptpubkey_address === a) k.spent_txo_sum += v.prevout.value;
    }
    return { address: a, ...s };
  }
  function utxos(a) {
    const out = [];
    for (const t of txs.values()) t.json.vout.forEach((o, i) => { if (o.scriptpubkey_address === a && !spentBy.has(`${t.json.txid}:${i}`)) out.push({ txid: t.json.txid, vout: i, value: o.value, status: t.json.status }); });
    return out;
  }
  function addressTxs(a) {
    const list = [...txs.values()].filter((t) => touches(t, a));
    return [...list.filter((t) => !t.confirmed).reverse(), ...list.filter((t) => t.confirmed).reverse().slice(0, 25)].map((t) => t.json);
  }

  const server = http.createServer(async (q, r) => {
    const send = (code, body, type = 'application/json') => { r.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }); r.end(type === 'application/json' ? JSON.stringify(body) : String(body)); };
    if (q.method === 'OPTIONS') return send(204, '', 'text/plain');
    const u = new URL(q.url, 'http://x');
    const p = u.pathname.replace(/^\/api/, '');
    let body = '';
    for await (const c of q) body += c;
    let m;
    try {
      if (q.method === 'POST' && p === '/tx') return send(200, accept(body.trim()), 'text/plain');
      if (q.method === 'POST' && p === '/mine') { mine(); return send(200, { height }); }
      if (p === '/blocks/tip/height') return send(200, height, 'text/plain');
      if (p === '/e2e/mempool') return send(200, [...txs.values()].filter((t) => !t.confirmed).map((t) => t.json)); // the tests' view
      if (p === '/v1/fees/recommended') return send(200, { fastestFee: 12, halfHourFee: 6, hourFee: 3, economyFee: 2, minimumFee: 1 });
      if (p === '/fee-estimates') return send(200, { 1: 12, 3: 6, 6: 3, 144: 1 });
      if ((m = /^\/address\/([^/]+)$/.exec(p))) return send(200, stats(m[1]));
      if ((m = /^\/address\/([^/]+)\/utxo$/.exec(p))) return send(200, utxos(m[1]));
      if ((m = /^\/address\/([^/]+)\/txs$/.exec(p))) return send(200, addressTxs(m[1]));
      if (/^\/address\/[^/]+\/txs\/chain\//.test(p)) return send(200, []);
      if ((m = /^\/v1\/tx\/([0-9a-f]{64})\/rbf$/.exec(p))) return send(200, { replacements: null, replaces: null });
      if ((m = /^\/tx\/([0-9a-f]{64})\/status$/.exec(p))) return txs.has(m[1]) ? send(200, txs.get(m[1]).json.status) : send(404, 'Transaction not found', 'text/plain');
      if ((m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(p))) return txs.get(m[1])?.hex ? send(200, txs.get(m[1]).hex, 'text/plain') : send(404, 'Transaction not found', 'text/plain');
      if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(p))) return txs.has(m[1]) ? send(200, txs.get(m[1]).json) : send(404, 'Transaction not found', 'text/plain');
      return send(404, 'not found', 'text/plain');
    } catch (e) { return send(400, `sendrawtransaction RPC error: ${e.message}`, 'text/plain'); }
  });
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  const api = `http://127.0.0.1:${port}/api`;
  return {
    state: { id: BTC_ID, api, me },
    /** Test side: the transactions still waiting, the outputs of a transaction. */
    mempool: () => [...txs.values()].filter((t) => !t.confirmed).map((t) => t.json),
    stop: () => new Promise((res) => server.close(res)),
  };
}
