// A simulated Bitcoin network for the tests: mempool.space's Esplora API (addresses, coins, transactions, fees,
// replacements, broadcasting), UniSat's indexer (runes, inscriptions) and DefiLlama's price.
import { readTx } from '../../src/shared/btc/build.js';
import { scriptAddress } from '../../src/shared/btc/keys.js';

const NET = { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 };

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const text = (v, status = 200) => new Response(String(v), { status, headers: { 'content-type': 'text/plain' } });

/**
 * net: { utxos: { [address]: [{ txid, vout, value, confirmed }] }, used: { [address]: n transactions },
 *        txs: { [txid]: Esplora transaction }, addrTxs: { [address]: [txid] }, hex: { [txid]: raw }, rbf: { [txid]: by },
 *        runes: { [address]: [{ runeid, rune, spacedRune, amount, divisibility, symbol }] },
 *        runeUtxos: { [address]: { [runeid]: [{ txid, vout, satoshi, runes: [{ runeid, amount }] }] } },
 *        inscriptions: { [address]: [{ txid, vout, satoshi, inscriptions: [{ inscriptionId, inscriptionNumber, offset }] }] },
 *        fees: { fastestFee, halfHourFee, hourFee, minimumFee }, price, refuseBroadcast }
 * -> { fetch, broadcasts: [hex], calls: [url] }
 */
export function bitcoinNet(net) {
  const broadcasts = [], calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    if (u.host === 'coins.llama.fi') return json({ coins: { 'coingecko:bitcoin': { price: net.price ?? 100000, confidence: 0.99 } } });
    if (u.host.includes('unisat')) {
      if (u.host === 'open-api.unisat.io' && !init.headers?.authorization) return json({ code: -2004, msg: 'exceeded the request limit for unauthenticated requests', data: null }, 403);
      let m;
      const ok = (data) => json({ code: 0, msg: 'ok', data });
      if ((m = /\/address\/([^/]+)\/runes\/balance-list$/.exec(u.pathname))) { const d = net.runes?.[m[1]] || []; return ok({ detail: d, total: d.length }); }
      if ((m = /\/address\/([^/]+)\/runes\/([^/]+)\/utxo$/.exec(u.pathname))) { const d = net.runeUtxos?.[m[1]]?.[m[2]] || []; return ok({ utxo: d, total: d.length }); }
      if ((m = /\/address\/([^/]+)\/inscription-utxo-data$/.exec(u.pathname))) { const d = net.inscriptions?.[m[1]] || []; return ok({ utxo: d, total: d.length }); }
      if ((m = /\/address\/([^/]+)\/inscription-data$/.exec(u.pathname))) {
        const d = (net.inscriptions?.[m[1]] || []).flatMap((x) => x.inscriptions.map((i) => ({ ...i, contentType: 'image/png', contentLength: 100, timestamp: 1 })));
        return ok({ inscription: d, total: d.length });
      }
      if (/\/brc20\/summary$/.test(u.pathname)) return ok({ detail: [], total: 0 });
      return json({ code: -1, msg: 'not found' }, 404);
    }
    if (!u.host.includes('mempool.space') && !u.host.includes('blockstream.info')) return json({}, 404);
    const path = u.pathname.replace(/^\/(testnet4\/)?api/, '');
    let m;
    if (init.method === 'POST' && path === '/tx') {
      if (net.refuseBroadcast) return text(net.refuseBroadcast, 400);
      broadcasts.push(init.body);
      return text(accept(net, init.body));
    }
    if (path === '/v1/fees/recommended') return json(net.fees || { fastestFee: 20, halfHourFee: 10, hourFee: 5, economyFee: 2, minimumFee: 1 });
    if (path === '/blocks/tip/height') return text(900000);
    if ((m = /^\/address\/([^/]+)$/.exec(path))) {
      const list = net.utxos?.[m[1]] || [];
      const conf = list.filter((x) => x.confirmed !== false).reduce((s, x) => s + x.value, 0);
      const mem = list.filter((x) => x.confirmed === false).reduce((s, x) => s + x.value, 0);
      const n = net.used?.[m[1]] ?? (net.addrTxs?.[m[1]]?.length || list.length);
      return json({ address: m[1], chain_stats: { funded_txo_sum: conf, spent_txo_sum: 0, tx_count: n }, mempool_stats: { funded_txo_sum: mem, spent_txo_sum: 0, tx_count: 0 } });
    }
    if ((m = /^\/address\/([^/]+)\/utxo$/.exec(path))) {
      return json((net.utxos?.[m[1]] || []).map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, status: { confirmed: x.confirmed !== false, block_height: 1, block_time: 1794557759 } })));
    }
    if ((m = /^\/address\/([^/]+)\/txs$/.exec(path))) return json((net.addrTxs?.[m[1]] || []).map((id) => net.txs[id]));
    if (/^\/address\/[^/]+\/txs\/chain\//.test(path)) return json([]);
    if ((m = /^\/v1\/tx\/([0-9a-f]{64})\/rbf$/.exec(path))) return json(net.rbf?.[m[1]] ? { replacements: { tx: { txid: net.rbf[m[1]] }, replaces: [] }, replaces: [] } : { replacements: null, replaces: null });
    if ((m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path))) return net.hex?.[m[1]] ? text(net.hex[m[1]]) : text('not found', 404);
    if ((m = /^\/tx\/([0-9a-f]{64})\/status$/.exec(path))) return json(net.txs?.[m[1]]?.status || { confirmed: false });
    if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(path))) return net.txs?.[m[1]] ? json(net.txs[m[1]]) : text('Transaction not found', 404);
    return text('not found', 404);
  };
  return { fetch, broadcasts, calls };
}

/**
 * A broadcast transaction joins the mempool: its coins are spent, its outputs are new coins (unconfirmed); one that
 * spends the same coins as a transaction still waiting replaces it (the old one disappears, its replacement is known).
 */
function accept(net, hex) {
  const t = readTx(hex);
  net.utxos ||= {}; net.txs ||= {}; net.addrTxs ||= {}; net.rbf ||= {}; net.spent ||= {};
  const vin = [];
  for (const x of t.inputs) {
    const op = `${x.txid}:${x.vout}`;
    let prev = null;
    for (const [address, list] of Object.entries(net.utxos)) {
      const k = list.findIndex((u) => u.txid === x.txid && u.vout === x.vout);
      if (k >= 0) { prev = { address, value: list[k].value }; list.splice(k, 1); break; }
    }
    if (!prev && net.spent[op]) { // spent by a transaction still waiting: replaced
      const old = net.spent[op].by;
      prev = net.spent[op].prev;
      if (old !== t.txid && net.txs[old] && !net.txs[old].status.confirmed) {
        net.rbf[old] = t.txid;
        for (const list of Object.values(net.utxos)) for (let k = list.length - 1; k >= 0; k--) if (list[k].txid === old) list.splice(k, 1);
        delete net.txs[old];
        for (const a of Object.keys(net.addrTxs)) net.addrTxs[a] = net.addrTxs[a].filter((id) => id !== old);
      }
    }
    net.spent[op] = { by: t.txid, prev };
    vin.push({ txid: x.txid, vout: x.vout, address: prev?.address, value: prev?.value || 0 });
  }
  const vout = t.outputs.map((o) => ({ address: scriptAddress(o.script, NET), script: o.script, value: Number(o.value) }));
  const fee = vin.reduce((s, x) => s + x.value, 0) - vout.reduce((s, x) => s + x.value, 0);
  net.txs[t.txid] = esploraTx(t.txid, { vin, vout, confirmed: false, fee, weight: t.vsize * 4 });
  vout.forEach((o, i) => { if (o.address) (net.utxos[o.address] ||= []).push({ txid: t.txid, vout: i, value: o.value, confirmed: false }); });
  for (const a of new Set([...vin.map((x) => x.address), ...vout.map((x) => x.address)].filter(Boolean))) net.addrTxs[a] = [t.txid, ...(net.addrTxs[a] || [])];
  return t.txid;
}

/** An Esplora transaction: vin [{ address, value }], vout [{ address | script, value }]. */
export function esploraTx(txid, { vin = [], vout = [], confirmed = true, fee = 500, time = 1794557759, witness = [], weight = 600 }) {
  return {
    txid, fee, weight, status: confirmed ? { confirmed: true, block_time: time, block_height: 1 } : { confirmed: false },
    vin: vin.map((x, i) => ({ txid: x.txid || 'ee'.repeat(32), vout: x.vout ?? i, prevout: { scriptpubkey_address: x.address, value: x.value }, witness: x.witness || witness })),
    vout: vout.map((x) => ({ scriptpubkey_address: x.address, scriptpubkey: x.script || '0014' + '00'.repeat(20), value: x.value })),
  };
}
