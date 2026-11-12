// Payment links (EIP-681), the format wallets put in QR codes:
//   ethereum:<address>[@<chainId>][?value=<wei>]                                  native currency
//   ethereum:<token>[@<chainId>]/transfer?address=<recipient>&uint256=<amount>    ERC-20 transfer
// Also accepts a plain 0x address. Amounts are raw integers (may be written like 1.5e18).
import { getAddress, isAddress } from 'ethers';
import { NATIVE } from './chains.js';

function bigFrom(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  const m = /^(\d+)(?:\.(\d+))?(?:e(\d+))?$/.exec(s);
  if (!m) return null;
  const [, int, frac = '', exp = '0'] = m;
  const e = Number(exp) - frac.length;
  if (e < 0) return null; // fractional wei is not valid
  return BigInt(int + frac) * 10n ** BigInt(e);
}

/** -> { address, chainId?, token?, amountRaw? } or null if the text is not an address / payment link */
export function parsePaymentQr(text) {
  const raw = String(text || '').trim();
  if (isAddress(raw)) return { address: getAddress(raw) };
  const m = /^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/([a-zA-Z]+))?(?:\?(.*))?$/.exec(raw);
  if (!m) return null;
  const [, target, chainId, fn, query] = m;
  const q = new URLSearchParams(query || '');
  const out = { chainId: chainId ? Number(chainId) : undefined };
  if (fn === 'transfer') {
    const to = q.get('address');
    if (!to || !isAddress(to)) return null;
    out.address = getAddress(to);
    out.token = getAddress(target);
    out.amountRaw = bigFrom(q.get('uint256'));
  } else {
    if (fn) return null; // other contract calls are not payments
    out.address = getAddress(target);
    out.token = NATIVE;
    out.amountRaw = bigFrom(q.get('value'));
  }
  return out;
}

/** Payment request for a QR: ask `amountRaw` (optional) of `token` (NATIVE or contract) on `chainId`. */
export function paymentUri({ address, chainId, token, amountRaw }) {
  const native = !token || token.toLowerCase() === NATIVE;
  if (native) return `ethereum:${address}@${chainId}${amountRaw ? `?value=${amountRaw}` : ''}`;
  return `ethereum:${token}@${chainId}/transfer?address=${address}${amountRaw ? `&uint256=${amountRaw}` : ''}`;
}
