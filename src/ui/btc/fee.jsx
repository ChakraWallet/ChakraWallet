// The fee of a Bitcoin transaction (FeeView draws it through fee.View): Slow / Normal / Fast from mempool.space's
// recommended rates, or a rate of one's own in sat/vB; what each costs, how many coins the transaction spends and the
// change that comes back.
import { useState } from 'preact/hooks';
import { t } from '../../shared/i18n.js';
import { fmtAmount, fmtUsd, toFloat, shortAddr } from '../../shared/format.js';
import { SPEEDS } from '../../shared/tx.js';
import { rateOf } from './plan.js';

const fmtRate = (r) => `${Number(r).toLocaleString(undefined, { maximumFractionDigits: 1 })} sat/vB`;

export function BtcFee({ chain, fee, speed, setSpeed, nativePrice }) {
  const custom = String(speed).startsWith('custom:');
  const [text, setText] = useState(custom ? String(speed).slice(7) : '');
  const sym = fee.symbol, dec = fee.decimals;
  const usd = (sats) => (nativePrice != null ? fmtUsd(toFloat(sats, dec) * nativePrice) : '');
  const sel = fee.selFor(speed);
  const ok = sel && !sel.error;
  const rate = rateOf(fee.rates, speed);
  const value = ok ? sel.outputs.filter((o) => !o.own && !o.data).reduce((s, o) => s + o.value, 0n) : 0n;
  const change = ok ? sel.outputs.filter((o) => o.change) : [];
  const applyCustom = (v) => {
    setText(v);
    const n = Number(String(v).replace(',', '.'));
    if (n > 0) setSpeed(`custom:${n}`);
  };
  return (
    <div class="fee-box">
      <div class="speeds">
        {Object.keys(SPEEDS).map((k) => {
          const s = fee.selFor(k);
          return (
            <button class={`speed ${speed === k ? 'active' : ''}`} onClick={() => setSpeed(k)} title={t(SPEEDS[k].hint)}>
              {t(SPEEDS[k].label)}
              <span class="usd">{s && !s.error ? usd(s.fee) || `${fmtAmount(s.fee, dec, 8)}` : fmtRate(rateOf(fee.rates, k))}</span>
            </button>
          );
        })}
        <button class={`speed ${custom ? 'active' : ''}`} onClick={() => applyCustom(text || String(Math.ceil(fee.rates.normal)))}>
          {t('btc.fee.custom')}
          <span class="usd">{custom ? fmtRate(rate) : 'sat/vB'}</span>
        </button>
      </div>
      {custom && (
        <div class="fee-row">
          <span class="k">{t('btc.fee.rate')}</span>
          <span class="v"><input class="input mono" style={{ width: '6.5rem', textAlign: 'right' }} inputMode="decimal" value={text} onInput={(e) => applyCustom(e.target.value)} /> sat/vB</span>
        </div>
      )}
      {custom && rate < fee.rates.slow && <div class="warn small">{t('btc.fee.lowRate', { rate: fmtRate(fee.rates.slow) })}</div>}
      <div class="fee-row">
        <span class="k">{t('fee.estimated')}</span>
        <span class="v">{ok ? usd(sel.fee) || `${fmtAmount(sel.fee, dec, 8)} ${sym}` : '—'}{ok && <span class="sub">{fmtAmount(sel.fee, dec, 8)} {sym} · {fmtRate(rate)} · {sel.vbytes} vB</span>}</span>
      </div>
      {ok && (
        <div class="fee-row">
          <span class="k">{t('btc.fee.coins')}</span>
          <span class="v">{sel.inputs.length}{change.length > 0 && <span class="sub">{t('btc.fee.change', { amount: `${fmtAmount(change[0].value, dec, 8)} ${sym}`, address: shortAddr(change[0].address, 6) })}</span>}</span>
        </div>
      )}
      {ok && value > 0n && (
        <div class="fee-row total">
          <span class="k bold" style={{ color: 'var(--text)' }}>{t('fee.total')}</span>
          <span class="v">{usd(value + sel.fee) || `${fmtAmount(value + sel.fee, dec, 8)} ${sym}`}<span class="sub">{fmtAmount(value + sel.fee, dec, 8)} {sym}</span></span>
        </div>
      )}
    </div>
  );
}
