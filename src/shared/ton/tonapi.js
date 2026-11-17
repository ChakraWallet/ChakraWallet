// TonAPI (tonapi.io): what TON Center doesn't give - the names of a contract's get methods (read from its code), the
// interfaces it implements, verified sources, jetton details, and the emulation of a message before it is signed.
// Free without a key; requests are queued about one per second. An optional key (Settings > Data) raises the limit.
// Only addresses and unsigned-by-the-user messages (signed with a throwaway key, see contracts.js) are sent.

const HOSTS = { [-239]: 'https://tonapi.io', [-3]: 'https://testnet.tonapi.io' };

let apiKey = '';
/** Optional TonAPI key (Settings > Data). */
export const setTonApiKey = (k) => { apiKey = String(k || '').trim(); };

const queue = { last: Promise.resolve(), at: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function slot() {
  const gap = apiKey ? 120 : 1050;
  const prev = queue.last;
  let release;
  queue.last = new Promise((r) => { release = r; });
  await prev;
  const wait = queue.at + gap - Date.now();
  if (wait > 0) await sleep(wait);
  queue.at = Date.now();
  release();
}

export class TonApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call(chain, path, { body, timeout = 25000 } = {}) {
  const host = chain.tonapi || HOSTS[chain.id];
  if (!host) throw new TonApiError('TonAPI: network', 0);
  for (let attempt = 0; ; attempt++) {
    await slot();
    let res;
    try {
      res = await fetch(host + path, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(timeout),
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      if (attempt < 2) continue;
      throw new TonApiError(`TonAPI: ${e.message}`, 0);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1300 * (attempt + 1)); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new TonApiError(json.error || `TonAPI ${res.status}`, res.status);
    return json;
  }
}

/** { status, balance (bigint), interfaces, name, isWallet, isScam, getMethods } */
export async function tonapiAccount(chain, address) {
  const r = await call(chain, `/v2/accounts/${encodeURIComponent(address)}`);
  return {
    status: r.status || 'nonexist', balance: BigInt(r.balance ?? 0), interfaces: r.interfaces || [], name: r.name || null,
    isWallet: !!r.is_wallet, isScam: !!r.is_scam, getMethods: r.get_methods || [],
  };
}

/**
 * Code of an active contract: { code (base64 BoC), codeHash (hex), methods: [{ id, name }], compiler, disassembled,
 * sources: [{ name, content, entry, std }] | null }. null when the address has no code.
 */
export async function tonapiInspect(chain, address) {
  try {
    const r = await call(chain, `/v2/blockchain/accounts/${encodeURIComponent(address)}/inspect`);
    return {
      code: r.code || null, codeHash: r.code_hash || null, compiler: r.compiler || null, disassembled: r.disassembled_code || null,
      methods: (r.methods || []).map((m) => ({ id: Number(m.id), name: m.method || null })),
      sources: r.source?.files?.length ? r.source.files.map((f) => ({ name: f.name, content: f.content || '', entry: !!f.is_entrypoint, std: !!f.is_std_lib })) : null,
    };
  } catch (e) {
    if (e.status === 404 || e.status === 400) return null;
    throw e;
  }
}

/** Jetton master: { name, symbol, decimals, image, description, mintable, totalSupply (bigint), admin (raw | null), holders, verification } */
export async function tonapiJetton(chain, master) {
  const r = await call(chain, `/v2/jettons/${encodeURIComponent(master)}`);
  const m = r.metadata || {};
  return {
    name: m.name || null, symbol: m.symbol || null, decimals: m.decimals != null ? Number(m.decimals) : 9, image: r.preview || m.image || null,
    description: m.description || null, mintable: !!r.mintable, totalSupply: BigInt(r.total_supply ?? 0), admin: r.admin?.address || null,
    holders: r.holders_count ?? null, verification: r.verification || null,
  };
}

/**
 * Resolves a TON DNS name (alice.ton, alice.t.me): { address (raw), name (TonAPI's name of the account, if any),
 * isWallet, scam } or null when the name doesn't exist or doesn't point to an address.
 */
export async function tonapiResolve(chain, domain) {
  let r;
  try { r = await call(chain, `/v2/dns/${encodeURIComponent(domain)}/resolve`); } catch (e) {
    if (e.status === 404 || /not resolved|not found/i.test(e.message)) return null;
    throw e;
  }
  const w = r?.wallet;
  if (!w?.address) return null;
  return { address: w.address, name: w.account?.name || null, isWallet: !!(w.account?.is_wallet ?? w.is_wallet), scam: !!w.account?.is_scam };
}

/**
 * Emulates a signed external message to a wallet on the current state of the chain (nothing is broadcast):
 * the TonAPI MessageConsequences object ({ trace, event, risk }).
 */
export const tonapiEmulate = (chain, boc) => call(chain, '/v2/wallet/emulate', { body: { boc }, timeout: 30000 });

/**
 * NFTs of an address as TonAPI knows them: { [raw address, upper case]: { trust, name, description, image, collection,
 * attributes } }. trust: 'whitelist' | 'none' | 'graylist' | 'blacklist' (TonAPI's scam list). image: TonAPI's cached
 * preview (the NFT's own link isn't opened).
 */
export async function tonapiNfts(chain, owner) {
  const r = await call(chain, `/v2/accounts/${encodeURIComponent(owner)}/nfts?limit=1000&indirect_ownership=false`);
  const out = {};
  for (const x of r.nft_items || []) {
    const pv = (x.previews || []).find((p) => p.resolution === '500x500') || (x.previews || [])[0];
    out[String(x.address).toUpperCase()] = {
      trust: x.trust || 'none', name: x.metadata?.name || null, description: x.metadata?.description || '',
      image: pv?.url || null, collection: x.collection?.name || null, attributes: x.metadata?.attributes || null,
    };
  }
  return out;
}
