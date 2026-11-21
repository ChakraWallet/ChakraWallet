// WalletConnect's cryptography (docs/specs/clients/core/crypto/*.md of the specs):
// - pairing and session keys: X25519 key agreement, HKDF-SHA256 to the 32-byte symmetric key; a channel's topic is
//   sha256(symmetric key);
// - messages travel in envelopes, base64: type 0 = 0x00 ‖ iv (12) ‖ ChaCha20-Poly1305(JSON), type 1 = the same with the
//   sender's public key (32) after the type byte;
// - the relay knows the client by an Ed25519 key of its own (did:key), with which it signs a short-lived JWT;
// - Verify (which site a dapp's message really comes from) answers with a JWT signed with P-256 (ES256).
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519, ed25519 } from '@noble/curves/ed25519';
import { p256 } from '@noble/curves/p256';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { encode as b58 } from '../solana/base58.js';

const enc = new TextEncoder(), dec = new TextDecoder();
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  const s = String(h || '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex');
  return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
}
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromBase64 = (s) => Uint8Array.from(atob(String(s).trim()), (c) => c.charCodeAt(0));
const b64url = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => fromBase64(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '='));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ------------------------------------------------------------ keys and topics
/** A new X25519 key pair: { privateKey, publicKey } in hex. */
export function newKeyPair() {
  const privateKey = x25519.utils.randomPrivateKey();
  return { privateKey: toHex(privateKey), publicKey: toHex(x25519.getPublicKey(privateKey)) };
}
/** The symmetric key shared with a peer (hex). */
export const deriveSymKey = (privateKey, peerPublicKey) => toHex(hkdf(sha256, x25519.getSharedSecret(fromHex(privateKey), fromHex(peerPublicKey)), undefined, undefined, 32));
/** The topic of a channel: sha256 of its symmetric key (hex). */
export const topicOf = (symKey) => toHex(sha256(fromHex(symKey)));
/** sha256 of a text (hex): Verify's ids of a message. */
export const hashMessage = (text) => toHex(sha256(enc.encode(text)));

// ------------------------------------------------------------ envelopes
/** Seals a message (an object: its JSON) for a channel: a type 0 envelope, base64. */
export function seal(message, symKey, { iv = randomBytes(12) } = {}) {
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  const sealed = chacha20poly1305(fromHex(symKey), iv).encrypt(enc.encode(text));
  return toBase64(concat(Uint8Array.of(0), iv, sealed));
}

/** The parts of an envelope: { type, senderPublicKey? (hex), iv, sealed }, or null if it can't be one. */
export function readEnvelope(b64) {
  let b;
  try { b = fromBase64(b64); } catch { return null; }
  const type = b[0];
  if (type === 0 && b.length >= 1 + 12 + 16) return { type, iv: b.subarray(1, 13), sealed: b.subarray(13) };
  if (type === 1 && b.length >= 1 + 32 + 12 + 16) return { type, senderPublicKey: toHex(b.subarray(1, 33)), iv: b.subarray(33, 45), sealed: b.subarray(45) };
  return null;
}

/** Opens an envelope with a channel's key -> the message (parsed JSON), or null (wrong key, tampered, not JSON). */
export function open(b64, symKey) {
  const e = readEnvelope(b64);
  if (!e) return null;
  try { return JSON.parse(dec.decode(chacha20poly1305(fromHex(symKey), e.iv).decrypt(e.sealed))); } catch { return null; }
}

// ------------------------------------------------------------ the relay's client authentication
/** A new client key for the relay (Ed25519 private key, hex): Chakra keeps one, its "client id" on the relay. */
export const newClientKey = () => toHex(ed25519.utils.randomPrivateKey());
/** The client id: did:key of the Ed25519 public key (multicodec 0xed01, base58btc). */
export const clientDid = (clientKey) => `did:key:z${b58(concat(Uint8Array.of(0xed, 0x01), ed25519.getPublicKey(fromHex(clientKey))))}`;

/**
 * The JWT that opens a connection to the relay (docs/specs/clients/core/relay/relay-client-auth.md): issued by the
 * client id, for the relay's URL, with a new random subject at every connection; valid one day.
 */
export function relayAuth(clientKey, aud, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const json = (o) => b64url(enc.encode(JSON.stringify(o)));
  const data = `${json({ alg: 'EdDSA', typ: 'JWT' })}.${json({ iss: clientDid(clientKey), sub: toHex(randomBytes(32)), aud, iat, exp: iat + 86400 })}`;
  return `${data}.${b64url(ed25519.sign(enc.encode(data), fromHex(clientKey)))}`;
}

// ------------------------------------------------------------ Verify's attestations
/** The payload of a JWT, unchecked, or null. */
export function jwtPayload(jwt) {
  try { return JSON.parse(dec.decode(fromB64url(String(jwt).split('.')[1]))); } catch { return null; }
}

/**
 * The payload of a JWT signed with ES256 by a P-256 key given as a JWK ({ x, y } base64url), or null when the
 * signature doesn't match.
 */
export function verifyEs256(jwt, jwk) {
  try {
    const [h, p, s] = String(jwt).split('.');
    const sig = fromB64url(s);
    if (sig.length !== 64) return null;
    const pub = concat(Uint8Array.of(4), fromB64url(jwk.x), fromB64url(jwk.y));
    if (pub.length !== 65) return null;
    if (!p256.verify(p256.Signature.fromCompact(sig), sha256(enc.encode(`${h}.${p}`)), pub, { lowS: false })) return null;
    return jwtPayload(jwt);
  } catch { return null; }
}
