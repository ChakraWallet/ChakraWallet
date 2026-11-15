// Simulated public services for the end-to-end tests, on one local HTTP server, answering in the formats the app reads:
//   /llama/...        prices and price history (DefiLlama)
//   /frankfurter/...  currency rates
//   /kyber/<net>/...  a swap aggregator (KyberSwap's format): quotes and transactions for the local DEX
//   /relay/...        a bridge (Relay's format): quote, status; a relayer pays on the destination network
//   /idx/<chainId>/api an Etherscan-compatible indexer built from the local node's blocks (history, token discovery)
// TON's services (TON Center, STON.fi, Omniston, the TON side of bridges) are added by ton.mjs through `extra`.
import http from 'node:http';
import { Interface, Contract, Wallet, NonceManager, HDNodeWallet, Mnemonic, id as keccakId, zeroPadValue, getAddress } from 'ethers';
import { MNEMONIC, providerOf } from './evm.mjs';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO = '0x0000000000000000000000000000000000000000';
const TRANSFER = keccakId('Transfer(address,address,uint256)');
const lc = (a) => String(a || '').toLowerCase();
export const PRICES = { 'coingecko:ethereum': 3000, 'coingecko:the-open-network': 3 };

/** Starts the services. evm: startEvm()'s result. Returns { url, port, close(), relayer, requests }. */
export async function startServices(evm, { port = 9100, extra = {} } = {}) {
  const nets = evm.networks;
  const byId = Object.fromEntries(nets.map((n) => [n.id, n]));
  const byKey = Object.fromEntries(nets.map((n) => [`local${n.key}`, n]));
  const dexIface = new Interface(nets.find((n) => n.dex).abi.dex);
  const bridgeIface = new Interface(nets[0].abi.bridge);
  const erc20 = new Interface(['function approve(address,uint256)', 'function symbol() view returns (string)', 'function name() view returns (string)', 'function decimals() view returns (uint8)']);
  const priceOf = (key) => {
    if (PRICES[key] != null) return PRICES[key];
    const [net, addr] = key.split(':');
    return nets.some((n) => `local${n.key}` === net && lc(n.usdc) === lc(addr)) ? 1 : extra.priceOf?.(key) ?? null;
  };

  // ---------------------------------------------------------------- bridge requests + relayer
  const requests = new Map(); // requestId -> { from net, to net | 'ton', token, amountOut, recipient, status, txHashes }
  let seq = 0;
  const relayer = {
    /** The destination side of a request: EVM -> EVM here; TON adds its own (extra.payTon). */
    async pay(req) {
      const dest = byId[req.toChainId];
      if (!dest) return extra.payOut?.(req);
      const w = new NonceManager(new Wallet(HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${evm.deployerIndex}`).privateKey, providerOf(dest)));
      const tx = req.toToken === ZERO
        ? await w.sendTransaction({ to: req.recipient, value: BigInt(req.amountOut) })
        : await new Contract(req.toToken, dest.abi.token, w).mint(req.recipient, BigInt(req.amountOut));
      await tx.wait();
      if (req.topupWei) await (await w.sendTransaction({ to: req.recipient, value: BigInt(req.topupWei) })).wait(); // gas on arrival (topupGas)
      return tx.hash;
    },
  };
  // watch the bridge contracts' Deposit events and pay on the other side
  const seen = new Set();
  const watch = setInterval(async () => {
    for (const n of nets) {
      try {
        const logs = await providerOf(n).getLogs({ address: n.bridge, fromBlock: 0, toBlock: 'latest' });
        for (const l of logs) {
          const key = `${n.id}:${l.transactionHash}:${l.index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const ev = bridgeIface.parseLog(l);
          const req = requests.get(ev.args.requestId);
          if (!req || req.status !== 'waiting') continue;
          req.status = 'pending'; req.txHashes = [l.transactionHash];
          relayer.pay(req).then((h) => { req.status = 'success'; if (h) req.txHashes.push(h); }).catch(() => { req.status = 'failure'; });
        }
      } catch { /* node stopping */ }
    }
  }, 300);

  // ---------------------------------------------------------------- indexer (Etherscan-compatible) from the node's blocks
  async function indexer(net, q) {
    const p = providerOf(net);
    const me = lc(q.get('address'));
    const action = q.get('action');
    const latest = await p.getBlockNumber();
    if (action === 'txlist') {
      const out = [];
      for (let b = latest; b >= 0 && out.length < 50; b--) {
        const block = await p.getBlock(b, true);
        for (const tx of block.prefetchedTransactions) {
          if (lc(tx.from) !== me && lc(tx.to) !== me) continue;
          const rc = await p.getTransactionReceipt(tx.hash);
          const sel = tx.data.slice(0, 10);
          out.push({
            hash: tx.hash, timeStamp: String(block.timestamp), from: lc(tx.from), to: lc(tx.to || ''), value: tx.value.toString(),
            gasUsed: rc.gasUsed.toString(), gasPrice: (rc.gasPrice ?? tx.gasPrice).toString(), isError: rc.status === 1 ? '0' : '1',
            txreceipt_status: String(rc.status), methodId: tx.data === '0x' ? '0x' : sel,
            functionName: sel === '0x095ea7b3' ? 'approve(address spender, uint256 amount)' : sel === '0xa9059cbb' ? 'transfer(address to, uint256 amount)' : '',
            contractAddress: lc(rc.contractAddress || ''),
          });
        }
      }
      return { status: out.length ? '1' : '0', message: out.length ? 'OK' : 'No transactions found', result: out };
    }
    if (action === 'tokentx') {
      const pad = zeroPadValue(me, 32);
      const logs = [
        ...await p.getLogs({ fromBlock: 0, toBlock: latest, topics: [TRANSFER, pad] }),
        ...await p.getLogs({ fromBlock: 0, toBlock: latest, topics: [TRANSFER, null, pad] }),
      ];
      const meta = {};
      const out = [];
      for (const l of logs) {
        if (l.topics.length !== 3) continue;
        const t = lc(l.address);
        if (!meta[t]) {
          const c = new Contract(t, erc20, p);
          meta[t] = { symbol: await c.symbol(), name: await c.name(), decimals: String(await c.decimals()) };
        }
        const block = await p.getBlock(l.blockNumber);
        out.push({
          hash: l.transactionHash, timeStamp: String(block.timestamp), from: lc('0x' + l.topics[1].slice(26)), to: lc('0x' + l.topics[2].slice(26)),
          contractAddress: t, tokenSymbol: meta[t].symbol, tokenName: meta[t].name, tokenDecimal: meta[t].decimals, value: BigInt(l.data).toString(),
        });
      }
      out.sort((a, b) => Number(b.timeStamp) - Number(a.timeStamp));
      return { status: out.length ? '1' : '0', message: out.length ? 'OK' : 'No transactions found', result: out };
    }
    return { status: '0', message: 'NOTOK', result: 'unsupported action' };
  }

  // ---------------------------------------------------------------- routes
  const routes = {
    async llama(parts, q) {
      if (parts[0] === 'prices') {
        const keys = decodeURIComponent(parts[2] || '').split(',');
        return { coins: Object.fromEntries(keys.filter((k) => priceOf(k) != null).map((k) => [k, { price: priceOf(k), confidence: 0.99 }])) };
      }
      if (parts[0] === 'chart') {
        const key = decodeURIComponent(parts[1]), base = priceOf(key) ?? 1, span = Number(q.get('span') || 24), start = Number(q.get('start'));
        return { coins: { [key]: { prices: Array.from({ length: span }, (_, i) => ({ timestamp: start + i * 3600, price: base * (1 + Math.sin(i / 4) * 0.01) })) } } };
      }
      return null;
    },
    frankfurter: async () => ({ base: 'USD', rates: { EUR: 0.92, GBP: 0.78, CHF: 0.88 } }),
    async kyber(parts, q, body) {
      const net = byKey[parts[0]];
      if (!net?.dex) return null;
      const dex = new Contract(net.dex, net.abi.dex, providerOf(net));
      if (parts[3] === 'routes') {
        const tin = lc(q.get('tokenIn')) === NATIVE ? ZERO : q.get('tokenIn'), tout = lc(q.get('tokenOut')) === NATIVE ? ZERO : q.get('tokenOut');
        const amountIn = BigInt(q.get('amountIn'));
        const out = await dex.quote(tin, tout, amountIn);
        if (!out) return { code: 4008, message: `route not found (${tin} -> ${tout}, ${amountIn})` };
        return { code: 0, data: { routeSummary: { tokenIn: tin, tokenOut: tout, amountIn: amountIn.toString(), amountOut: out.toString(), gas: '120000' }, routerAddress: net.dex } };
      }
      if (parts[3] === 'route' && parts[4] === 'build') {
        const s = body.routeSummary, minOut = (BigInt(s.amountOut) * BigInt(10000 - Number(body.slippageTolerance || 50))) / 10000n;
        const data = dexIface.encodeFunctionData('swap', [s.tokenIn, s.tokenOut, BigInt(s.amountIn), minOut, body.recipient]);
        return { code: 0, data: { routerAddress: net.dex, data, transactionValue: s.tokenIn === ZERO ? s.amountIn : '0' } };
      }
      return null;
    },
    async relay(parts, q, body) {
      if (parts[0] === 'quote') {
        const from = byId[body.originChainId], to = byId[body.destinationChainId];
        const handled = extra.relayQuote?.(body, { requests, relayer, nets: byId, newId: () => `0x${(++seq).toString(16).padStart(64, '0')}` });
        if (handled) return handled;
        const toTon = body.destinationChainId === 224235520 && extra.payOut; // EVM -> TON (ETH -> GRAM), paid by the TON side
        if (!from || (!to && !toTon)) return { message: 'unsupported route' };
        const native = lc(body.originCurrency) === ZERO;
        const token = native ? ZERO : getAddress(body.originCurrency);
        const amount = BigInt(body.amount);
        // to TON: ETH ($3,000) or USDC ($1) -> GRAM ($3); else a 0.2% fee
        const out = toTon ? (native ? (amount * 1000n) / 10n ** 9n : (amount * 10n ** 9n) / 3_000_000n) : (amount * 998n) / 1000n;
        const requestId = `0x${(++seq).toString(16).padStart(64, '0')}`;
        requests.set(requestId, { toChainId: toTon ? 'ton' : to.id, toToken: toTon || lc(body.destinationCurrency) === ZERO ? ZERO : to.usdc, amountOut: out.toString(), recipient: body.recipient, status: 'waiting' });
        const deposit = bridgeIface.encodeFunctionData('deposit', [requestId, token, amount, toTon ? body.destinationChainId : to.id, toTon ? ZERO : body.recipient]);
        return {
          steps: [
            ...(native ? [] : [{ id: 'approve', kind: 'transaction', items: [{ data: { to: token, data: erc20.encodeFunctionData('approve', [from.bridge, amount]), value: '0' } }] }]),
            { id: 'deposit', kind: 'transaction', requestId, items: [{ data: { to: from.bridge, data: deposit, value: native ? amount.toString() : '0' } }] },
          ],
          details: { timeEstimate: 5, currencyOut: { amount: out.toString(), minimumAmount: out.toString(), amountUsd: String(toTon ? Number(out) / 1e9 * 3 : Number(out) / (native ? 1e18 : 1e6) * (native ? 3000 : 1)) } },
          fees: { relayer: { amountUsd: '0.10' }, gas: { amountUsd: '0.01' } },
        };
      }
      if (parts[0] === 'intents' && parts[1] === 'status') {
        const r = requests.get(q.get('requestId'));
        return r ? { status: r.status === 'waiting' ? 'waiting' : r.status, txHashes: r.txHashes || [] } : { status: 'unknown' };
      }
      if (parts[0] === 'requests') return { requests: [] };
      return null;
    },
    async idx(parts, q) { const net = byId[Number(parts[0])]; return net ? indexer(net, q) : null; },
    ...extra.routes,
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const [svc, ...parts] = u.pathname.split('/').filter(Boolean);
    let body = null;
    if (req.method === 'POST') { const chunks = []; for await (const c of req) chunks.push(c); try { body = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch { body = null; } }
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const out = routes[svc] ? await routes[svc](parts, u.searchParams, body, req) : null;
      if (out == null) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"not found"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: e.message }));
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, port, requests, relayer, close: () => { clearInterval(watch); server.close(); } };
}
