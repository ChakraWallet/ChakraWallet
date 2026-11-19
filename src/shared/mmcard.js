// MetaMask Card compatibility (read-only view + spending limits), on Linea and Base: the card is a Mastercard by Baanx that spends the
// tokens of a self-custodial account. Nothing is moved to the card: the account allows a "FoxConnect" contract to take
// up to a limit (an ERC-20 approve), and at every payment a Baanx relayer calls that contract, which moves the amount
// from the account. So, on-chain and with no account at MetaMask or Baanx, we can see:
//   - whether the account is linked to a card (an allowance to FoxConnect above zero),
//   - how much the card can spend, token by token (the lower of balance and allowance),
//   - the payments (transactions sent to FoxConnect that move the account's tokens),
// and change the limits (approve). The card's own data (number, merchants, status, cashback) and switching on a token
// for the card are MetaMask's and Baanx's: they stay in the MetaMask app.
// Addresses: the configuration MetaMask publishes for its app (client-config.api.cx.metamask.io, "cardFeature"),
// copied here: nothing is asked to MetaMask at run time.
import { erc20, multiCall, rpc } from './rpc.js';

const lc = (a) => String(a || '').toLowerCase();

export const MMCARD = {
  59144: {
    // one contract for the cards issued in the US, one for the rest of the world
    spenders: { global: '0x9dd23a4a0845f10d65d293776b792af1131c7b30', us: '0xa90b298d05c2667ddc64e2a4e17111357c215dd2' },
    tokens: [ // the tokens the card spends on Linea (same addresses as shared/tokens.js)
      { address: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', symbol: 'USDC', decimals: 6 },
      { address: '0xa219439258ca9da29e9cc4ce5596924745e12b93', symbol: 'USDT', decimals: 6 },
      { address: '0xaca92e438df0b2401ff60da7e4337b687a2435da', symbol: 'mUSD', decimals: 6 },
      { address: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', symbol: 'WETH', decimals: 18 },
      { address: '0x3ff47c5bf409c86533fe1f4907524d304062428d', symbol: 'EURe', decimals: 18 },
      { address: '0x3bce82cf1a2bc357f956dd494713fe11dc54780f', symbol: 'GBPe', decimals: 18 },
    ],
  },
  8453: {
    // Base: one contract for every card, US and the rest of the world
    spenders: { global: '0xdabdafc43b2bc1c7d10c2bbce950a8cad4a367f8', us: '0xdabdafc43b2bc1c7d10c2bbce950a8cad4a367f8' },
    tokens: [ // the tokens the card spends on Base (same addresses as shared/tokens.js)
      { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
      { address: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', symbol: 'USDT', decimals: 6 },
      { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
      { address: '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', symbol: 'EURC', decimals: 6 },
    ],
  },
};
export const MMCARD_SITE = 'https://metamask.io/card';

export const cardConfig = (chain) => (chain && !chain.kind ? MMCARD[chain.id] || null : null);
/** One contract for every region (Base): the card's region can't be told, and doesn't matter. */
export const oneSpender = (cfg) => cfg.spenders.global === cfg.spenders.us;
const isSpender = (cfg, a) => Object.values(cfg.spenders).includes(lc(a));
const isCardToken = (cfg, a) => cfg.tokens.some((x) => x.address === lc(a));

/** An allowance this big is "no limit" (MetaMask sets about 2^41 whole tokens, others the uint256 maximum). */
export const UNLIMITED = 10n ** 30n;
export const isUnlimited = (allowance, decimals) => BigInt(allowance) >= UNLIMITED || BigInt(allowance) / 10n ** BigInt(decimals) >= 10n ** 12n;

/**
 * The card's state for an account: null on networks without the card, else
 * { linked, region: 'global'|'us'|null (null also where one contract serves every region), spender,
 *   tokens: [{ ...token, balance, allowance, spendable, active }] }, all amounts raw strings. One multicall (balance and
 * the allowance to each contract, per token).
 */
export async function cardStatus(chain, owner) {
  const cfg = cardConfig(chain);
  if (!cfg) return null;
  const { global, us } = cfg.spenders;
  const single = oneSpender(cfg), per = single ? 2 : 3;
  const calls = cfg.tokens.flatMap((x) => [
    { to: x.address, data: erc20.encodeFunctionData('balanceOf', [owner]) },
    { to: x.address, data: erc20.encodeFunctionData('allowance', [owner, global]) },
    ...(single ? [] : [{ to: x.address, data: erc20.encodeFunctionData('allowance', [owner, us]) }]),
  ]);
  const res = await multiCall(chain, calls);
  if (res.every((r) => r == null)) throw new Error(`${chain.name} RPC`);
  const big = (r) => (r && r !== '0x' ? BigInt(r.slice(0, 66)) : 0n);
  const rows = cfg.tokens.map((x, i) => ({ ...x, balance: big(res[i * per]), g: big(res[i * per + 1]), u: single ? 0n : big(res[i * per + 2]) }));
  // the account's card is the one with allowances (the other contract has none)
  const gSum = rows.reduce((s, r) => s + (r.g > 0n ? 1 : 0), 0), uSum = rows.reduce((s, r) => s + (r.u > 0n ? 1 : 0), 0);
  const region = gSum || uSum ? (uSum > gSum ? 'us' : 'global') : null;
  const spender = region === 'us' ? us : global;
  const tokens = rows.map((r) => {
    const allowance = region === 'us' ? r.u : r.g;
    const spendable = r.balance < allowance ? r.balance : allowance;
    return { address: r.address, symbol: r.symbol, decimals: r.decimals, balance: r.balance.toString(), allowance: allowance.toString(), spendable: spendable.toString(), active: allowance > 0n };
  });
  return { linked: !!region, region: single ? null : region, spender, tokens };
}

/** The approve that sets the card's limit on a token (0 = the card can no longer take it). */
export function limitTx(token, spender, amountRaw) {
  return { to: token.address, value: '0', data: erc20.encodeFunctionData('approve', [spender, BigInt(amountRaw)]) };
}

// ---------------------------------------------------------------- payments in the history
// A payment is a transaction sent by Baanx's relayer (not by the account) to FoxConnect: the indexers list it among
// the account's token transfers only, so the history would take it for a fake transfer (address poisoning). Its
// destination is asked to the network once per transaction and remembered. The address that receives the money
// changes over time: what tells a payment is FoxConnect as the transaction's destination.
const verdicts = new Map(); // `${chainId}:${hash}` -> Promise<boolean>

async function sentToCard(chain, cfg, hash) {
  const k = `${chain.id}:${lc(hash)}`;
  if (!verdicts.has(k)) {
    verdicts.set(k, rpc(chain, 'eth_getTransactionByHash', [hash]).then((tx) => !!tx && isSpender(cfg, tx.to)).catch(() => { verdicts.delete(k); return false; }));
  }
  return verdicts.get(k);
}

/**
 * Marks the history records that are card payments (r.card = 'spend') or money the card sent back to the account
 * (r.card = 'refund': from an address that received a payment, in a transaction sent to FoxConnect). Records the
 * account sent itself are never payments. Changes the records in place.
 */
export async function markCardRecords(chain, address, records) {
  const cfg = cardConfig(chain);
  if (!cfg) return records;
  const me = lc(address);
  const outs = records.filter((r) => !r.isTx && r.transfers.some((t) => t.from === me && isCardToken(cfg, t.token)));
  await Promise.all(outs.slice(0, 60).map(async (r) => { if (await sentToCard(chain, cfg, r.hash)) r.card = 'spend'; }));
  const payees = new Set(records.filter((r) => r.card === 'spend').flatMap((r) => r.transfers.filter((t) => t.from === me).map((t) => t.to)));
  const ins = records.filter((r) => !r.isTx && !r.card && r.transfers.some((t) => t.to === me && payees.has(t.from) && isCardToken(cfg, t.token)));
  await Promise.all(ins.slice(0, 20).map(async (r) => { if (await sentToCard(chain, cfg, r.hash)) r.card = 'refund'; }));
  return records;
}
