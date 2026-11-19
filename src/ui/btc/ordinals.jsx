// Sending an inscription (Ordinals) from its page: the recipient (a Taproot address is what Ordinals wallets use), the
// coin that carries it goes whole, the fee is paid with other coins. Text inscriptions are shown as text.
import { useEffect, useState } from 'preact/hooks';
import { Btn, TopBar, FeeView, Icon, SuccessMark, useApp, explorerTx } from '../components.jsx';
import { useChainAddress, useNativePrice } from '../hooks.js';
import { t } from '../../shared/i18n.js';
import { bg } from '../../shared/ext.js';
import { decodeAddress } from '../../shared/btc/keys.js';
import { contentUrl } from '../../shared/btc/unisat.js';
import { prepareInscriptionSend, withPrevHex } from './plan.js';

/** On an inscription's page: send it; a text inscription's text. */
export function BtcNftActions({ chain, nft }) {
  const { nav } = useApp();
  const [text, setText] = useState('');
  const ins = nft.inscription;
  useEffect(() => {
    if (!ins || !/^text\/plain|application\/json/.test(ins.contentType || '')) return;
    fetch(contentUrl(chain, ins.id), { signal: AbortSignal.timeout(15000) }).then((r) => r.text()).then((x) => setText(x.slice(0, 2000))).catch(() => {});
  }, [ins?.id]);
  if (!ins) return null;
  return (
    <>
      {text && <pre class="card mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</pre>}
      <Btn onClick={() => nav('btcSendInscription', { nft })}><Icon name="send" size={16} /> {t('btc.ord.send')}</Btn>
    </>
  );
}

export function BtcSendInscription({ nft }) {
  const { chain, account, authorize, back, toast } = useApp();
  const wallet = useChainAddress();
  const nativePrice = useNativePrice(chain);
  const [to, setTo] = useState('');
  const [review, setReview] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const dest = decodeAddress(to.trim(), chain.net);
  const prepare = async () => {
    setErr(''); setBusy(true); setReview(null);
    try { setReview(await prepareInscriptionSend(chain, { wallet, inscription: nft.inscription, to: to.trim() })); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const confirm = async () => {
    setErr(''); setBusy(true);
    try {
      const plan = review._btc.planFor(speed);
      if (!plan) throw new Error(review.problem(speed) || t('btc.err.badPlan'));
      await withPrevHex(chain, plan);
      const r = await authorize((password) => bg('btcSend', { from: account.address, chainId: chain.id, plan, meta: { title: nft.name }, password }), t('btc.ord.send'));
      setDone(r.txid);
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy(false);
  };
  if (done) {
    return (
      <div class="screen">
        <div class="content" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <SuccessMark />
          <h2 style={{ margin: 0 }}>{t('btc.ord.sent')}</h2>
          <div class="muted">{nft.name}</div>
          <a href={explorerTx(chain, done)} target="_blank" class="btn secondary sm"><Icon name="external" size={14} /> {t('send.viewOnExplorer')}</a>
        </div>
        <div class="footer"><Btn onClick={() => { toast(t('btc.ord.sent')); back(); }}>{t('send.done')}</Btn></div>
      </div>
    );
  }
  const problem = review?.problem(speed) || null;
  return (
    <div class="screen">
      <TopBar title={t('btc.ord.send')} />
      <div class="content">
        <div class="card kv"><span class="k">{t('btc.ord.what')}</span><span class="v">{nft.name}</span><span class="k">{t('send.network')}</span><span class="v">{chain.name}</span></div>
        <div class="field">
          <label>{t('send.to')}</label>
          <input class="input mono" value={to} placeholder={t('btc.ord.toPlaceholder')} spellcheck={false} autocapitalize="off" onInput={(e) => { setTo(e.target.value); setReview(null); }} />
          {to.trim() && !dest && <span class="error small">{t('btc.send.badAddress')}</span>}
          {dest && dest.type !== 'p2tr' && <span class="warn small">{t('btc.ord.notTaproot')}</span>}
        </div>
        {review && (
          <>
            {review.notes.map((n) => <div class="info small">{n}</div>)}
            <FeeView chain={chain} fee={review.fee} speed={speed} setSpeed={setSpeed} nativePrice={nativePrice} />
          </>
        )}
        {(problem || err) && <div class="error">{problem || err}</div>}
      </div>
      <div class="footer">
        {!review ? <Btn loading={busy} disabled={!dest} onClick={prepare}>{t('common.continue')}</Btn>
          : <Btn loading={busy} disabled={!!problem} onClick={confirm}>{t('btc.ord.send')}</Btn>}
      </div>
    </div>
  );
}
