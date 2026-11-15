// Swaps on TON through Omniston, STON.fi's aggregator (STON.fi, DeDust, Tonco and others): live quotes over a
// WebSocket (JSON-RPC, no key), then the messages to sign, ready-made. No fee added by Chakra.
// Protocol v1beta8: wss://omni-ws.ston.fi - QuoteRpc.Quote (subscription) / TonRpc.BuildSwap.
import { Buffer } from './buffer.js';
import { Address } from '@ton/core';
import { ENDPOINTS } from '../endpoints.js';

const WS_URL = () => ENDPOINTS.omniston;
const NS = 'stonfi.omni.v1beta8';
export const DEFAULT_SLIPPAGE_PIPS = 10000; // 1% (1 pip = 1/1,000,000)

/** Omniston asset: GRAM (master null) or a jetton master (any address format). */
export const assetOf = (master) => (master ? { ton: { jetton: Address.parse(master).toString({ urlSafe: true, bounceable: true }) } } : { ton: { native: {} } });

/** Well-known jettons offered as swap targets (also when not held). Addresses checked against STON.fi's asset list. */
export const POPULAR_JETTONS = [
  'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', // USD₮
  'EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO', // STON
  'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT', // NOT
  'EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS', // DOGS
];

const hexToB64 = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex').toString('base64');

/**
 * Opens a quote session. onQuote(q) is called at every price update:
 * q = { id, inputUnits, outputUnits, minOutput, impactPips, gasBudget, protocols: [...], resolver }
 * onNone() when no route exists; onError(message).
 * Returns { stop(), build(quote, traderAddress) -> [{ to, value, body (base64), init? (base64) }] }.
 */
export function omnistonQuotes({ from, to, units, slippagePips = DEFAULT_SLIPPAGE_PIPS }, { onQuote, onNone, onError }) {
  let ws, seq = 0, sub = null, stopped = false;
  const pending = new Map();
  const timer = setTimeout(() => { if (!stopped) onNone?.(); }, 20000);
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  try { ws = new WebSocket(WS_URL()); } catch (e) { onError?.(e.message); return { stop() {}, build: () => Promise.reject(e) }; }
  ws.onopen = async () => {
    try {
      sub = await call(`${NS}.QuoteRpc.Quote`, {
        input_asset: assetOf(from), output_asset: assetOf(to), input_units: String(units),
        settlement_params: [{ swap: { max_price_slippage_pips: slippagePips } }],
      });
    } catch (e) { if (!stopped) onError?.(e.message); }
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || 'Omniston'), { info: m.error.data?.error_info })); else p.resolve(m.result);
      return;
    }
    const r = m.params?.result;
    if (!r || stopped) return;
    if (r.quote_updated) {
      clearTimeout(timer);
      const q = r.quote_updated.quote || r.quote_updated;
      const routes = q.swap?.routes || [];
      onQuote?.({
        id: q.quote_id, raw: q, inputUnits: BigInt(q.input_units), outputUnits: BigInt(q.output_units),
        minOutput: BigInt(q.swap?.min_output_amount ?? q.output_units), impactPips: q.swap?.price_impact_pips ?? null,
        gasBudget: BigInt(q.gas_budget || 0), resolver: q.resolver_name || null,
        protocols: [...new Set(routes.flatMap((rt) => (rt.steps || []).flatMap((s) => (s.chunks || []).map((c) => c.protocol))))],
      });
    } else if (r.no_quote) { clearTimeout(timer); onNone?.(); }
  };
  ws.onerror = () => { if (!stopped) onError?.('Omniston'); };
  return {
    stop() {
      stopped = true; clearTimeout(timer);
      try { if (sub != null) ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: `${NS}.QuoteRpc.Quote.unsubscribe`, params: [sub] })); } catch { /* closing */ }
      try { ws.close(); } catch { /* closed */ }
    },
    /** Messages for the chosen quote (gas excess and refunds come back to the trader). */
    async build(quote, trader) {
      const a = { ton: trader };
      const r = await call(`${NS}.TonRpc.BuildSwap`, { quote_id: quote.id, transfer_src_address: a, trader_dst_address: a, refund_src_address: a, gas_excess_address: a });
      return (r.messages || []).map((x) => ({
        to: x.target_address, value: String(x.send_amount), bounce: true, body: x.payload ? hexToB64(x.payload) : null,
        init: x.jetton_wallet_state_init ? hexToB64(x.jetton_wallet_state_init) : null,
      }));
    },
  };
}
