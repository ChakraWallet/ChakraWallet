// WalletConnect Verify: which site a dapp's message really comes from. A dapp declares its own name and address
// (metadata.url), and anyone can declare anything; Verify is WalletConnect's service that sees the page that sent a
// message (an iframe of verify.walletconnect.org inside it) and signs what it saw: an attestation, a JWT (ES256) that
// travels with the message (relay field `attestation`), bound to it by its id = sha256 of the sealed message. Older
// dapps register the attestation on the server instead: it is asked by sha256 of the message's JSON.
// Result: { origin, validation: 'VALID' (the declared address is the real one) | 'INVALID' (it isn't) | 'UNKNOWN'
// (can't say: no attestation, service unreachable), isScam (a site WalletConnect lists as malicious) }.
import { jwtPayload, verifyEs256 } from './crypto.js';

/**
 * opts: { url (Verify server), fetchImpl, now() }. The server's public key is kept until it expires.
 */
export function verifier({ url, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let key = null; // { publicKey: JWK, expiresAt (s) }

  async function get(path) {
    const res = await fetchImpl(`${url}${path}`, { signal: AbortSignal.timeout(5000) });
    return res.status === 200 ? res.json() : null;
  }
  async function publicKey(fresh = false) {
    if (!fresh && key && key.expiresAt * 1000 > now()) return key;
    const k = await get('/v3/public-key').catch(() => null);
    if (k?.publicKey?.x && k?.publicKey?.y) key = k;
    return key;
  }
  /** The attestation's payload when its signature and expiry are right, else null. */
  async function checked(jwt) {
    for (const fresh of [false, true]) {
      const k = await publicKey(fresh);
      if (!k) return null;
      const p = verifyEs256(jwt, k.publicKey);
      if (p) return p.exp * 1000 > now() ? p : null;
    }
    return null;
  }

  /**
   * attestation: the relay's field (JWT or null); encryptedId: sha256 of the sealed message; hash: sha256 of the
   * message's JSON; declared: the address the dapp declares (metadata.url).
   */
  return async function verify({ attestation, encryptedId, hash, declared }) {
    let found = null;
    try {
      if (attestation && jwtPayload(attestation)?.id === encryptedId) {
        const p = await checked(attestation);
        if (p && typeof p.origin === 'string') found = { origin: p.origin, isScam: !!p.isScam, isVerified: p.isVerified !== false };
      }
      if (!found && hash) {
        const r = await get(`/attestation/${hash}?v2Supported=true`).catch(() => null);
        if (r && typeof r.origin === 'string') found = { origin: r.origin, isScam: !!r.isScam, isVerified: true };
      }
    } catch { found = null; }
    let mine = '';
    try { mine = new URL(declared).origin; } catch { /* not an address */ }
    if (!found) return { origin: mine, validation: 'UNKNOWN', isScam: false };
    if (!found.isVerified) return { origin: mine, validation: 'UNKNOWN', isScam: found.isScam };
    return { origin: found.origin, validation: mine && found.origin === mine ? 'VALID' : 'INVALID', isScam: found.isScam };
  };
}
