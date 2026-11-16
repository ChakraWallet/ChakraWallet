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

// links and bait words in the names. Lighter than the tokens' check: emoji and non-Latin names are normal for NFTs.
const SPAM_RE = /(https?:|www\.|\.(com|io|net|org|xyz|site|website|online|app|finance|top|live|vip|cc|gift|claim|link|club|info|lat|icu)\b|\bclaim|reward|airdrop|voucher|visit\b|\$\s?\d)/i;
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;
// famous names that airdropped fakes borrow (the real collections have thousands of holders)
const BRANDS = /\b(bayc|bored ape|mutant ape|otherside|cryptopunks?|azuki|doodles|pudgy|moonbirds|nike|adidas|apple|disney|nintendo|playstation|patek|rolex|hublot|cartier|mercedes|bmw|ferrari|lamborghini|porsche|gucci|louis vuitton|prada|chanel|elon musk|tesla|coca[- ]?cola|starbucks|nba|fifa|uefa|opensea|uniswap|metamask|binance|coinbase|tether|usdt|usdc)\b/i;
const FEW_HOLDERS = 100;
/** A fake of a famous collection: its name, and (when the indexer says) few holders. */
export const fakeBrand = (collection, holders) => BRANDS.test(collection || '') && (holders == null || Number(holders) < FEW_HOLDERS);
/** Spam by the names (links, "claim", "reward"…, invisible characters). */
export const spamNft = (name, collection) => { const s = `${name || ''} ${collection || ''}`; return SPAM_RE.test(s) || INVISIBLE.test(s); };

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
