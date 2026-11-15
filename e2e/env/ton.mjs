// A local TON network for the end-to-end tests: @ton/sandbox (the official emulator: real wallet and jetton contracts,
// real signature and seqno checks) behind a small TON Center v3-compatible HTTP API - the endpoints the app uses.
// Also the TON side of the simulated services: STON.fi assets, Omniston swaps (WebSocket), Relay bridges (GRAM).
//
// Funds: a "treasury" wallet pays the wallet under test at start (100 GRAM, wallet not deployed yet: the first send
// deploys it), holds the jettons, plays the DEX of the swaps and the relayer of the bridges.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Blockchain } from '@ton/sandbox';
import { Address, Cell, beginCell, toNano, storeMessage } from '@ton/core';
import { hdKeyPair, walletContract, commentCell, jettonTransferCell, readComment } from '../../src/shared/ton/core.js';
import { jettonDeploy, jettonMintBody } from '../../src/shared/ton/templates.js';
import { MNEMONIC } from './evm.mjs';

export const TON_ID = -5; // the local network's id in the app
export const RELAY_TON = 224235520; // TON's id at Relay (src/shared/ton/bridge.js)
const NS = 'stonfi.omni.v1beta8';
const GRAM_USD = 3, USDT_DEC = 6;
const OP = { excesses: 0xd53276db, transferNotification: 0x7362d09c, jettonTransfer: 0x0f8a7ea5 };
const raw = (a) => a.toRawString().toUpperCase();
const friendly = (a) => a.toString({ urlSafe: true, bounceable: false });
const b64 = (c) => c.toBoc().toString('base64');
const msgHash = (m) => beginCell().store(storeMessage(m)).endCell().hash().toString('base64');

export async function startTon({ port = 9300, wsPort = 9301 } = {}) {
  const bc = await Blockchain.create();
  const tick = () => { bc.now = Math.floor(Date.now() / 1000); };
  tick();
  const treasury = await bc.treasury('chakra-e2e', { balance: toNano('1000000') });
  const user = walletContract(hdKeyPair(MNEMONIC, 0).publicKey).address; // the wallet under test (the app derives the same)

  // ---------------------------------------------------------------- transactions, recorded for the history
  const txs = []; // { account (Address), tx }
  const byExtHash = new Map(); // external message hash (base64) -> transaction hash (base64)
  const record = (r) => { for (const tx of r.transactions) txs.push({ account: Address.parseRaw(`0:${tx.address.toString(16).padStart(64, '0')}`), tx }); return r; };
  const send = async (args) => { tick(); return record(await treasury.send(args)); };

  // ---------------------------------------------------------------- the jetton (a USD₮-like token, the standard contracts)
  const jetton = jettonDeploy({ admin: treasury.address, name: 'Tether USD', symbol: 'USD₮', decimals: USDT_DEC, supply: 10n ** 12n });
  await send({ to: jetton.address, value: toNano('0.5'), init: jetton.init, body: Cell.fromBase64(jetton.message.body), bounce: false });
  await send({ to: user, value: toNano('100'), bounce: false }); // 100 GRAM to the wallet under test (not deployed yet)
  await send({ to: jetton.address, value: toNano('0.2'), body: jettonMintBody({ to: user, amount: 500n * 10n ** 6n, response: treasury.address }) }); // 500 USD₮
  const walletOf = async (owner) => (await bc.runGetMethod(jetton.address, 'get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }])).stackReader.readAddress();
  const jettonBalance = async (owner) => {
    const w = await walletOf(owner);
    const c = await bc.getContract(w);
    return c.accountState?.type === 'active' ? (await bc.runGetMethod(w, 'get_wallet_data')).stackReader.readBigNumber() : 0n;
  };
  const treasuryJW = await walletOf(treasury.address);

  // ---------------------------------------------------------------- swaps (Omniston) and bridges (Relay): the treasury acts
  const quotes = new Map(); // quote id -> { from, to, inUnits, outUnits }
  const bridges = new Map(); // request id -> { onDeposit }
  /** After a message is processed: the treasury pays what swaps and bridges owe (marked by a comment). */
  async function settle(fromIndex) {
    for (const { account, tx } of txs.slice(fromIndex)) {
      if (!account.equals(treasury.address) || tx.inMessage?.info.type !== 'internal') continue;
      const body = tx.inMessage.body.beginParse();
      let text = null, sender = tx.inMessage.info.src;
      if (body.remainingBits >= 32) {
        const op = body.preloadUint(32);
        if (op === 0) text = readComment(tx.inMessage.body);
        if (op === OP.transferNotification) { // jettons arrived at the treasury's jetton wallet: its comment says why
          const s = tx.inMessage.body.beginParse(); s.loadUint(32); s.loadUintBig(64); s.loadCoins(); sender = s.loadAddress();
          const fwd = s.loadBit() ? s.loadRef() : s.asCell();
          text = readComment(fwd);
        }
      }
      const m = /^(swap|bridge):(.+)$/.exec(text || '');
      if (!m) continue;
      if (m[1] === 'swap') {
        const q = quotes.get(m[2]);
        if (!q || q.done) continue;
        q.done = true;
        if (q.to === 'USDT') await send({ to: treasuryJW, value: toNano('0.1'), body: jettonTransferCell({ amount: q.outUnits, to: sender, responseTo: treasury.address }) });
        else await send({ to: sender, value: q.outUnits, bounce: false });
      } else await bridges.get(m[2])?.onDeposit(tx.hash().toString('hex'));
    }
  }

  // ---------------------------------------------------------------- TON Center v3 (the endpoints the app calls)
  async function walletInformation(address) {
    tick();
    const c = await bc.getContract(address);
    const type = c.accountState?.type;
    const status = type === 'active' ? 'active' : c.balance > 0n ? 'uninit' : 'nonexist';
    const seqno = status === 'active' ? (await bc.runGetMethod(address, 'seqno').catch(() => null))?.stackReader.readNumber() ?? 0 : 0;
    return { balance: c.balance.toString(), status, seqno, wallet_type: 'wallet v5 r1' };
  }
  const book = (...as) => Object.fromEntries(as.filter(Boolean).map((a) => [raw(a), { user_friendly: friendly(a) }]));
  /** Actions of an account (newest first), from the recorded transactions: GRAM and jetton transfers. */
  async function actions(account) {
    const myJW = await walletOf(account);
    const out = [];
    for (const { account: acc, tx } of txs) {
      const time = String(tx.now), id = tx.hash().toString('base64'), ok = tx.description.type === 'generic' && !tx.description.aborted;
      const base = { action_id: `${id}:${out.length}`, trace_id: id, success: ok, start_utime: time, transactions: [id] };
      if (acc.equals(account) && tx.inMessage?.info.type === 'internal') { // incoming
        const info = tx.inMessage.info, s = tx.inMessage.body.beginParse();
        const op = s.remainingBits >= 32 ? s.preloadUint(32) : 0;
        if (op === OP.transferNotification) {
          s.loadUint(32); s.loadUintBig(64); const amount = s.loadCoins(); const from = s.loadAddress();
          out.push({ ...base, type: 'jetton_transfer', details: { sender: raw(from), receiver: raw(account), asset: raw(jetton.address), amount: amount.toString(), comment: null } });
        } else if (op === 0 && info.value.coins > 0n && !info.bounced) {
          out.push({ ...base, type: 'ton_transfer', details: { source: raw(info.src), destination: raw(account), value: info.value.coins.toString(), comment: readComment(tx.inMessage.body) } });
        }
      }
      if (acc.equals(account) && tx.inMessage?.info.type === 'external-in') { // sent by the wallet
        for (const m of tx.outMessages.values()) {
          const s = m.body.beginParse(), op = s.remainingBits >= 32 ? s.preloadUint(32) : 0;
          if (m.info.dest.equals(myJW) && op === OP.jettonTransfer) {
            s.loadUint(32); s.loadUintBig(64); const amount = s.loadCoins(); const to = s.loadAddress();
            out.push({ ...base, action_id: `${id}:j`, type: 'jetton_transfer', details: { sender: raw(account), receiver: raw(to), asset: raw(jetton.address), amount: amount.toString(), comment: null } });
          } else {
            out.push({ ...base, action_id: `${id}:t`, type: 'ton_transfer', details: { source: raw(account), destination: raw(m.info.dest), value: m.info.value.coins.toString(), comment: op === 0 ? readComment(m.body) : null } });
          }
        }
      }
    }
    out.sort((a, b) => Number(b.start_utime) - Number(a.start_utime));
    const meta = { [raw(jetton.address)]: { token_info: [{ type: 'jetton_masters', symbol: 'USD₮', name: 'Tether USD', extra: { decimals: String(USDT_DEC) } }] } };
    return { actions: out, address_book: book(account, treasury.address, user), metadata: meta, next_cursor: null };
  }

  const api = {
    walletInformation: (q) => walletInformation(Address.parse(q.get('address'))),
    addressInformation: async (q) => { const w = await walletInformation(Address.parse(q.get('address'))); return { status: w.status, balance: w.balance }; },
    'jetton/wallets': async (q) => {
      const owner = Address.parse(q.get('owner_address'));
      const bal = await jettonBalance(owner);
      return { jetton_wallets: bal > 0n ? [{ address: raw(await walletOf(owner)), jetton: raw(jetton.address), owner: raw(owner), balance: bal.toString() }] : [] };
    },
    metadata: async () => ({ [raw(jetton.address)]: { token_info: [{ type: 'jetton_masters', symbol: 'USD₮', name: 'Tether USD', extra: { decimals: String(USDT_DEC) } }] } }),
    estimateFee: async () => ({ source_fees: { in_fwd_fee: 1_500_000, storage_fee: 100_000, gas_fee: 2_900_000, fwd_fee: 400_000 }, destination_fees: [] }),
    message: async (q, body) => { // broadcast: the sandbox checks the signature and the seqno, as the network does
      tick();
      const cell = Cell.fromBase64(body.boc);
      const from = txs.length;
      const r = record(await bc.sendMessage(cell));
      const hash = cell.hash().toString('base64');
      if (r.transactions[0]) byExtHash.set(hash, r.transactions[0].hash().toString('base64'));
      await settle(from);
      return { message_hash: hash, message_hash_norm: hash };
    },
    transactionsByMessage: async (q) => { const h = byExtHash.get(q.get('msg_hash')); return { transactions: h ? [{ hash: h }] : [] }; },
    actions: (q) => actions(Address.parse(q.get('account'))),
    traces: async () => ({ traces: [] }),
  };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.pathname.replace(/^\/api\/v3\//, '');
    let body = null;
    if (req.method === 'POST') { const ch = []; for await (const c of req) ch.push(c); body = JSON.parse(Buffer.concat(ch).toString() || 'null'); }
    res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      if (!api[name]) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); return; }
      const out = await api[name](u.searchParams, body);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  // ---------------------------------------------------------------- Omniston (swaps): quotes and ready-made messages
  let qseq = 0;
  const wss = new WebSocketServer({ port: wsPort, host: '127.0.0.1' });
  wss.on('connection', (ws) => ws.on('message', async (data) => {
    const m = JSON.parse(String(data));
    if (m.method === `${NS}.QuoteRpc.Quote`) {
      const p = m.params, fromGram = !!p.input_asset.ton?.native, inUnits = BigInt(p.input_units);
      const outUnits = fromGram ? (inUnits * BigInt(GRAM_USD * 10 ** USDT_DEC)) / 10n ** 9n : (inUnits * 10n ** 9n) / BigInt(GRAM_USD * 10 ** USDT_DEC);
      const id = `q${++qseq}`;
      quotes.set(id, { to: fromGram ? 'USDT' : 'GRAM', inUnits, outUnits });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: 1 }));
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { subscription: 1, result: { quote_updated: { quote: {
        quote_id: id, input_units: String(inUnits), output_units: String(outUnits), gas_budget: '100000000', resolver_name: 'Omniston',
        swap: { min_output_amount: String(outUnits), price_impact_pips: 500, routes: [{ steps: [{ chunks: [{ protocol: 'StonFiV2' }] }] }] },
      } } } } }));
    } else if (m.method === `${NS}.TonRpc.BuildSwap`) {
      const q = quotes.get(m.params.quote_id), trader = Address.parse(m.params.transfer_src_address.ton);
      const messages = q.to === 'USDT'
        ? [{ target_address: friendly(treasury.address), send_amount: String(q.inUnits + toNano('0.1')), payload: commentCell(`swap:${m.params.quote_id}`).toBoc().toString('hex') }]
        : [{ target_address: friendly(await walletOf(trader)), send_amount: String(toNano('0.1')), payload: jettonTransferCell({ amount: q.inUnits, to: treasury.address, responseTo: trader, forwardAmount: toNano('0.01'), comment: `swap:${m.params.quote_id}` }).toBoc().toString('hex') }];
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { messages } }));
    } else if (m.id) ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: true }));
  }));

  // ---------------------------------------------------------------- the TON side of the simulated services (services.mjs `extra`)
  const services = {
    routes: {
      async ston(parts) { // STON.fi asset list: the jetton is known, $1
        const a = Address.parse(decodeURIComponent(parts[2] || ''));
        return a.equals(jetton.address) ? { asset: { dex_usd_price: '1', symbol: 'USD₮', display_name: 'Tether USD', decimals: USDT_DEC, image_url: null } } : null;
      },
    },
    priceOf: (key) => (key.startsWith('ton:') ? 1 : null),
    /** Relay, TON -> EVM (GRAM): a transfer to the treasury with the request in its comment; the relayer pays on the EVM side. */
    relayQuote(body, { requests, newId, relayer }) {
      if (body.originChainId !== RELAY_TON) return null;
      const amount = BigInt(body.amount), id = newId();
      const outWei = (amount * BigInt(GRAM_USD) * 10n ** 9n) / 3000n; // GRAM ($3) -> ETH ($3,000)
      const req = { toChainId: body.destinationChainId, toToken: '0x0000000000000000000000000000000000000000', amountOut: outWei.toString(), recipient: body.recipient, status: 'waiting' };
      requests.set(id, req);
      bridges.set(id, { onDeposit: async (hash) => { req.status = 'pending'; req.txHashes = [hash]; try { req.txHashes.push(await relayer.pay(req)); req.status = 'success'; } catch { req.status = 'failure'; } } });
      return {
        steps: [{ id: 'deposit', kind: 'transaction', requestId: id, items: [{ data: { messages: [{ to: friendly(treasury.address), value: String(amount + toNano('0.05')), bounce: false, mode: 1, body: b64(commentCell(`bridge:${id}`)) }] } }] }],
        details: { timeEstimate: 5, currencyOut: { amount: outWei.toString(), minimumAmount: outWei.toString(), amountUsd: String(Number(amount) / 1e9 * GRAM_USD) } },
        fees: { relayer: { amountUsd: '0.05' }, gas: { amountUsd: '0.01' } },
      };
    },
    /** Relay, EVM -> TON: the treasury pays the recipient in GRAM. */
    async payOut(req) { await send({ to: Address.parse(req.recipient), value: BigInt(req.amountOut), bounce: false }); return null; },
  };

  return {
    state: { id: TON_ID, api: `http://127.0.0.1:${port}`, user: friendly(user), jetton: jetton.address.toString({ urlSafe: true, bounceable: true }) },
    omniston: `ws://127.0.0.1:${wsPort}`,
    services,
    stop: () => { server.close(); wss.close(); },
  };
}
