import { useState, useEffect } from 'preact/hooks';
import { isAddress, getAddress } from 'ethers';
import { bg, ext } from '../../shared/ext.js';
import { NATIVE, getChain } from '../../shared/chains.js';
import { erc20, getTokenInfo } from '../../shared/rpc.js';
import { prepareTx, finalizeTx } from '../../shared/tx.js';
import { fmtNum, fmtUsd, parseAmount, rawToInput, fmtAmount, shortAddr, toFloat } from '../../shared/format.js';
import { TopBar, Btn, TokenIcon, Icon, Sheet, FeeBox, Avatar, useApp, explorerTx, SuccessMark } from '../components.jsx';
import { usePortfolio } from '../hooks.js';
import { rememberRecipient } from '../../shared/poison.js';
import { useRecipientCheck, PoisonWarning } from '../poisonCheck.jsx';
import { parsePaymentQr } from '../../shared/eip681.js';
import { QrScanner } from '../scanner.jsx';
import { t } from '../../shared/i18n.js';

export function TokenPicker({ tokens, onPick, onClose, title = t('send.pickToken'), allowCustom }) {
  const { chain } = useApp();
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState(null);
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(q);
  useEffect(() => {
    setCustom(null);
    if (allowCustom && isAddr && !tokens.some((t) => t.address === q.toLowerCase())) {
      getTokenInfo(chain, q).then((t) => setCustom({ ...t, amount: null, balance: '0' }), () => setCustom(false));
    }
  }, [q]);
  const list = tokens.filter((t) => !q || t.symbol.toLowerCase().includes(q.toLowerCase()) || t.name?.toLowerCase().includes(q.toLowerCase()) || t.address === q.toLowerCase());
  return (
    <Sheet title={title} onClose={onClose}>
      <input class="input" placeholder={t('send.searchPlaceholder')} value={q} onInput={(e) => setQ(e.target.value.trim())} autoFocus />
      <div class="list">
        {list.map((t) => (
          <button class="item" onClick={() => { onPick(t); onClose(); }}>
            <TokenIcon symbol={t.symbol} icon={t.icon} color={t.color} />
            <div class="grow"><div class="bold">{t.symbol}</div><div class="small muted ellipsis">{t.name}</div></div>
            {t.amount != null && <div class="right small"><div class="bold">{fmtNum(t.amount)}</div>{t.usd != null && <div class="muted">{fmtUsd(t.usd)}</div>}</div>}
          </button>
        ))}
        {custom && (
          <button class="item" onClick={() => { onPick(custom); onClose(); }}>
            <TokenIcon symbol={custom.symbol} />
            <div class="grow"><div class="bold">{custom.symbol} <span class="badge amber">{t('send.unverified')}</span></div><div class="small muted ellipsis">{custom.name}</div></div>
          </button>
        )}
        {custom === false && <div class="error small">{t('send.notErc20', { chain: chain.name })}</div>}
        {!list.length && !custom && <div class="empty">{t('send.noTokens')} {isAddr && !allowCustom ? t('send.addFirst') : ''}</div>}
      </div>
    </Sheet>
  );
}

export function useTokenList() {
  const { chain } = useApp();
  const { data } = usePortfolio();
  const native = { address: NATIVE, symbol: chain.native.symbol, name: chain.native.name, decimals: chain.native.decimals, native: true, color: chain.color, balance: data?.native.balance || '0', amount: data?.native.amount, price: data?.native.price, usd: data?.native.usd };
  return { tokens: [native, ...(data?.tokens || [])], data };
}

export function Send({ tokenAddress, to: initialTo = '', scan: scanOnOpen }) {
  const { chain, account, state, nav, reset, toast, authorize, refresh, mode } = useApp();
  const { tokens } = useTokenList();
  const [token, setToken] = useState(null);
  const [to, setTo] = useState(initialTo); // e.g. the project's donation address (Support tab)
  const [amount, setAmount] = useState('');
  const [isMax, setIsMax] = useState(false);
  const [picker, setPicker] = useState(false);
  const [step, setStep] = useState('form');
  const [prepared, setPrepared] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const [hash, setHash] = useState('');
  // address-poisoning protection
  const [ack, setAck] = useState(false);
  const verdict = useRecipientCheck(to);

  useEffect(() => { if (!token) setToken(tokens.find((t) => t.address === (tokenAddress || NATIVE)) || tokens[0]); }, [tokens.length]);
  useEffect(() => setAck(false), [to]);

  // ---- QR: payment links fill recipient, token and amount (switching network if the code says so)
  const [scan, setScan] = useState(!!scanOnOpen);
  const [pendingQr, setPendingQr] = useState(null);
  const openScanner = () => {
    if (mode === 'popup') { // the camera can't be used in the extension popup: continue in a tab
      ext.tabs.create({ url: ext.runtime.getURL('popup.html#full-scan') }); window.close(); return;
    }
    setScan(true);
  };
  const onQr = async (text) => {
    setScan(false);
    const p = parsePaymentQr(text);
    if (!p) { toast(t('scan.notPayment'), 'warn'); return; }
    if (p.chainId && p.chainId !== chain.id) {
      const c = getChain(p.chainId, state.customChains);
      if (!c) { toast(t('scan.unknownChain', { id: p.chainId }), 'warn'); return; }
      await bg('setChain', { chainId: p.chainId }); await refresh();
      toast(t('scan.switched', { chain: c.name }));
    }
    setTo(p.address);
    setPendingQr(p);
  };
  useEffect(() => {
    if (!pendingQr || (pendingQr.chainId && pendingQr.chainId !== chain.id)) return;
    (async () => {
      let tk = null;
      if (pendingQr.token) {
        tk = tokens.find((x) => x.address.toLowerCase() === pendingQr.token.toLowerCase()) || null;
        if (!tk && pendingQr.token !== NATIVE) {
          try { tk = { ...(await getTokenInfo(chain, pendingQr.token)), amount: null, balance: '0' }; } catch { toast(t('scan.unknownToken'), 'warn'); }
        }
      }
      if (tk) setToken(tk);
      const dec = (tk || token)?.decimals;
      if (pendingQr.amountRaw != null && dec != null) { setAmount(rawToInput(pendingQr.amountRaw, dec)); setIsMax(false); }
      setPendingQr(null);
    })();
  }, [pendingQr, chain.id, tokens.length]);

  if (!token) return null;

  const raw = parseAmount(amount, token.decimals);
  const balance = BigInt(token.balance || 0);
  const validTo = isAddress(to.trim());
  const risky = validTo && verdict.risky;
  const usd = raw != null && token.price != null ? toFloat(raw, token.decimals) * token.price : null;
  const others = state.accounts.filter((a) => a.address !== account.address && a.type !== 'ton');

  const buildTx = (value) => token.native
    ? { to: getAddress(to.trim()), value: value.toString(), data: '0x' }
    : { to: token.address, value: '0', data: erc20.encodeFunctionData('transfer', [getAddress(to.trim()), value]) };

  const review = async () => {
    setErr(''); setPrepared(null); setStep('review');
    try {
      setPrepared(await prepareTx(chain, account.address, buildTx(isMax && token.native ? 0n : raw)));
    } catch (e) { setErr(e.message); }
  };

  // for "max" on the native coin, subtract the max network cost
  const sendValue = !prepared ? raw : (isMax && token.native ? (() => { const v = balance - BigInt(prepared.speeds[speed].maxCost); return v > 0n ? v : 0n; })() : raw);
  const nativeBal = BigInt(tokens[0].balance || 0);
  const needNative = prepared ? BigInt(prepared.speeds[speed].maxCost) + (token.native ? sendValue : 0n) : 0n;
  const insufficient = prepared && (needNative > nativeBal || (!token.native && raw > balance));

  const confirm = async () => {
    setSending(true); setErr('');
    try {
      const p = isMax && token.native ? { ...prepared, tx: { ...prepared.tx, value: '0x' + sendValue.toString(16) } } : prepared;
      const title = t('send.txTitle', { amount: fmtAmount(sendValue, token.decimals), symbol: token.symbol });
      const tx = finalizeTx(p, speed);
      const h = await authorize((password) => bg('sendTransaction', { from: account.address, tx, title, password }), t('send.confirmTitle'));
      setHash(h); setStep('done');
      rememberRecipient(getAddress(to.trim())).catch(() => {});
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setSending(false);
  };

  if (step === 'done') {
    const link = explorerTx(chain, hash);
    return (
      <div class="screen">
        <div class="content" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <SuccessMark />
          <h2 style={{ margin: 0 }}>{t('send.sent')}</h2>
          <div class="muted">{t('send.sentTo', { amount: fmtAmount(sendValue, token.decimals), symbol: token.symbol, address: shortAddr(to) })}</div>
          <div class="small muted">{t('send.sentNote')}</div>
          {link && <a href={link} target="_blank" class="btn secondary sm"><Icon name="external" size={14} /> {t('send.viewOnExplorer')}</a>}
        </div>
        <div class="footer"><Btn onClick={() => reset('home')}>{t('send.done')}</Btn></div>
      </div>
    );
  }

  if (step === 'review') {
    return (
      <div class="screen">
        <TopBar title={t('send.confirmTitle')} onBack={() => setStep('form')} />
        <div class="content">
          <div class="card col" style={{ alignItems: 'center', gap: '0.375rem' }}>
            <TokenIcon symbol={token.symbol} icon={token.icon} color={token.color} />
            <div style={{ fontSize: '1.5rem', fontWeight: 750 }}>{sendValue != null ? fmtAmount(sendValue, token.decimals, 8) : '…'} {token.symbol}</div>
            {token.price != null && sendValue != null && <div class="muted">{fmtUsd(toFloat(sendValue, token.decimals) * token.price)}</div>}
          </div>
          <div class="card kv">
            <span class="k">{t('send.from')}</span><span class="v">{account.name} ({shortAddr(account.address)})</span>
            <span class="k">{t('send.to')}</span><span class="v mono">{to.trim()}</span>
            <span class="k">{t('send.network')}</span><span class="v">{chain.name}</span>
          </div>
          <FeeBox chain={chain} prepared={prepared} speed={speed} setSpeed={setSpeed} nativePrice={tokens[0].price}
            valueWei={token.native ? sendValue || 0n : 0n}
            valueUsd={!token.native && token.price != null && raw != null ? toFloat(raw, token.decimals) * token.price : null} />
          {insufficient && <div class="error">{t('send.insufficientNative', { symbol: chain.native.symbol })}</div>}
          {err && <div class="error">{err}</div>}
        </div>
        <div class="footer">
          <Btn kind="secondary" onClick={() => setStep('form')}>{t('common.back')}</Btn>
          <Btn loading={sending} disabled={!prepared || insufficient || !sendValue} onClick={confirm}>{t('send.send')}</Btn>
        </div>
      </div>
    );
  }

  const tooMuch = raw != null && raw > balance;
  return (
    <div class="screen">
      <TopBar title={t('send.send')} />
      <div class="content">
        <div class="field">
          <label>{t('send.recipient')}</label>
          <div class="row" style={{ gap: '0.375rem' }}>
            <input class="input mono" placeholder={t('send.addressPlaceholder')} value={to} onInput={(e) => setTo(e.target.value)} spellcheck={false} />
            <button class="scan-open" onClick={openScanner} title={t('scan.title')}><Icon name="qr" size={20} /></button>
          </div>
          {to && !validTo && <span class="small red">{t('send.invalidAddress')}</span>}
          {validTo && to.trim().toLowerCase() === account.address.toLowerCase() && <span class="small" style={{ color: 'var(--amber)' }}>{t('send.toSelf')}</span>}
          {verdict.level === 'known' && to.trim().toLowerCase() !== account.address.toLowerCase() && <span class="small green row" style={{ gap: '0.25rem' }}><Icon name="check" size={14} />{t('send.poison.known')}</span>}
        </div>
        <PoisonWarning check={verdict} to={to} ack={ack} setAck={setAck} />
        {!to && others.length > 0 && (
          <div class="card flat" style={{ padding: '0.25rem' }}>
            <div class="small muted" style={{ padding: '0.375rem' }}>{t('send.yourAccounts')}</div>
            {others.slice(0, 4).map((a) => (
              <button class="item" onClick={() => setTo(a.address)}><Avatar address={a.address} /><div><div class="bold">{a.name}</div><div class="small muted">{shortAddr(a.address)}</div></div></button>
            ))}
          </div>
        )}
        <div class="field">
          <div class="row between"><label>{t('send.amount')}</label><span class="small muted">{t('send.balance', { amount: fmtNum(token.amount ?? 0), symbol: token.symbol })}</span></div>
          <div class="input-wrap">
            <input inputMode="decimal" placeholder="0" value={amount} onInput={(e) => { setAmount(e.target.value); setIsMax(false); }} />
            <button class="btn ghost sm" onClick={() => { setAmount(rawToInput(balance, token.decimals)); setIsMax(true); }}>{t('send.max')}</button>
            <button class="token-select" onClick={() => setPicker(true)}><TokenIcon sm symbol={token.symbol} icon={token.icon} color={token.color} />{token.symbol}<Icon name="chevron" size={14} /></button>
          </div>
          <span class="small muted">{usd != null ? `≈ ${fmtUsd(usd)}` : ' '}{isMax && token.native ? ` · ${t('send.feeDeducted')}` : ''}</span>
          {tooMuch && <span class="small red">{t('send.overBalance')}</span>}
        </div>
      </div>
      <div class="footer"><Btn kind={risky ? 'danger' : 'primary'} disabled={!validTo || !raw || raw <= 0n || tooMuch || (risky && !ack)} onClick={review}>{t('common.continue')}</Btn></div>
      {picker && <TokenPicker tokens={tokens} onPick={(t) => { setToken(t); setAmount(''); setIsMax(false); }} onClose={() => setPicker(false)} />}
      {scan && <QrScanner onResult={onQr} onClose={() => setScan(false)} />}
    </div>
  );
}
