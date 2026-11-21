// WalletConnect links: the pairing URI a dapp shows (QR code, "copy link"), and the links that bring Chakra up.
// Spec: github.com/WalletConnect/walletconnect-specs (docs/specs/clients/core/pairing/pairing-uri.md, EIP-1328).
//   wc:<topic>@2?symKey=<hex>&relay-protocol=irn[&expiryTimestamp=<s>][&methods=...]
// Chakra's own scheme, chakra-wc:// (Chakra only, where `wc:` may ask which wallet):
//   chakra-wc://wc?uri=<the pairing URI, encoded>   a connection
//   chakra-wc://[wc?requestId=…&sessionTopic=…]     a dapp brings Chakra up for a request already on its way

const HEX32 = /^[0-9a-f]{64}$/i;
export const isHex32 = (s) => HEX32.test(String(s || ''));

/**
 * The pairing URI in a text -> { kind: 'pair', topic, symKey, relay: { protocol, data? }, expiry (s, or 0), methods }
 * | { kind: 'open' } (a Chakra link without a pairing: the dapp only brings the app up)
 * | { kind: 'bad', reason: 'version' (WalletConnect 1, switched off in 2023) | 'topic' | 'key' | 'relay' }
 * | null (not a WalletConnect link).
 */
export function parseWcLink(text) {
  const s = String(text || '').trim();
  if (/^chakra-wc:/i.test(s)) {
    const q = s.indexOf('?');
    const uri = q >= 0 ? new URLSearchParams(s.slice(q + 1).split('#')[0]).get('uri') : null;
    return uri ? parsePairingUri(uri) || { kind: 'bad', reason: 'topic' } : { kind: 'open' };
  }
  return parsePairingUri(s);
}

/** A `wc:` pairing URI (see parseWcLink), or null if the text isn't one. */
export function parsePairingUri(text) {
  const m = /^wc:(?:\/\/)?([^@?#]+)(?:@(\d+))?(?:\?([^#]*))?/i.exec(String(text || '').trim());
  if (!m) return null;
  const [, topic, version, query = ''] = m;
  if (version !== '2') return { kind: 'bad', reason: 'version' };
  const q = new URLSearchParams(query);
  if (!isHex32(topic)) return { kind: 'bad', reason: 'topic' };
  const symKey = q.get('symKey') || '';
  if (!isHex32(symKey)) return { kind: 'bad', reason: 'key' };
  const protocol = q.get('relay-protocol') || 'irn';
  if (protocol !== 'irn') return { kind: 'bad', reason: 'relay' };
  const data = q.get('relay-data');
  const expiry = /^\d{1,12}$/.test(q.get('expiryTimestamp') || '') ? Number(q.get('expiryTimestamp')) : 0;
  return {
    kind: 'pair', topic: topic.toLowerCase(), symKey: symKey.toLowerCase(),
    relay: data ? { protocol, data } : { protocol }, expiry, methods: q.get('methods') || '',
  };
}
