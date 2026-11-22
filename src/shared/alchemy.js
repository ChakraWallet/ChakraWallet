// Alchemy (an optional free key, Settings > Service keys): a node steadier and safer than the public ones, and an
// indexer of transfers and token balances. Each network must be switched on in the user's Alchemy app: when the key
// is saved Chakra asks every network once (checkAlchemy) and uses only those switched on.
// - transactions are sent through Alchemy first (on Ethereum after the private channel, when protection is on);
// - reads go to the public nodes first, to Alchemy when none of them answers;
// - history and tokens found automatically: from Alchemy when the network's usual service fails or isn't available.
// The key goes to Alchemy only. Both the background (sends) and the screens (reads) take it from the settings.

let cfg = { key: '', nets: {} };

/** The key from what was pasted: the key itself or a whole address (https://eth-mainnet.g.alchemy.com/v2/KEY). */
export const alchemyKeyOf = (v) => {
  const s = String(v || '').trim();
  const m = /\/v2\/([^/?#\s]+)/.exec(s);
  return m ? m[1] : s;
};

/** Takes the key and its networks from the settings (called wherever the settings are read). */
export function setAlchemy(settings) {
  cfg = { key: alchemyKeyOf(settings?.alchemyKey), nets: settings?.alchemyNets || {} };
}

export const alchemyNodeUrl = (slug, key) => `https://${slug}.g.alchemy.com/v2/${encodeURIComponent(key)}`;

/** Alchemy's address for a network, when there is a key and the network is switched on in its app; else null. */
export function alchemyUrl(chain) {
  if (!cfg.key || !chain?.alchemy || cfg.nets[chain.id]?.state !== 'on') return null;
  return alchemyNodeUrl(chain.alchemy, cfg.key);
}

/**
 * Which networks the key works on: { nets: { [chainId]: { state: 'on' | 'off' | 'error', link? } }, checked },
 * or { bad: true } when Alchemy doesn't know the key. 'off': not switched on in the app, `link` is the page of the
 * app where it is switched on (from Alchemy's own answer). 'error': no answer (offline, Alchemy busy...).
 */
export async function checkAlchemy(key, chains, { timeout = 15000 } = {}) {
  const nets = {};
  let bad = false;
  await Promise.all(chains.filter((c) => c.alchemy).map(async (c) => {
    try {
      // Solana: the network is recognised by its genesis block; Tron: its HTTP API answers the latest block
      const sol = c.kind === 'solana', tron = c.kind === 'tron';
      const res = await fetch(tron ? `${alchemyNodeUrl(c.alchemy, key)}/wallet/getnowblock` : alchemyNodeUrl(c.alchemy, key), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: tron ? '{}' : JSON.stringify({ jsonrpc: '2.0', id: 1, method: sol ? 'getGenesisHash' : 'eth_chainId', params: [] }), signal: AbortSignal.timeout(timeout),
      });
      const j = await res.json().catch(() => null);
      const msg = String(j?.error?.message || j?.error || j?.Error || '');
      if (tron && res.ok && j?.blockID) nets[c.id] = { state: 'on' };
      else if (res.ok && j?.result) nets[c.id] = { state: (sol ? j.result === c.genesis : Number(j.result) === Number(c.id)) ? 'on' : 'error' };
      else if (res.status === 401) bad = true;
      else if (/not enabled/i.test(msg)) {
        const link = (/https:\/\/dashboard\.alchemy\.com\/[^\s"']*/.exec(msg) || [])[0]?.replace(/[.,;)]+$/, '');
        nets[c.id] = { state: 'off', link: link || 'https://dashboard.alchemy.com/' };
      } else nets[c.id] = { state: 'error' };
    } catch { nets[c.id] = { state: 'error' }; }
  }));
  return bad ? { bad: true } : { nets, checked: Date.now() };
}
