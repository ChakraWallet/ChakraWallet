// Demo replacement of src/shared/history.js: invented transactions, classified by the real code.
export * from '../../../src/shared/history.js';
import { classify } from '../../../src/shared/history.js';
import { PEERS } from './data.js';

const H = 3600e3, D = 24 * H;
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
const hash = () => '0x' + Array.from({ length: 64 }, () => (rnd() >> 8 & 15).toString(16)).join('');
const wei = (eth) => (BigInt(Math.round(eth * 1e8)) * 10n ** 10n).toString();
const units = (x, d) => (BigInt(Math.round(x * 1e6)) * 10n ** BigInt(d - 6)).toString();
const USDC = { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, name: 'USD Coin', icon: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png' };
const LINK = { token: '0x514910771af9ca656af840dff83e8264ecf986ca', symbol: 'LINK', decimals: 18, name: 'Chainlink', icon: 'https://assets.coingecko.com/coins/images/877/small/chainlink-new-logo.png' };

function records(me) {
  // from two days ago: the app labels "today" / "yesterday" groups in Italian only (src/shared/format.js)
  const d = new Date(); d.setDate(d.getDate() - 2); d.setHours(19, 40, 0, 0);
  const now = d.getTime();
  const tx = (o) => ({ hash: hash(), transfers: [], value: '0', fee: wei(0.00042), status: 'ok', isTx: true, ...o });
  return [
    tx({ time: now - 1.2 * H, from: PEERS.alice, to: me, value: wei(0.25), fee: wei(0.00031) }),
    tx({ time: now - 5.5 * H, from: me, to: PEERS.kyber, value: wei(0.5), method: 'swap', fee: wei(0.00118),
      transfers: [{ ...USDC, from: PEERS.kyber, to: me, amount: units(1702.4, 6) }] }),
    tx({ time: now - 1 * D - 2 * H, from: me, to: PEERS.shop, transfers: [{ ...USDC, from: me, to: PEERS.shop, amount: units(149.9, 6) }], method: 'transfer', fee: wei(0.00036) }),
    tx({ time: now - 1 * D - 7 * H, from: PEERS.bob, to: me, transfers: [{ ...LINK, from: PEERS.bob, to: me, amount: units(40, 18) }], method: 'transfer' }),
    tx({ time: now - 3 * D - 1 * H, from: me, to: PEERS.bob, value: wei(0.12), fee: wei(0.00027) }),
    tx({ time: now - 3 * D - 4 * H, from: me, to: USDC.token, method: 'approve', fee: wei(0.00021) }),
    tx({ time: now - 6 * D, from: PEERS.alice, to: me, transfers: [{ ...USDC, from: PEERS.alice, to: me, amount: units(2500, 6) }], method: 'transfer' }),
    tx({ time: now - 9 * D, from: me, to: PEERS.alice, value: wei(1.05), fee: wei(0.00052) }),
  ];
}

// Linea: MetaMask Card payments (sent by the card's relayer, recognised as shared/mmcard.js does) and a top-up
const LUSDC = { token: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', symbol: 'USDC', decimals: 6, name: 'USD Coin', icon: USDC.icon };
const MUSD = { token: '0xaca92e438df0b2401ff60da7e4337b687a2435da', symbol: 'mUSD', decimals: 6, name: 'MetaMask USD', icon: 'https://assets.coingecko.com/coins/images/68451/small/MetaMask-mUSD-Icon-200x200.png' };
const SETTLE = '0x8dfe562cbb4e93d5029f39da26bb6b501a8d1d3e';
function cardRecords(me) {
  const d = new Date(); d.setDate(d.getDate() - 2); d.setHours(20, 10, 0, 0);
  const now = d.getTime();
  const pay = (time, tk, amount) => ({ hash: hash(), time, from: '0x88db0d1d188b0ab2ee30a7ebe2a6e64ba0152059', to: '0x9dd23a4a0845f10d65d293776b792af1131c7b30',
    value: '0', fee: null, status: 'ok', card: 'spend', transfers: [{ ...tk, from: me, to: SETTLE, amount: units(amount, 6) }] });
  return [
    pay(now - 0.4 * H, LUSDC, 4.8), pay(now - 3.1 * H, LUSDC, 38.65), pay(now - 1 * D - 1 * H, MUSD, 12.4),
    pay(now - 1 * D - 9 * H, LUSDC, 64.2), pay(now - 2 * D - 4 * H, LUSDC, 2.95), pay(now - 4 * D, MUSD, 119),
    { hash: hash(), time: now - 5 * D, from: PEERS.relay, to: me, value: '0', fee: null, status: 'ok', isTx: true,
      transfers: [{ ...LUSDC, from: PEERS.relay, to: me, amount: units(1500, 6) }], method: 'transfer' },
  ];
}

export async function loadHistory(chain, address, cursor) {
  await new Promise((r) => setTimeout(r, 120));
  if (cursor) return { items: [], next: null, error: null, unsupported: false };
  const me = address.toLowerCase();
  const items = (chain.id === 59144 ? cardRecords(me) : records(me)).map((r) => classify(r, me, chain)).sort((a, b) => b.time - a.time);
  return { items, next: null, error: null, unsupported: false };
}
