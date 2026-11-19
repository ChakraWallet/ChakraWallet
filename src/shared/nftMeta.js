// NFT helpers without dependencies (imported by ton/api.js too, which loads early): media links and spam names.

/** A media/metadata link the app can load: https, ipfs:// (public gateway), ar://, data:image; else null. */
export function mediaUrl(uri) {
  const s = String(uri || '').trim();
  if (/^https:\/\//i.test(s)) return s;
  if (/^data:image\//i.test(s)) return s;
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(s);
  if (ipfs) return `https://ipfs.io/ipfs/${ipfs[1]}`;
  const ar = /^ar:\/\/(.+)$/i.exec(s);
  if (ar) return `https://arweave.net/${ar[1]}`;
  return null;
}

// Spam NFTs are airdropped to lure people to a site ("claim your reward at x.com", "$TOKEN voucher"). Lighter than the
// tokens' check where it must be: emoji and non-Latin names are normal for NFTs.
const LINK = /(https?:\/\/|www\.)/i;
const BAIT = /\b(claim|claimable|rewards?|bonus|airdrop|voucher|redeem|activate|eligible|giveaway|visit)\b/i;
const TICKER = /\$[A-Za-z]{2,}|\$\s?\d/; // "$PENGU", "$HMSTR", "$5000": a token or a sum promised in an NFT's name
const INVISIBLE = /[­​-‏‪-‮⁠-⁯﻿]/;
// fear instead of a gift: "your tokens compromised", "your wallet at risk, revoke the approvals at ..."
const SCARE = /\b(compromised|at risk|hacked|drained|exploit(?:ed|s)?|revoke|dangerous (?:token )?approvals?|security (?:alert|warning|check)|suspicious activity|urgent|verify your (?:wallet|account))\b/i;
// letters dressed up (𝗯𝗼𝗹𝗱, 𝘪𝘵𝘢𝘭𝘪𝘤, ｆｕｌｌｗｉｄｔｈ…) so filters miss the words: read as plain letters (NFKC), and a sign of spam with a link
const FANCY = /[\u{1D400}-\u{1D7FF}\uFF21-\uFF3A\uFF41-\uFF5A]/u;
const plain = (s) => String(s || '').normalize('NFKC');
// name services: their NFTs ARE domain names (vitalik.eth, alice.ton, x.wei...)
const NAME_TLDS = new Set(['eth', 'ton', 'wei', 'sol', 'bnb', 'base', 'arb', 'crypto', 'nft', 'x', 'polygon', 'lens', 'bit', 'dao', 'zil', 'blockchain', 'wallet', 'cb', 'id', 'avax', 'gno', 't']);
/** A web domain in a text (3eth.us, bonus-site.xyz), not a name-service name (vitalik.eth). */
export function hasDomain(s) {
  for (const m of String(s || '').matchAll(/\b[a-z0-9][a-z0-9-]*\.([a-z]{2,12})\b/gi)) if (!NAME_TLDS.has(m[1].toLowerCase())) return true;
  return false;
}
// famous names that airdropped fakes borrow (the real collections have thousands of holders)
const BRANDS = /\b(bayc|bored ape|mutant ape|otherside|cryptopunks?|azuki|doodles|pudgy|moonbirds|nike|adidas|apple|disney|nintendo|playstation|patek|rolex|hublot|cartier|mercedes|bmw|ferrari|lamborghini|porsche|gucci|louis vuitton|prada|chanel|elon musk|tesla|coca[- ]?cola|starbucks|nba|fifa|uefa|opensea|uniswap|metamask|binance|coinbase|tether|usdt|usdc)\b/i;
const FEW_HOLDERS = 100;
/** A fake of a famous collection: its name, and (when the indexer says) few holders. */
export const fakeBrand = (collection, holders) => BRANDS.test(collection || '') && (holders == null || Number(holders) < FEW_HOLDERS);
/**
 * Spam by its texts: a web domain, a link or a $TICKER in the name, collection or symbol; bait or scare words there;
 * invisible characters; a description that sends to a link with bait or scare words ("Activate voucher on the
 * website ...", "your tokens may be at risk ... go to https://..."), or dressed up in fancy letters. Fancy letters are
 * read as plain ones first.
 */
export function spamNft(name, collection, { symbol = '', description = '' } = {}) {
  const fancy = FANCY.test(`${name || ''} ${collection || ''} ${description || ''}`);
  name = plain(name); collection = plain(collection); symbol = plain(symbol); description = plain(description);
  const s = `${name || ''} ${collection || ''} ${symbol || ''}`;
  // a name that IS a domain is a domain-name NFT (vitalik.cloud): only a domain within other words lures to a site
  const domainName = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.[a-z]{2,12}$/i.test(String(name || '').trim());
  const named = `${domainName ? '' : name || ''} ${collection || ''} ${symbol || ''}`;
  if (LINK.test(s) || hasDomain(named) || TICKER.test(s) || BAIT.test(s) || SCARE.test(s) || INVISIBLE.test(s)) return true;
  const d = String(description || '');
  const sendsAway = LINK.test(d) || hasDomain(d) || /\bwebsite\b|\bsite\b/i.test(d);
  return sendsAway && (BAIT.test(d) || SCARE.test(d) || fancy);
}

/**
 * The traits of an NFT from its metadata (`attributes`, OpenSea-style): [{ trait, value }], at most 24. Dates
 * (display_type "date", seconds) become ISO dates; values are kept short.
 */
export function traitsOf(attributes) {
  if (!Array.isArray(attributes)) return [];
  const out = [];
  for (const a of attributes) {
    if (!a || typeof a !== 'object' || a.value == null || typeof a.value === 'object') continue;
    let value = a.display_type === 'date' && Number(a.value) > 0 ? new Date(Number(a.value) * (Number(a.value) < 1e12 ? 1000 : 1)).toISOString().slice(0, 10) : String(a.value);
    if (value.length > 60) value = `${value.slice(0, 57)}…`;
    out.push({ trait: String(a.trait_type ?? a.type ?? '').slice(0, 40), value });
    if (out.length === 24) break;
  }
  return out;
}
