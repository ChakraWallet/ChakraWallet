// Speeding up or cancelling a transaction still waiting (history > details): what the replacement does, the fee it
// offers against the one before, the speeds, then the password. The family's driver does the rest (driver.replace,
// src/ui/chains/driver.d.md): the screen knows nothing of nonces or fee rules.
import { useEffect, useState } from 'preact/hooks';
import { TopBar, Btn, Icon, FeeView, useApp, explorerTx, SuccessMark } from '../components.jsx';
import { driverFor } from '../chains/index.js';
import { useChainAddress, useNativePrice } from '../hooks.js';
import { fmtAmount, fmtDateTime } from '../../shared/format.js';
import { t } from '../../shared/i18n.js';

// i18n keys of each operation ("resend": speeding up a transaction nobody holds any more, e.g. the private channel gave up)
const TEXT = {
  speedUp: { title: 'replace.titleSpeedUp', go: 'replace.speedUp', sent: 'replace.sentSpeedUp' },
  cancel: { title: 'replace.titleCancel', go: 'replace.confirmCancel', sent: 'replace.sentCancel' },
  resend: { title: 'replace.titleResend', go: 'replace.resend', sent: 'replace.sentResend' },
};

/**
 * item: the history row (as the driver's loadHistory gave it); mode: 'speedUp' | 'cancel'; label: the row's title;
 * toHistory: opened from the home's short list (at the end: the whole history, where the new transaction shows).
 */
export function ReplaceTx({ item, mode, label, toHistory = false }) {
  const { chain, account, authorize, back, nav } = useApp();
  const addr = useChainAddress();
  const nativePrice = useNativePrice(chain);
  const drv = driverFor(chain);
  const text = TEXT[mode === 'speedUp' && item.status === 'dropped' ? 'resend' : mode];
  const [review, setReview] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const priced = nativePrice != null;
  useEffect(() => {
    if (!addr.raw) return undefined;
    let alive = true;
    // again once the price is known (the fee offered before, in the display currency)
    drv.replace.prepare(chain, item, { mode, wallet: addr, account, nativePrice })
      .then((r) => { if (alive) { setReview(r); setErr(''); } }, (e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [addr.raw, priced]);

  const problem = review?.problem(speed) || null;
  const confirm = async () => {
    setBusy(true); setErr('');
    try {
      const r = await drv.replace.confirm(chain, review, { wallet: addr, account, speed, authorize, title: t(text.title) });
      setDone({ hash: r.hash });
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy(false);
  };

  if (done) {
    // a cancellation sent to Flashbots never goes on-chain: nothing to see on the explorer
    const link = mode === 'cancel' && item.private ? null : explorerTx(chain, done.hash);
    return (
      <div class="screen">
        <div class="content" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <SuccessMark />
          <h2 style={{ margin: 0 }}>{t(text.sent)}</h2>
          <div class="muted">{label}</div>
          <div class="small muted">{t('replace.sentNote')}</div>
          {link && <a href={link} target="_blank" class="btn secondary sm"><Icon name="external" size={14} /> {t('send.viewOnExplorer')}</a>}
        </div>
        <div class="footer"><Btn onClick={() => { back(); if (toHistory) nav('history'); }}>{t('send.done')}</Btn></div>
      </div>
    );
  }

  const outs = item.transfers.filter((x) => x.dir === 'out');
  return (
    <div class="screen">
      <TopBar title={t(text.title)} />
      <div class="content">
        <div class="card kv">
          <span class="k">{t('replace.what')}</span><span class="v">{label}</span>
          {outs.map((x) => <><span class="k">{t('send.amount')}</span><span class="v">{fmtAmount(x.amount, x.decimals, 8)} {x.symbol}</span></>)}
          <span class="k">{t('replace.sentAt')}</span><span class="v">{fmtDateTime(item.time)}</span>
          <span class="k">{t('send.network')}</span><span class="v">{chain.name}</span>
          {(review?.rows || []).map((r) => <><span class="k">{r.k}</span><span class="v">{r.v}</span></>)}
        </div>
        <FeeView chain={chain} fee={review?.fee} speed={speed} setSpeed={setSpeed} nativePrice={nativePrice} />
        {(review?.notes || []).map((n) => <div class="info small">{n}</div>)}
        {problem && <div class="error">{problem}</div>}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer">
        <Btn kind="secondary" onClick={back}>{t('common.back')}</Btn>
        <Btn loading={busy} disabled={!review || !!problem} onClick={confirm}>{t(text.go)}</Btn>
      </div>
    </div>
  );
}
