// Solana driver (Android app): the wallet screens' interface for Solana (src/ui/chains/driver.d.md) - balances and
// history in the shapes the EVM code produces, Solana Pay links, sends of SOL and tokens with a memo, .sol names,
// custom tokens, address-poisoning checks, NFTs (with a Helius or Alchemy key). Swaps and bridges: swap.js, bridge.js.
// Registered by src/mobile/solanaPlugin.js.
import { bg } from '../../shared/ext.js';
import { t, i18nError } from '../../shared/i18n.js';
import { NATIVE } from '../../shared/chains.js';
import { fmtNum } from '../../shared/format.js';
import { rememberRecipient, prefixLen, suffixLen } from '../../shared/poison.js';
import { mediaUrl, spamNft, traitsOf } from '../../shared/nftMeta.js';
import { isAddress, isOnCurve, sol } from '../../shared/solana/core.js';
import { system, token as tokenIx, memo as memoIx, createAtaIdempotent, ataAddress, PROGRAMS, isTokenProgram } from '../../shared/solana/tx.js';
import { accountInfo, rentExempt, solTokenUrl, rpc, heliusUrl } from '../../shared/solana/api.js';
import { alchemyUrl } from '../../shared/alchemy.js';
import { loadSolPortfolio, mintInfo } from '../../shared/solana/tokens.js';
import { loadSolHistory } from '../../shared/solana/history.js';
import { snsName, resolveSns } from '../../shared/solana/sns.js';
import { keylessNfts } from '../../shared/solana/nfts.js';
import { plan, sendInstructions } from './tx.js';

// ------------------------------------------------------------ addresses, links
/** Address poisoning on Solana: an address is its base58 text (case matters); scammers copy its first and last 4 characters. */
export const solPoisonKit = () => ({
  canonical: (a) => { const s = String(a || '').trim(); return isAddress(s) ? s : null; },
  display: (a) => a,
  lookalike: (a, b) => a !== b && prefixLen(a, b) >= 4 && suffixLen(a, b) >= 4,
  store: 'solRecipients',
});

/** raw integer -> decimal text without exponent ("1.5"), for Solana Pay amounts. */
export function rawToDecimal(raw, decimals) {
  const s = BigInt(raw).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}
/** decimal text -> raw integer (bigint), or null. */
export function decimalToRaw(text, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text || '').trim());
  if (!m || (m[2] || '').length > decimals) return null;
  return BigInt(m[1] + (m[2] || '').padEnd(decimals, '0'));
}

/**
 * A Solana Pay transfer link (solana:<recipient>?amount=1.5&spl-token=<mint>&memo=…&reference=…), or a bare address.
 * -> { address, amount (decimal text) | null, mint | null, memo, references: [] } or null. Transaction requests
 * (solana:https://…) aren't transfers: null.
 */
export function parseSolanaPay(text) {
  const s = String(text || '').trim();
  if (isAddress(s)) return { address: s, amount: null, mint: null, memo: '', references: [] };
  const m = /^solana:([1-9A-HJ-NP-Za-km-z]{32,44})(\?.*)?$/.exec(s);
  if (!m || !isAddress(m[1])) return null;
  const q = new URLSearchParams((m[2] || '').slice(1));
  const amount = q.get('amount');
  const mint = q.get('spl-token');
  if (mint && !isAddress(mint)) return null;
  return {
    address: m[1], amount: amount && /^\d+(\.\d+)?$/.test(amount) ? amount : null, mint: mint || null,
    memo: q.get('memo') || '', references: q.getAll('reference').filter(isAddress),
  };
}
let payRequest = null; // the last link scanned: its `reference` keys go with the transfer to that recipient

// ------------------------------------------------------------ send
const fixedFee = (chain, amount, extra = {}) => ({ kind: 'fixed', amount, decimals: 9, symbol: chain.native.symbol, unknownText: t('sol.send.feeUnknown'), ...extra });
const ACCOUNT_SPACE = 0; // a plain wallet: no data

/**
 * The transfer's instructions and its cost: { instructions, amount (what the recipient gets), fee, rent (a token
 * account opened for the recipient), plan, notes, problem, recipient }.
 */
export async function prepareSolSend(chain, { wallet, token, to, amountRaw, isMax, memo, portfolio }) {
  const me = wallet.raw;
  const native = !!token.native;
  const lamports = BigInt(portfolio?.native?.balance || 0);
  const text = String(memo || '').trim();
  const notes = [];
  let problem = null;
  const dest = await accountInfo(chain, to).catch(() => undefined);
  const refs = payRequest && payRequest.address === to && Date.now() - payRequest.at < 15 * 60e3 ? payRequest.references : [];
  const withRefs = (ix) => ({ ...ix, keys: [...ix.keys, ...refs.map((r) => ({ pubkey: r, isSigner: false, isWritable: false }))] });
  let instructions, rent = 0n;
  let amount = BigInt(amountRaw ?? 0);
  if (native) {
    if (dest && (dest.owner === PROGRAMS.token || dest.owner === PROGRAMS.token2022)) notes.push(t('sol.send.toTokenAccount'));
    const mk = (v) => [withRefs(system.transfer(me, to, v)), ...(text ? [memoIx(text, me)] : [])];
    // Max: simulated with the balance less a margin for the fee (a lamport would look short of a new account's rent)
    const PROBE_MARGIN = 1_000_000n;
    instructions = mk(isMax ? (lamports > PROBE_MARGIN ? lamports - PROBE_MARGIN : 1n) : amount);
    const p = await plan(chain, { payer: me, instructions });
    if (isMax) { amount = lamports > p.fee ? lamports - p.fee : 0n; instructions = mk(amount); }
    // a new account must receive at least its rent; the sender keeps either nothing or at least its own rent
    const minRent = await rentExempt(chain, ACCOUNT_SPACE).catch(() => 890_880n);
    if (dest === null && amount < minRent) problem = t('sol.send.belowRent', { amount: fmtNum(sol(minRent), 6), symbol: chain.native.symbol });
    const left = lamports - amount - p.fee;
    if (left < 0n) problem = t('sol.err.noSolFee');
    else if (!isMax && left > 0n && left < minRent) problem = t('sol.send.leaveRent', { amount: fmtNum(sol(minRent), 6), symbol: chain.native.symbol });
    if (!problem && p.problem) problem = p.problem;
    return { instructions, amount, fee: p.fee, rent, plan: p, notes, problem, recipient: to, text };
  }
  // a token: to the recipient's associated account (opened if missing, paid by the sender), or to the token account
  // pasted as recipient when it holds this very token
  const mint = token.address, program = token.program || PROGRAMS.token;
  let destination = ataAddress(to, mint, program), create = true;
  if (dest && isTokenProgram(dest.owner)) {
    // an account of a token program (either one): only this very token's account can receive it; a mint or another
    // token's account would get an associated account nobody can sign for
    const info = dest.owner === program ? (await rpc(chain, 'getAccountInfo', [to, { encoding: 'jsonParsed' }]).catch(() => null))?.value?.data?.parsed?.info : null;
    if (info?.mint !== mint) throw i18nError('sol.send.otherTokenAccount');
    destination = to; create = false;
  } else {
    if (dest && !isOnCurve(to) && dest.executable) throw i18nError('sol.send.toProgram');
    const ata = await accountInfo(chain, destination).catch(() => undefined);
    create = ata == null;
    if (create) {
      rent = await rentExempt(chain, program === PROGRAMS.token ? 165 : 170).catch(() => 2_039_280n);
      notes.push(t('sol.send.openAccount', { amount: fmtNum(sol(rent), 5), symbol: chain.native.symbol }));
    }
  }
  if (!token.account) throw i18nError('sol.send.noTokenAccount');
  // the amount from the token's accounts, the largest first (one transfer per account it takes from)
  const parts = token.parts || [{ account: token.account, amount: token.balance }];
  const transfers = [];
  let left = amount;
  for (const part of parts) {
    if (left <= 0n) break;
    const take = BigInt(part.amount) < left ? BigInt(part.amount) : left;
    transfers.push(tokenIx.transferChecked({ source: part.account, mint, destination, owner: me, amount: take, decimals: token.decimals, program }));
    left -= take;
  }
  if (!transfers.length || left > 0n) transfers.splice(0, transfers.length, tokenIx.transferChecked({ source: token.account, mint, destination, owner: me, amount, decimals: token.decimals, program }));
  instructions = [
    ...(create ? [createAtaIdempotent({ payer: me, owner: to, mint, program, ata: destination })] : []),
    ...transfers.map((ix, i) => (i === 0 ? withRefs(ix) : ix)),
    ...(text ? [memoIx(text, me)] : []),
  ];
  const p = await plan(chain, { payer: me, instructions });
  if (p.fee + rent > lamports) problem = t('sol.send.needSol', { amount: fmtNum(sol(p.fee + rent), 6), symbol: chain.native.symbol });
  else if (p.problem) problem = /transfer-hook|TransferHook|0x7dc|extra account/i.test(p.logs.join(' ')) ? t('sol.send.hook') : p.problem;
  return { instructions, amount, fee: p.fee, rent, plan: p, notes, problem, recipient: to, text };
}

// ------------------------------------------------------------ NFTs (DAS: Helius or Alchemy)
/** The node that answers DAS calls (getAssetsByOwner): Helius, else Alchemy; null without keys. */
export const dasUrl = (chain) => heliusUrl(chain) || alchemyUrl(chain);

/** DAS assets -> the shared NFT items (src/shared/nft.js). */
export function dasItems(assets) {
  return (assets || []).filter((a) => !a.burnt && a.interface !== 'FungibleToken' && a.interface !== 'FungibleAsset').map((a) => {
    const md = a.content?.metadata || {};
    const coll = (a.grouping || []).find((g) => g.group_key === 'collection');
    const collection = coll?.collection_metadata?.name || '';
    const files = a.content?.files || [];
    const image = mediaUrl(a.content?.links?.image) || mediaUrl(files.find((f) => /^image\//.test(f.mime || ''))?.uri) || mediaUrl(files[0]?.cdn_uri);
    const name = md.name || (collection ? `${collection}` : 'NFT');
    const compressed = !!a.compression?.compressed;
    return {
      key: a.id, address: a.id, contract: coll?.group_value || a.id, tokenId: a.id, name, collection, image, description: md.description || '',
      traits: traitsOf(md.attributes), standard: a.interface === 'MplCoreAsset' ? 'Metaplex Core' : compressed ? 'cNFT' : 'Metaplex',
      amount: String(a.token_info?.balance ?? 1),
      spam: spamNft(md.name, collection, { symbol: md.symbol, description: md.description }) || (compressed && !collection),
    };
  });
}

/** Without an indexer: the NFTs the node can read, and a word on the compressed ones (Helius key). */
const KEYLESS_NOTE = { key: 'sol.nft.keyless', keyField: 'heliusKey' };
async function keyless(chain, owner) {
  return { items: await keylessNfts(chain, owner), unsupported: false, note: KEYLESS_NOTE };
}

async function loadSolNfts(chain, owner) {
  const url = dasUrl(chain);
  if (!url) return keyless(chain, owner);
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetsByOwner', params: { ownerAddress: owner, page: 1, limit: 500, displayOptions: { showCollectionMetadata: true, showFungible: false } } }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.error) {
    // a node without DAS (e.g. an Alchemy app where it isn't on): what the node alone can read
    if (/method not found|not supported|-32601|not enabled/i.test(JSON.stringify(j?.error || ''))) return keyless(chain, owner);
    throw new Error(j?.error?.message || `DAS ${res.status}`);
  }
  return { items: dasItems(j.result?.items), unsupported: false };
}

// ------------------------------------------------------------ the driver (interface: src/ui/chains/driver.d.md)
export const solanaDriver = {
  kind: 'solana',
  features: {
    memo: true, // a memo with the transfer (some exchanges ask for it)
    customTokens: true, // tokens added by their mint address
    poisonCheck: true, // recipients checked against the history (address poisoning is common on Solana)
  },
  poisonKit: solPoisonKit,
  defaultChainId: -501, // where an account imported from another Solana app lives

  // ---------------------------------------------------------------- addresses
  async resolveAddresses(chain, accounts) {
    const map = await bg('solanaAccounts').catch(() => ({}));
    return Object.fromEntries(accounts.map((a) => [a.address, map[a.address] ? { address: map[a.address].address, raw: map[a.address].address } : null]));
  },
  validateAddress(chain, text, own) {
    const s = String(text || '').trim();
    if (!isAddress(s)) return { ok: false, error: 'sol.send.badAddress' };
    return { ok: true, normalized: s, toSelf: s === own, warnings: isOnCurve(s) ? [] : [{ key: 'sol.send.offCurve' }] };
  },
  addressPlaceholder: () => t('sol.send.placeholder'),
  tokenPlaceholder: () => t('sol.token.placeholder'),
  /** A .sol name typed as recipient (Solana Name Service). */
  isName: (chain, text) => !chain.testnet && !!snsName(text),
  async resolveName(chain, text) {
    const name = snsName(text);
    const address = name ? await resolveSns(chain, name).catch(() => null) : null;
    if (!address) throw i18nError('sol.name.notFound', { name: name || String(text).trim() });
    return { name, address, accountName: null, isWallet: isOnCurve(address), scam: false };
  },
  /** solana: links (Solana Pay): the amount in the token's units; tokens by their mint (spl-token). */
  paymentLink(chain, { address, token, amountRaw, ask }) {
    if (!ask) return address;
    const q = new URLSearchParams();
    const decimals = token?.native || !token ? chain.native.decimals : token.decimals;
    if (amountRaw != null && BigInt(amountRaw) > 0n) q.set('amount', rawToDecimal(amountRaw, decimals));
    if (token && !token.native && token.address !== NATIVE) q.set('spl-token', token.address);
    const qs = q.toString();
    return `solana:${address}${qs ? `?${qs}` : ''}`;
  },
  parseQr(chain, text) {
    const p = parseSolanaPay(text);
    if (!p) return null;
    payRequest = p.references.length ? { address: p.address, references: p.references, at: Date.now() } : null;
    const token = p.mint || (p.amount ? NATIVE : null);
    return {
      address: p.address, token, memo: p.memo,
      amountRaw: p.amount && !p.mint ? decimalToRaw(p.amount, chain.native.decimals) : null,
      amountText: p.amount && p.mint ? p.amount : null, // a token's amount: its decimals are known once the token is
    };
  },
  receiveTokens: (chain, held) => held,
  receiveNote: (chain) => ({ key: chain.testnet ? 'sol.receive.noteDevnet' : 'sol.receive.note' }),
  /** An account imported from another Solana app: its address is its id. */
  displayAddress: (account) => account.address,

  // ---------------------------------------------------------------- data
  loadPortfolio: (chain, raw, opts) => loadSolPortfolio(chain, raw, opts),
  loadHistory: (chain, raw, cursor) => loadSolHistory(chain, raw, cursor),
  priceKey: (chain, token) => (token.native ? chain.native.priceId ?? null : token.priceKey ?? null),
  explorerToken: (chain, address) => solTokenUrl(chain, address),
  loadNfts: (chain, raw) => loadSolNfts(chain, raw),
  explorerNft: (chain, nft) => solTokenUrl(chain, nft.address),
  tokenWarning: (chain, token) => (token.junk ? 'sol.token.junk' : !token.native && token.known === false && !chain.testnet ? 'sol.token.unknown' : null),
  isTokenAddress: (chain, text) => isAddress(String(text || '').trim()),
  /** The token of a mint address, as a custom token. */
  async tokenInfo(chain, address) {
    const m = await mintInfo(chain, String(address).trim()).catch(() => null);
    if (!m) throw i18nError('sol.token.notMint');
    return m;
  },
  homeNotice: (chain, p) => (chain.testnet && p && p.native?.balance === '0' ? 'sol.devnet.empty' : null),

  // ---------------------------------------------------------------- send
  async prepareSend(chain, { wallet, token, to, amountRaw, isMax, memo, portfolio }) {
    const r = await prepareSolSend(chain, { wallet, token, to, amountRaw, isMax, memo, portfolio });
    return {
      recipient: r.recipient, notes: r.notes,
      rows: r.text ? [{ k: t('send.memo'), v: `“${r.text}”` }] : [],
      amount: () => r.amount, problem: () => r.problem || null,
      fee: fixedFee(chain, r.fee, r.rent ? { extraRows: [{ k: t('sol.send.rentRow'), v: `${fmtNum(sol(r.rent), 6)} ${chain.native.symbol}` }] } : {}),
      _sol: r,
    };
  },
  async confirmSend(chain, review, { wallet, account, authorize }) {
    const r = review._sol;
    const sent = await sendInstructions(chain, {
      account, payer: wallet.raw, instructions: r.instructions, limit: r.plan.limit, price: r.plan.price,
      auth: (fn) => authorize(fn, t('send.confirmTitle')),
    });
    payRequest = null;
    rememberRecipient(r.recipient, solPoisonKit()).catch(() => {}); // a real recipient, for the poisoning check
    return sent;
  },
};
