// TON send (Android app): GRAM or a jetton, with an optional comment (exchanges ask for it on deposits).
// Max on GRAM sends the whole balance with the fees taken from it (mode 128): the account is left at exactly zero.
import { useState } from 'preact/hooks';
import { Icon, TokenIcon, Btn, Sheet, TopBar, Spinner, SuccessMark, useApp } from '../components.jsx';
import { QrScanner } from '../scanner.jsx';
import { bg } from '../../shared/ext.js';
import { fmtNum, fmtUsd, parseAmount, rawToInput } from '../../shared/format.js';
import { t } from '../../shared/i18n.js';
import { keyPairFromSeed } from '@ton/crypto';
import { Buffer } from '../../shared/ton/buffer.js';
import {
  Address, parseAddress, parseTonLink, commentCell, jettonTransferCell, DEFAULT_JETTON_VALUE, walletContract, signTransfer, feeQuery, cellToBase64,
} from '../../shared/ton/core.js';
import { tonAddressStatus, tonEstimateFee, tonWaitApplied, tonTxUrl } from '../../shared/ton/api.js';
import { useTonWallet, useTonPortfolio, invalidateTon } from './hooks.js';
import { units } from './home.jsx';

const DUMMY = keyPairFromSeed(Buffer.alloc(32, 7)); // fee estimates don't check signatures: never a real key there

export function TonSend({ jetton: initialJetton = null, to: initialTo = '', scan: scanOnOpen }) {
  const { chain, account, authorize, reset, toast } = useApp();
  const w = useTonWallet();
  const { data, reload } = useTonPortfolio(chain, w?.raw);
  const [jettonKey, setJettonKey] = useState(initialJetton);
  const [to, setTo] = useState(initialTo);
  const [amount, setAmount] = useState('');
  const [isMax, setIsMax] = useState(false);
  const [comment, setComment] = useState('');
  const [picker, setPicker] = useState(false);
  const [scan, setScan] = useState(!!scanOnOpen);
  const [step, setStep] = useState('form');
  const [review, setReview] = useState(null);
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(null);

  if (w === null) return <div class="screen"><TopBar title={t('send.send')} /><div class="content"><div class="error">{t('ton.noKey.body')}</div></div></div>;
  if (!w || !data) return <div class="screen"><TopBar title={t('send.send')} /><div class="content" style={{ alignItems: 'center' }}><Spinner lg /></div></div>;

  const jet = jettonKey ? data.jettons.find((x) => x.master === jettonKey) : null;
  const decimals = jet ? jet.decimals : 9;
  const symbol = jet ? jet.symbol : chain.native.symbol;
  const balance = jet ? jet.balance : data.gram.balance;
  const price = jet ? jet.price : data.gram.price;
  const dest = parseAddress(to);
  const raw = isMax ? balance : parseAmount(amount, decimals);
  const me = Address.parse(w.raw);
  const toSelf = dest && dest.address.equals(me);
  const otherNet = dest && !dest.raw && dest.testOnly !== !!chain.testnet;
  const tooMuch = raw != null && raw > balance;

  const onQr = (text) => {
    setScan(false);
    const l = parseTonLink(text);
    if (l) {
      setTo(l.address);
      if (l.amount && !jettonKey) { setAmount(rawToInput(l.amount, 9)); setIsMax(false); }
      if (l.text) setComment(l.text);
    } else if (parseAddress(text)) setTo(text.trim());
    else toast(t('ton.send.badQr'), 'warn');
  };

  const prepare = async () => {
    setErr(''); setReview(null); setStep('review');
    try {
      const destStatus = await tonAddressStatus(chain, dest.address.toString()).catch(() => 'unknown');
      const text = comment.trim();
      let messages;
      if (!jet) {
        // a wallet not deployed yet can't bounce funds back: send them without bounce (as every wallet does)
        messages = [{ to: dest.address, value: raw, bounce: destStatus === 'active' && dest.bounceable, body: text ? commentCell(text) : null }];
      } else {
        messages = [{ to: Address.parse(jet.wallet), value: DEFAULT_JETTON_VALUE, bounce: true, body: jettonTransferCell({ amount: raw, to: dest.address, responseTo: me, comment: text || undefined }) }];
      }
      const sendAll = !jet && isMax;
      const wallet = walletContract(Buffer.from(w.publicKey, 'hex'), { version: w.version, testnet: !!chain.testnet });
      const deployed = data.status === 'active';
      const { body } = signTransfer({ wallet, secretKey: DUMMY.secretKey, seqno: deployed ? data.seqno : 0, deployed, messages, sendAll });
      const fee = await tonEstimateFee(chain, feeQuery(wallet, body, deployed)).catch(() => null);
      const margin = fee != null ? fee + fee / 10n : null; // the estimate can be a little short
      let problem = '';
      if (!jet && !sendAll && margin != null && raw + margin > data.gram.balance) problem = t('ton.send.noFee', { symbol: chain.native.symbol });
      if (jet && margin != null && DEFAULT_JETTON_VALUE + margin > data.gram.balance) problem = t('ton.send.needGram', { amount: fmtNum(units(DEFAULT_JETTON_VALUE + margin, 9), 3), symbol: chain.native.symbol });
      if (sendAll && fee != null && fee >= data.gram.balance) problem = t('ton.send.noFee', { symbol: chain.native.symbol });
      setReview({ messages, sendAll, fee, destStatus, deployed, problem, text, receive: sendAll && fee != null ? data.gram.balance - fee : raw });
    } catch (e) { setErr(e.message); }
  };

  const confirm = async () => {
    setSending(true); setErr('');
    try {
      const messages = review.messages.map((m) => ({ to: m.to.toString(), value: String(m.value), bounce: m.bounce, body: m.body ? cellToBase64(m.body) : null }));
      const r = await authorize((password) => bg('tonSend', { from: account.address, chainId: chain.id, messages, sendAll: review.sendAll, password }), t('ton.send.confirmTitle'));
      invalidateTon(chain.id, w.raw);
      setStep('done'); setDone({ status: 'pending' });
      tonWaitApplied(chain, r.wallet, r.seqno, { hash: r.hash })
        .then((x) => { setDone({ status: 'ok', txHash: x.txHash }); reload(); })
        .catch(() => setDone({ status: 'late' }));
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setSending(false);
  };

  if (step === 'done') {
    const url = tonTxUrl(chain, done?.txHash);
    return (
      <div class="screen">
        <div class="content" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          {done?.status === 'pending' ? <Spinner lg /> : <SuccessMark />}
          <h2 style={{ margin: 0 }}>{done?.status === 'ok' ? t('ton.send.confirmed') : t('send.sent')}</h2>
          <div class="muted">{t('ton.send.sentTo', { amount: fmtNum(units(review.receive ?? 0n, decimals)), symbol, address: `${dest.address.toString({ urlSafe: true, bounceable: false, testOnly: !!chain.testnet }).slice(0, 6)}…` })}</div>
          <div class="small muted">{done?.status === 'pending' ? t('ton.send.waiting') : done?.status === 'late' ? t('ton.send.late') : ''}</div>
          {url && <a href={url} target="_blank" class="btn secondary sm"><Icon name="external" size={14} /> {t('send.viewOnExplorer')}</a>}
        </div>
        <div class="footer"><Btn onClick={() => reset('home')}>{t('send.done')}</Btn></div>
      </div>
    );
  }

  if (step === 'review') {
    const feeGram = review?.fee != null ? units(review.fee, 9) : null;
    return (
      <div class="screen">
        <TopBar title={t('send.confirmTitle')} onBack={() => setStep('form')} />
        <div class="content">
          {!review ? <div class="card" style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem' }}><Spinner /></div> : (
            <>
              <div class="card col" style={{ alignItems: 'center', gap: '0.375rem' }}>
                <TokenIcon symbol={symbol} icon={jet?.image} color={jet ? undefined : chain.color} />
                <div style={{ fontSize: '1.5rem', fontWeight: 750 }}>{fmtNum(units(review.receive ?? 0n, decimals), 9)} {symbol}</div>
                {price != null && <div class="muted">{fmtUsd(units(review.receive ?? 0n, decimals) * price)}</div>}
              </div>
              <div class="card kv">
                <span class="k">{t('send.from')}</span><span class="v">{account.name}</span>
                <span class="k">{t('send.to')}</span><span class="v mono">{dest.address.toString({ urlSafe: true, bounceable: false, testOnly: !!chain.testnet })}</span>
                <span class="k">{t('send.network')}</span><span class="v">{chain.name}</span>
                {review.text && <><span class="k">{t('ton.send.comment')}</span><span class="v">“{review.text}”</span></>}
                <span class="k">{t('fee.estimated')}</span>
                <span class="v">{feeGram != null ? `${fmtNum(feeGram, 6)} ${chain.native.symbol}${data.gram.price != null ? ` · ${fmtUsd(feeGram * data.gram.price)}` : ''}` : t('ton.send.feeUnknown')}</span>
              </div>
              {jet && <div class="info small">{t('ton.send.jettonFee', { amount: fmtNum(units(DEFAULT_JETTON_VALUE, 9)), symbol: chain.native.symbol })}</div>}
              {review.sendAll && <div class="info small">{t('ton.send.allNote')}</div>}
              {!review.deployed && <div class="info small">{t('ton.send.firstSend')}</div>}
              {!jet && review.destStatus !== 'active' && <div class="info small">{t('ton.send.newRecipient')}</div>}
              {review.problem && <div class="error">{review.problem}</div>}
            </>
          )}
          {err && <div class="error">{err}</div>}
        </div>
        <div class="footer">
          <Btn kind="secondary" onClick={() => setStep('form')}>{t('common.back')}</Btn>
          <Btn loading={sending} disabled={!review || !!review.problem} onClick={confirm}>{t('send.send')}</Btn>
        </div>
      </div>
    );
  }

  const choices = [{ key: null, symbol: chain.native.symbol, name: chain.native.name, amount: data.gram.amount, color: chain.color }, ...data.jettons.map((j) => ({ key: j.master, symbol: j.symbol, name: j.name, amount: j.amount, icon: j.image }))];
  return (
    <div class="screen">
      <TopBar title={t('send.send')} />
      <div class="content">
        <div class="field">
          <label>{t('send.recipient')}</label>
          <div class="row" style={{ gap: '0.375rem' }}>
            <input class="input mono" placeholder="UQ… / EQ…" value={to} onInput={(e) => setTo(e.target.value)} spellcheck={false} autocapitalize="off" />
            <button class="scan-open" onClick={() => setScan(true)} title={t('scan.title')}><Icon name="qr" size={20} /></button>
          </div>
          {to && !dest && <span class="small red">{t('ton.send.badAddress')}</span>}
          {toSelf && <span class="small" style={{ color: 'var(--amber)' }}>{t('send.toSelf')}</span>}
          {otherNet && <span class="small" style={{ color: 'var(--amber)' }}>{t(chain.testnet ? 'ton.send.mainnetAddress' : 'ton.send.testnetAddress')}</span>}
        </div>
        <div class="field">
          <div class="row between"><label>{t('send.amount')}</label><span class="small muted">{t('send.balance', { amount: fmtNum(units(balance, decimals)), symbol })}</span></div>
          <div class="input-wrap">
            <input inputMode="decimal" placeholder="0" value={isMax ? rawToInput(balance, decimals) : amount} onInput={(e) => { setAmount(e.target.value); setIsMax(false); }} />
            <button class="btn ghost sm" onClick={() => setIsMax(true)}>{t('send.max')}</button>
            <button class="token-select" onClick={() => setPicker(true)}><TokenIcon sm symbol={symbol} icon={jet?.image} color={jet ? undefined : chain.color} />{symbol}<Icon name="chevron" size={14} /></button>
          </div>
          <span class="small muted">{raw && price != null ? `≈ ${fmtUsd(units(raw, decimals) * price)}` : ' '}{isMax && !jet ? ` · ${t('send.feeDeducted')}` : ''}</span>
          {tooMuch && <span class="small red">{t('send.overBalance')}</span>}
        </div>
        <div class="field">
          <label>{t('ton.send.comment')}</label>
          <input class="input" value={comment} maxLength={500} placeholder={t('ton.send.commentPlaceholder')} onInput={(e) => setComment(e.target.value)} />
          <span class="tiny muted">{t('ton.send.commentHint')}</span>
        </div>
      </div>
      <div class="footer"><Btn disabled={!dest || !raw || raw <= 0n || tooMuch} onClick={prepare}>{t('common.continue')}</Btn></div>
      {picker && (
        <Sheet title={t('send.pickToken')} onClose={() => setPicker(false)}>
          <div class="list">
            {choices.map((c) => (
              <button class={`item ${c.key === jettonKey ? 'sel' : ''}`} onClick={() => { setJettonKey(c.key); setAmount(''); setIsMax(false); setPicker(false); }}>
                <TokenIcon symbol={c.symbol} icon={c.icon} color={c.color} />
                <div class="grow"><div class="bold">{c.symbol}</div><div class="small muted ellipsis">{c.name}</div></div>
                <span class="small muted">{fmtNum(c.amount)}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {scan && <QrScanner onResult={onQr} onClose={() => setScan(false)} />}
    </div>
  );
}
