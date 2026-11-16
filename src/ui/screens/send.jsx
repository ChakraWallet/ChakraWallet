import { useState, useEffect } from 'preact/hooks';
import { bg, ext } from '../../shared/ext.js';
import { NATIVE, getChain } from '../../shared/chains.js';
import { fmtNum, fmtUsd, parseAmount, rawToInput, fmtAmount, shortAddr, toFloat } from '../../shared/format.js';
import { TopBar, Btn, TokenIcon, Icon, Sheet, FeeView, Avatar, useApp, explorerTx, SuccessMark, Spinner } from '../components.jsx';
import { usePortfolio, useChainAddress } from '../hooks.js';
import { driverFor, useAccountAddresses } from '../chains/index.js';
import { useRecipientCheck, PoisonWarning } from '../poisonCheck.jsx';
import { QrScanner } from '../scanner.jsx';
import { suspectToken } from '../../shared/portfolio.js';
import { t } from '../../shared/i18n.js';

export function TokenPicker({ tokens, onPick, onClose, title = t('send.pickToken'), allowCustom }) {
  const { chain } = useApp();
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState(null);
  const drv = driverFor(chain);
  const canCustom = allowCustom && drv.features.customTokens; // a token by its contract address
  const isAddr = canCustom && drv.validateAddress(chain, q).ok;
  useEffect(() => {
    setCustom(null);
    if (isAddr && !tokens.some((t) => t.address.toLowerCase() === q.toLowerCase())) {
      drv.tokenInfo(chain, q).then((t) => setCustom({ ...t, amount: null, balance: '0' }), () => setCustom(false));
    }
  }, [q]);
  const found = tokens.filter((x) => !q || x.symbol.toLowerCase().includes(q.toLowerCase()) || x.name?.toLowerCase().includes(q.toLowerCase()) || x.address === q.toLowerCase());
  // tokens that may be spam (named like USDT, ETH... with no value): marked, and last
  const suspect = new Set(found.filter((x) => suspectToken(x, chain.id)));
  const list = [...found.filter((x) => !suspect.has(x)), ...suspect];
  return (
    <Sheet title={title} onClose={onClose}>
      <input class="input" placeholder={t('send.searchPlaceholder')} value={q} onInput={(e) => setQ(e.target.value.trim())} autoFocus />
      {suspect.size > 0 && <div class="warn small">{t('send.spamHint')}</div>}
      <div class="list">
        {list.map((x) => (
          <button class="item" onClick={() => { onPick(x); onClose(); }}>
            <TokenIcon symbol={x.symbol} icon={x.icon} color={x.color} />
            <div class="grow" style={{ minWidth: 0 }}><div class="bold ellipsis">{x.symbol}{suspect.has(x) && <> <span class="badge amber">{t('send.maybeSpam')}</span></>}</div><div class="small muted ellipsis">{x.name}</div></div>
            {x.amount != null && <div class="right small"><div class="bold">{fmtNum(x.amount)}</div>{x.usd != null ? <div class="muted">{fmtUsd(x.usd)}</div> : suspect.has(x) && <div class="muted">{t('send.noValue')}</div>}</div>}
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
  const { chain, account, state, reset, toast, authorize, refresh, mode, setPortfolioCache } = useApp();
  const { tokens, data } = useTokenList();
  const drv = driverFor(chain); // addresses, fees, signing and confirmation of this network's family
  const wallet = useChainAddress(); // the account's address on this network
  const others = useAccountAddresses(chain, state.accounts.filter((a) => a.address !== account.address)); // the wallet's other accounts, as recipients
  const [token, setToken] = useState(null);
  const [to, setTo] = useState(initialTo); // e.g. the project's donation address (Support tab)
  const [amount, setAmount] = useState('');
  const [isMax, setIsMax] = useState(false);
  const [memo, setMemo] = useState(''); // networks with features.memo: text attached to the transfer (exchanges ask for it)
  const [picker, setPicker] = useState(false);
  const [step, setStep] = useState('form');
  const [review, setReview] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(null); // { hash, status: 'sent' | 'pending' | 'ok' | 'late' }
  // address-poisoning protection (families with features.poisonCheck)
  const [ack, setAck] = useState(false);
  const verdict = useRecipientCheck(drv.features.poisonCheck ? to : '');

  useEffect(() => { if (!token) setToken(tokens.find((t) => t.address === (tokenAddress || NATIVE)) || tokens[0]); }, [tokens.length]);
  useEffect(() => setAck(false), [to]);

  // ---- QR: payment links fill recipient, token, amount and memo (switching network if the code says so)
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
    const p = drv.parseQr(chain, text);
    if (!p) { toast(t('scan.notPayment'), 'warn'); return; }
    if (p.chainId && p.chainId !== chain.id) {
      const c = getChain(p.chainId, state.customChains);
      if (!c) { toast(t('scan.unknownChain', { id: p.chainId }), 'warn'); return; }
      await bg('setChain', { chainId: p.chainId }); await refresh();
      toast(t('scan.switched', { chain: c.name }));
    }
    setTo(p.address);
    if (p.memo) setMemo(p.memo);
    setPendingQr(p);
  };
  useEffect(() => {
    if (!pendingQr || (pendingQr.chainId && pendingQr.chainId !== chain.id)) return;
    (async () => {
      let tk = null;
      if (pendingQr.token) {
        tk = tokens.find((x) => x.address.toLowerCase() === pendingQr.token.toLowerCase()) || null;
        if (!tk && pendingQr.token !== NATIVE && drv.tokenInfo) {
          try { tk = { ...(await drv.tokenInfo(chain, pendingQr.token)), amount: null, balance: '0' }; } catch { toast(t('scan.unknownToken'), 'warn'); }
        }
      }
      if (tk) setToken(tk);
      const dec = (tk || token)?.decimals;
      if (pendingQr.amountRaw != null && dec != null) { setAmount(rawToInput(pendingQr.amountRaw, dec)); setIsMax(false); }
      setPendingQr(null);
    })();
  }, [pendingQr, chain.id, tokens.length]);

  if (wallet.missing) return <div class="screen"><TopBar title={t('send.send')} /><div class="content"><div class="error">{t('chain.noKey.body', { network: chain.name })}</div></div></div>;
  if (!token) return null;

  const raw = parseAmount(amount, token.decimals);
  const balance = BigInt(token.balance || 0);
  const check = drv.validateAddress(chain, to, wallet.address);
  const validTo = check.ok;
  const risky = validTo && verdict.risky;
  const usd = raw != null && token.price != null ? toFloat(raw, token.decimals) * token.price : null;
  const recipients = state.accounts.filter((a) => a.address !== account.address && others?.[a.address])
    .map((a) => ({ name: a.name, address: others[a.address].address, avatar: a.address }));

  const prepare = async () => {
    setErr(''); setReview(null); setStep('review');
    try { setReview(await drv.prepareSend(chain, { wallet, account, token, to: check.normalized, amountRaw: raw, isMax, memo, portfolio: data })); } catch (e) { setErr(e.message); }
  };

  const sendValue = review ? review.amount(speed) : raw;
  const problem = review?.problem(speed) || null;

  const confirm = async () => {
    setSending(true); setErr('');
    try {
      const title = t('send.txTitle', { amount: fmtAmount(sendValue, token.decimals), symbol: token.symbol });
      const r = await drv.confirmSend(chain, review, { wallet, account, speed, authorize, title });
      setStep('done'); setDone({ hash: r.hash, status: r.wait ? 'pending' : 'sent' });
      const key = `${chain.id}:${account.address}`;
      // networks that confirm in seconds (TON): wait for it, then reload the balances
      r.wait?.then((x) => { setDone({ hash: x.hash || x.txHash || r.hash, status: 'ok' }); setPortfolioCache((c) => { const n = { ...c }; delete n[key]; return n; }); })
        .catch(() => setDone((d) => ({ ...d, status: 'late' })));
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setSending(false);
  };

  if (step === 'done') {
    const link = done?.hash ? explorerTx(chain, done.hash) : null;
    return (
      <div class="screen">
        <div class="content" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          {done?.status === 'pending' ? <Spinner lg /> : <SuccessMark />}
          <h2 style={{ margin: 0 }}>{done?.status === 'ok' ? t('tx.confirmed') : t('send.sent')}</h2>
          <div class="muted">{t('send.sentTo', { amount: fmtAmount(sendValue ?? 0n, token.decimals), symbol: token.symbol, address: shortAddr(review?.recipient || to) })}</div>
          <div class="small muted">{done?.status === 'sent' ? t('send.sentNote') : done?.status === 'pending' ? t('tx.waiting') : done?.status === 'late' ? t('tx.late') : ''}</div>
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
            <span class="k">{t('send.from')}</span><span class="v">{account.name} ({shortAddr(wallet.address || account.address)})</span>
            <span class="k">{t('send.to')}</span><span class="v mono">{review?.recipient || check.normalized || to.trim()}</span>
            <span class="k">{t('send.network')}</span><span class="v">{chain.name}</span>
            {(review?.rows || []).map((r) => <><span class="k">{r.k}</span><span class="v">{r.v}</span></>)}
          </div>
          <FeeView chain={chain} fee={review?.fee} speed={speed} setSpeed={setSpeed} nativePrice={tokens[0].price} />
          {(review?.notes || []).map((n) => <div class="info small">{n}</div>)}
          {problem && <div class="error">{problem}</div>}
          {err && <div class="error">{err}</div>}
        </div>
        <div class="footer">
          <Btn kind="secondary" onClick={() => setStep('form')}>{t('common.back')}</Btn>
          <Btn loading={sending} disabled={!review || !!problem || !sendValue} onClick={confirm}>{t('send.send')}</Btn>
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
            <input class="input mono" placeholder={drv.addressPlaceholder(chain)} value={to} onInput={(e) => setTo(e.target.value)} spellcheck={false} autocapitalize="off" />
            <button class="scan-open" onClick={openScanner} title={t('scan.title')}><Icon name="qr" size={20} /></button>
          </div>
          {to && !validTo && <span class="small red">{t(check.error)}</span>}
          {validTo && check.toSelf && <span class="small" style={{ color: 'var(--amber)' }}>{t('send.toSelf')}</span>}
          {validTo && (check.warnings || []).map((w) => <span class="small" style={{ color: 'var(--amber)' }}>{t(w.key)}</span>)}
          {verdict.level === 'known' && !check.toSelf && <span class="small green row" style={{ gap: '0.25rem' }}><Icon name="check" size={14} />{t('send.poison.known')}</span>}
        </div>
        <PoisonWarning check={verdict} to={to} ack={ack} setAck={setAck} />
        {!to && recipients.length > 0 && (
          <div class="card flat" style={{ padding: '0.25rem' }}>
            <div class="small muted" style={{ padding: '0.375rem' }}>{t('send.yourAccounts')}</div>
            {recipients.slice(0, 4).map((a) => (
              <button class="item" onClick={() => setTo(a.address)}><Avatar address={a.avatar} /><div><div class="bold">{a.name}</div><div class="small muted">{shortAddr(a.address)}</div></div></button>
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
        {drv.features.memo && (
          <div class="field">
            <label>{t('send.memo')}</label>
            <input class="input" value={memo} maxLength={500} placeholder={t('send.memoPlaceholder')} onInput={(e) => setMemo(e.target.value)} />
            <span class="tiny muted">{t('send.memoHint')}</span>
          </div>
        )}
      </div>
      <div class="footer"><Btn kind={risky ? 'danger' : 'primary'} disabled={!validTo || !raw || raw <= 0n || tooMuch || (risky && !ack) || !data || !wallet.ready} onClick={prepare}>{t('common.continue')}</Btn></div>
      {picker && <TokenPicker tokens={tokens} onPick={(t) => { setToken(t); setAmount(''); setIsMax(false); }} onClose={() => setPicker(false)} />}
      {scan && <QrScanner onResult={onQr} onClose={() => setScan(false)} />}
    </div>
  );
}
