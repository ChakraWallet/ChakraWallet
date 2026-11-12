// Bridge: move tokens from one network to another (LI.FI, Relay, deBridge; see shared/bridge.js).
// Flow: pick networks/tokens/amount -> compare routes -> (exact approval) -> confirm with the network fee -> send ->
// track until the funds arrive (also from the list of recent transfers; the app polls while open).
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { isAddress, getAddress } from 'ethers';
import { bg, ext, local } from '../../shared/ext.js';
import { BUILTIN_CHAINS, NATIVE, isChainEnabled, getChain } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { erc20, getAllowance, waitForReceipt } from '../../shared/rpc.js';
import { getNativePrice } from '../../shared/prices.js';
import { getFeeData, prepareTx, finalizeTx } from '../../shared/tx.js';
import { loadPortfolio } from '../../shared/portfolio.js';
import { BRIDGE_CHAINS, getBridgeQuotes, requote } from '../../shared/bridge.js';
import { fmtNum, fmtUsd, fmtAmount, parseAmount, rawToInput, toFloat, shortAddr, fmtDateTime } from '../../shared/format.js';
import { TopBar, Btn, TokenIcon, ChainIcon, Icon, Sheet, FeeBox, Spinner, Avatar, useApp, explorerTx, SuccessMark, Empty } from '../components.jsx';
import { tokenPrefs } from '../hooks.js';
import { WRONG_PASSWORD } from '../auth.jsx';
import { useRecipientCheck, PoisonWarning } from '../poisonCheck.jsx';
import { t, tn } from '../../shared/i18n.js';

const CHAINS = BRIDGE_CHAINS.map((id) => BUILTIN_CHAINS.find((c) => c.id === id)).filter(Boolean);
const chainOf = (id) => CHAINS.find((c) => c.id === id) || getChain(id); // getChain: also TON (Android app)
const nativeToken = (c) => ({ address: NATIVE, symbol: c.native.symbol, name: c.native.name, decimals: c.native.decimals, native: true });
// the same asset on another network (by symbol), else its native currency
const sameOn = (tk, c) => (tk.native || tk.address === NATIVE
  ? nativeToken(c)
  : (POPULAR_TOKENS[c.id] || []).find((x) => x.symbol.replace(/\.e$/i, '') === tk.symbol.replace(/\.e$/i, '')) || nativeToken(c));
const minutes = (s) => (s == null ? '' : s < 60 ? t('bridge.time.sec', { n: Math.max(1, Math.round(s)) }) : t('bridge.time.min', { n: Math.round(s / 60) }));

export function Bridge() {
  const { chain, account, state, authorize, portfolioCache, setPortfolioCache, nav } = useApp();
  const from = account.address;
  const usable = CHAINS.filter((c) => isChainEnabled(c.id, state.settings)); // networks switched off in Settings are not offered
  const [fromId, setFromId] = useState(usable.some((c) => c.id === chain.id) ? chain.id : 1);
  const [toId, setToId] = useState(() => [8453, 42161, ...usable.map((c) => c.id)].find((id) => id !== fromId && usable.some((c) => c.id === id)) ?? fromId);
  const fromChain = chainOf(fromId), toChain = chainOf(toId);
  const [fromToken, setFromToken] = useState(() => nativeToken(fromChain));
  const [toToken, setToToken] = useState(() => nativeToken(toChain));
  const [amount, setAmount] = useState('');
  const [isMax, setIsMax] = useState(false);
  const [recipient, setRecipient] = useState(from);
  const [refuel, setRefuel] = useState(false);
  const [quotes, setQuotes] = useState(null);
  const [qErrors, setQErrors] = useState([]);
  const [picked, setPicked] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [sheet, setSheet] = useState(null); // fromChain | toChain | fromToken | toToken | recipient
  const [step, setStep] = useState('form'); // form | confirm | done
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [prepared, setPrepared] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [sent, setSent] = useState(null);
  const [nativePrice, setNativePrice] = useState(null);
  const authPw = useRef(null);
  useEffect(() => () => { authPw.current = null; }, []);

  // source balances (same cache as the home and accounts screens)
  const pKey = `${fromId}:${from}`;
  const portfolio = portfolioCache[pKey];
  useEffect(() => {
    getNativePrice(fromChain).then(setNativePrice).catch(() => setNativePrice(null));
    if (portfolio && Date.now() - portfolio.updated < 60000) return;
    (async () => {
      try {
        const p = await loadPortfolio(fromChain, from, { ...(await tokenPrefs(fromId)), etherscanKey: state.settings.etherscanKey });
        setPortfolioCache((c) => ({ ...c, [pKey]: p }));
        local.set(`cache:${pKey}`, p).catch(() => {});
      } catch { /* the toast about failed scans is shown by the hooks */ }
    })();
  }, [pKey]);
  const destNative = portfolioCache[`${toId}:${recipient}`]?.native?.amount;

  const sourceTokens = useMemo(() => {
    const p = portfolio;
    const nat = { ...nativeToken(fromChain), amount: p?.native.amount, usd: p?.native.usd, balance: p?.native.balance };
    const list = (p?.tokens || []).filter((x) => !x.spam && (x.price != null || x.custom) && BigInt(x.balance || 0) > 0n);
    return [nat, ...list];
  }, [portfolio, fromId]);
  const balance = BigInt(sourceTokens.find((x) => x.address.toLowerCase() === fromToken.address.toLowerCase())?.balance || 0);
  const destTokens = useMemo(() => [nativeToken(toChain), ...(POPULAR_TOKENS[toId] || [])], [toId]);

  const raw = parseAmount(amount, fromToken.decimals);
  const tooMuch = raw != null && raw > balance;
  const extRecipient = recipient.toLowerCase() !== from.toLowerCase() && !state.accounts.some((a) => a.address.toLowerCase() === recipient.toLowerCase());
  const recipCheck = useRecipientCheck(extRecipient ? recipient : '', toChain);
  const [recipAck, setRecipAck] = useState(false);
  useEffect(() => setRecipAck(false), [recipient]);

  // suggest the gas top-up when the destination has no native currency for gas
  useEffect(() => { setRefuel(!toToken.native && destNative === 0); }, [toId, toToken.address, destNative]);

  const setMax = async () => {
    let v = balance;
    if (fromToken.native) { // keep enough for the network fee
      try { const fd = await getFeeData(fromChain); const s = fd.speeds.fast; v -= 400000n * BigInt(s.maxFee ?? s.gasPrice); } catch { v -= v / 50n; }
    }
    if (v < 0n) v = 0n;
    setAmount(rawToInput(v, fromToken.decimals)); setIsMax(true);
  };

  // ---- quotes (debounced, refreshed every 30 s while choosing)
  const params = () => ({ fromChain, toChain, fromToken: fromToken.address, toToken: toToken.address, amount: raw.toString(), from, to: recipient, slippageBps: 50, refuel, nativePrice });
  const reqId = useRef(0);
  const fetchQuotes = async () => {
    if (!raw || raw <= 0n || tooMuch) { setQuotes(null); return; }
    const id = ++reqId.current;
    setQuoting(true); setErr('');
    try {
      const r = await getBridgeQuotes(params());
      if (id !== reqId.current) return;
      setQuotes(r.quotes); setQErrors(r.errors);
      setPicked((p) => (r.quotes.some((q) => q.provider === p) ? p : r.quotes[0]?.provider || null));
    } catch (e) { if (id === reqId.current) { setQuotes([]); setErr(e.message); } }
    if (id === reqId.current) setQuoting(false);
  };
  useEffect(() => {
    if (step !== 'form') return;
    setQuotes(null);
    const tm = setTimeout(fetchQuotes, 650);
    const iv = setInterval(() => { if (!document.hidden) fetchQuotes(); }, 30000);
    return () => { clearTimeout(tm); clearInterval(iv); };
  }, [amount, fromId, toId, fromToken.address, toToken.address, recipient, refuel, step]);

  const quote = quotes?.find((q) => q.provider === picked);
  const fastest = quotes?.length ? quotes.reduce((a, b) => ((b.durationSec ?? 1e9) < (a.durationSec ?? 1e9) ? b : a)) : null;

  // one authorization covers approval + bridge (same as swaps)
  const sendAuthorized = async (p, keep) => {
    const send = (password) => bg('sendTransaction', { ...p, password });
    if (authPw.current) {
      try { const h = await send(authPw.current); if (!keep) authPw.current = null; return h; } catch (e) { authPw.current = null; if (e.key !== WRONG_PASSWORD) throw e; }
    }
    return authorize(async (password) => { const h = await send(password); if (keep) authPw.current = password; return h; }, t('bridge.confirmTitle'));
  };

  const title = () => t('bridge.txTitle', { amount: fmtNum(toFloat(raw, fromToken.decimals)), symbol: fromToken.symbol, from: fromChain.name, to: toChain.name, provider: quote?.provider });

  const proceed = async () => {
    if (!quote) return;
    setErr('');
    try {
      let q = quote;
      if (q.spender && !fromToken.native) {
        setBusy(t('bridge.busy.checkingApproval'));
        const allowance = await getAllowance(fromChain, fromToken.address, from, q.spender);
        if (allowance < raw) {
          setBusy(t('bridge.busy.approving'));
          const p = await prepareTx(fromChain, from, { to: fromToken.address, data: erc20.encodeFunctionData('approve', [q.spender, raw]), value: '0x0' });
          const h = await sendAuthorized({ from, tx: finalizeTx(p, 'normal'), title: t('bridge.approvalTitle', { symbol: fromToken.symbol }) }, true);
          setBusy(t('bridge.busy.waitingApproval'));
          const rc = await waitForReceipt(fromChain, h);
          if (rc.status !== '0x1') throw new Error(t('bridge.approvalFailed'));
          setBusy(t('bridge.busy.requoting'));
          q = await requote(q.provider, params()); // quotes expire: get a fresh transaction
        }
      }
      setBusy(t('bridge.busy.preparing'));
      setPrepared({ ...(await prepareTx(fromChain, from, q.tx)), quote: q });
      setStep('confirm');
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };

  const send = async () => {
    setErr(''); setBusy(t('bridge.busy.sending'));
    try {
      const q = prepared.quote;
      const h = await sendAuthorized({ from, tx: finalizeTx(prepared, speed), title: title() }, false);
      const entry = {
        id: h, txHash: h, provider: q.provider, tool: q.tool, ref: q.ref, created: Date.now(), status: 'pending',
        fromChainId: fromId, toChainId: toId, from, to: recipient,
        fromToken: { symbol: fromToken.symbol, decimals: fromToken.decimals }, toToken: { symbol: toToken.symbol, decimals: toToken.decimals },
        amountIn: raw.toString(), amountOut: q.amountOut, durationSec: q.durationSec, refuel: q.refuel,
      };
      await local.update('bridges', [], (l) => [entry, ...l].slice(0, 50));
      setSent(entry); setStep('done');
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };

  // ---------------------------------------------------------------- render
  if (step === 'done' && sent) return <BridgeDone entry={sent} onNew={() => { setStep('form'); setSent(null); setAmount(''); setPrepared(null); }} />;

  if (step === 'confirm' && prepared) {
    const q = prepared.quote;
    return (
      <div class="screen">
        <TopBar title={t('bridge.confirm')} onBack={() => { setStep('form'); setPrepared(null); }} />
        <div class="content">
          <RouteSummary q={q} fromChain={fromChain} toChain={toChain} fromToken={fromToken} toToken={toToken} raw={raw} recipient={recipient} ext={extRecipient} />
          <FeeBox chain={fromChain} prepared={prepared} speed={speed} setSpeed={setSpeed} nativePrice={nativePrice} valueWei={fromToken.native ? raw : 0n} />
          {err && <div class="error">{err}</div>}
        </div>
        <div class="footer"><Btn loading={!!busy} onClick={send}>{t('bridge.send')}</Btn></div>
      </div>
    );
  }

  const canGo = quote && !quoting && !busy && raw && raw > 0n && !tooMuch && isAddress(recipient) && (!recipCheck.risky || recipAck);
  return (
    <div class="screen">
      <TopBar title={t('bridge.title')} />
      <div class="content">
        {globalThis.__CK_TON__ && ( // Android: TON has its own bridge (Relay for GRAM, Symbiosis for USD₮)
          <button class="item card" onClick={() => nav('tonBridge', { dir: 'in' })}>
            <ChainIcon chain={getChain(-239)} size={28} />
            <div class="grow"><div class="bold">{t('ton.bridge.shortcut')}</div><div class="small muted">{t('ton.bridge.shortcutSub')}</div></div>
            <Icon name="forward" size={16} />
          </button>
        )}
        {/* from */}
        <div class="card bridge-side">
          <div class="row between small muted"><span>{t('bridge.from')}</span><span>{t('bridge.balance', { amount: fmtAmount(balance, fromToken.decimals), symbol: fromToken.symbol })}</span></div>
          <div class="row">
            <button class="chain-pick" onClick={() => setSheet('fromChain')}><ChainIcon chain={fromChain} size={22} /><span>{fromChain.name}</span><Icon name="chevron" size={14} /></button>
            <span class="spacer" />
            <button class="token-select" onClick={() => setSheet('fromToken')}><TokenIcon sm symbol={fromToken.symbol} icon={fromToken.icon} color={fromToken.native ? fromChain.color : undefined} />{fromToken.symbol}<Icon name="chevron" size={14} /></button>
          </div>
          <div class="input-wrap">
            <input inputMode="decimal" placeholder="0" value={amount} onInput={(e) => { setAmount(e.target.value); setIsMax(false); }} />
            <button class="btn ghost sm" onClick={setMax}>{t('send.max')}</button>
          </div>
          {tooMuch && <div class="small red">{t('bridge.insufficient')}</div>}
        </div>

        <button class="swap-flip" title={t('bridge.flip')} onClick={() => { setFromId(toId); setToId(fromId); setFromToken(sameOn(toToken, toChain)); setToToken(sameOn(fromToken, fromChain)); setAmount(''); }}><Icon name="receive" /></button>

        {/* to */}
        <div class="card bridge-side">
          <div class="row between small muted"><span>{t('bridge.to')}</span>{quote && <span>≈ {quote.outUsd != null ? fmtUsd(quote.outUsd) : ''}</span>}</div>
          <div class="row">
            <button class="chain-pick" onClick={() => setSheet('toChain')}><ChainIcon chain={toChain} size={22} /><span>{toChain.name}</span><Icon name="chevron" size={14} /></button>
            <span class="spacer" />
            <button class="token-select" onClick={() => setSheet('toToken')}><TokenIcon sm symbol={toToken.symbol} icon={toToken.icon} color={toToken.native ? toChain.color : undefined} />{toToken.symbol}<Icon name="chevron" size={14} /></button>
          </div>
          <div class="bridge-out">{quote ? `${fmtAmount(quote.amountOut, toToken.decimals)} ${toToken.symbol}` : quoting ? <span class="skeleton" style={{ display: 'inline-block', width: '8rem', height: '1.5rem' }} /> : <span class="muted">0</span>}</div>
          <button class="row recip" onClick={() => setSheet('recipient')}>
            <Avatar address={recipient} />
            <span class="small grow ellipsis" style={{ textAlign: 'left' }}>{recipientLabel(recipient, from, state.accounts)}</span>
            <Icon name="chevron" size={14} />
          </button>
          {extRecipient && !recipCheck.risky && <div class="warn small">{t('bridge.externalWarn')}</div>}
          <PoisonWarning check={recipCheck} to={recipient} ack={recipAck} setAck={setRecipAck} />
        </div>

        {!toToken.native && (
          <button class="item card refuel" onClick={() => setRefuel(!refuel)}>
            <span class="tx-icon" style={{ background: 'var(--card-2)', color: 'var(--primary)' }}><Icon name="send" size={16} /></span>
            <div class="grow" style={{ textAlign: 'left' }}>
              <div class="bold">{t('bridge.refuel', { symbol: toChain.native.symbol })}</div>
              <div class="small muted">{destNative === 0 ? t('bridge.refuel.noGas', { chain: toChain.name, symbol: toChain.native.symbol }) : t('bridge.refuel.sub')}</div>
            </div>
            <span class={`switch ${refuel ? 'on' : ''}`} />
          </button>
        )}

        {/* routes */}
        {raw > 0n && !tooMuch && (
          <>
            <div class="row between section-row">
              <div class="section-title">{t('bridge.routes')}</div>
              {quoting ? <Spinner /> : quotes && <button class="link" onClick={fetchQuotes}>{t('bridge.refresh')}</button>}
            </div>
            {quotes === null && quoting && [1, 2].map(() => <div class="quote"><div class="skeleton" style={{ width: '60%' }} /><div class="skeleton" style={{ width: '40%' }} /></div>)}
            {quotes?.map((q, i) => (
              <button class={`quote ${q.provider === picked ? 'sel' : ''} ${i === 0 ? 'best' : ''}`} onClick={() => setPicked(q.provider)}>
                <div class="row between">
                  <span class="bold">{q.provider}{q.tool && q.tool !== q.provider ? <span class="muted"> · {q.tool}</span> : ''}</span>
                  <span class="row" style={{ gap: '0.25rem' }}>
                    {i === 0 && <span class="badge green">{t('bridge.best')}</span>}
                    {fastest === q && quotes.length > 1 && <span class="badge primary">{t('bridge.fastest')}</span>}
                  </span>
                </div>
                <div class="row between">
                  <span class="bold">{fmtAmount(q.amountOut, toToken.decimals)} {toToken.symbol}</span>
                  <span class="muted small">{q.outUsd != null ? fmtUsd(q.outUsd) : ''}</span>
                </div>
                <div class="row between tiny muted">
                  <span><Icon name="history" size={12} /> {minutes(q.durationSec)} · {t('bridge.fees', { usd: fmtUsd((q.feesUsd || 0) + (q.gasUsd || 0)) })}</span>
                  {refuel && !toToken.native && <span class={q.refuel ? 'green' : 'red'}>{q.refuel ? t('bridge.withGas', { usd: fmtUsd(q.refuel.usd) }) : t('bridge.noGas')}</span>}
                </div>
              </button>
            ))}
            {quotes && !quotes.length && !quoting && <div class="warn small">{t('bridge.noRoutes')}{qErrors.length ? ` (${qErrors.map((e) => e.provider).join(', ')})` : ''}</div>}
            {quote && (
              <div class="kv small card">
                <span class="k">{t('bridge.minReceived')}</span><span class="v">{fmtAmount(quote.minOut, toToken.decimals)} {toToken.symbol}</span>
                <span class="k">{t('bridge.estTime')}</span><span class="v">{minutes(quote.durationSec)}</span>
                <span class="k">{t('bridge.feeTotal')}</span><span class="v">{fmtUsd((quote.feesUsd || 0) + (quote.gasUsd || 0))}</span>
              </div>
            )}
          </>
        )}
        {busy && <div class="info small row"><Spinner />{busy}</div>}
        {err && <div class="error">{err}</div>}
        <RecentBridges />
      </div>
      <div class="footer"><Btn disabled={!canGo} loading={!!busy} onClick={proceed}>{quote?.spender && !fromToken.native ? t('bridge.approveAndContinue') : t('common.continue')}</Btn></div>

      {(sheet === 'fromChain' || sheet === 'toChain') && (
        <ChainSheet exclude={sheet === 'fromChain' ? null : fromId} current={sheet === 'fromChain' ? fromId : toId} address={from}
          onClose={() => setSheet(null)}
          onPick={(id) => {
            if (sheet === 'fromChain') {
              if (id === toId) setToId(fromId);
              setFromId(id); setFromToken(nativeToken(chainOf(id))); setAmount('');
            } else { setToId(id); setToToken(sameOn(fromToken, chainOf(id))); }
            setSheet(null);
          }} />
      )}
      {sheet === 'fromToken' && <TokenSheet chain={fromChain} tokens={sourceTokens} onClose={() => setSheet(null)} onPick={(tk) => { setFromToken(tk); setToToken(sameOn(tk, toChain)); setAmount(''); setSheet(null); }} />}
      {sheet === 'toToken' && <TokenSheet chain={toChain} tokens={destTokens} onClose={() => setSheet(null)} onPick={(tk) => { setToToken(tk); setSheet(null); }} />}
      {sheet === 'recipient' && <RecipientSheet chain={toChain} current={recipient} self={from} onClose={() => setSheet(null)} onPick={(a) => { setRecipient(a); setSheet(null); }} />}
    </div>
  );
}

function recipientLabel(addr, self, accounts) {
  if (addr.toLowerCase() === self.toLowerCase()) return t('bridge.toSelf');
  const a = accounts.find((x) => x.address.toLowerCase() === addr.toLowerCase());
  return a ? t('bridge.toAccount', { name: a.name }) : t('bridge.toExternal', { address: shortAddr(addr, 6) });
}

function RouteSummary({ q, fromChain, toChain, fromToken, toToken, raw, recipient, ext }) {
  const { state, account } = useApp();
  return (
    <div class="card col" style={{ gap: '0.625rem' }}>
      <div class="row between">
        <div class="row"><ChainIcon chain={fromChain} size={28} /><div><div class="small muted">{fromChain.name}</div><div class="bold">{fmtAmount(raw, fromToken.decimals)} {fromToken.symbol}</div></div></div>
        <Icon name="forward" />
        <div class="row" style={{ textAlign: 'right' }}><div><div class="small muted">{toChain.name}</div><div class="bold green">{fmtAmount(q.amountOut, toToken.decimals)} {toToken.symbol}</div></div><ChainIcon chain={toChain} size={28} /></div>
      </div>
      <div class="kv small">
        <span class="k">{t('bridge.via')}</span><span class="v">{q.provider}{q.tool && q.tool !== q.provider ? ` · ${q.tool}` : ''}</span>
        <span class="k">{t('bridge.minReceived')}</span><span class="v">{fmtAmount(q.minOut, toToken.decimals)} {toToken.symbol}</span>
        {q.refuel && <><span class="k">{t('bridge.gasTopup')}</span><span class="v">{fmtAmount(q.refuel.amount, q.refuel.decimals || 18)} {q.refuel.symbol || toChain.native.symbol}</span></>}
        <span class="k">{t('bridge.estTime')}</span><span class="v">{minutes(q.durationSec)}</span>
        <span class="k">{t('bridge.bridgeFees')}</span><span class="v">{fmtUsd(q.feesUsd || 0)}</span>
        <span class="k">{t('bridge.recipient')}</span><span class="v">{recipientLabel(recipient, account.address, state.accounts)}</span>
      </div>
      {ext && <div class="warn small">{t('bridge.externalWarn')}</div>}
    </div>
  );
}

function ChainSheet({ current, exclude, address, onPick, onClose }) {
  const { portfolioCache, state } = useApp();
  return (
    <Sheet title={t('bridge.pickNetwork')} onClose={onClose}>
      <div class="list">
        {CHAINS.filter((c) => c.id !== exclude && isChainEnabled(c.id, state.settings)).map((c) => {
          const p = portfolioCache[`${c.id}:${address}`];
          return (
            <button class={`item ${c.id === current ? 'sel' : ''}`} onClick={() => onPick(c.id)}>
              <ChainIcon chain={c} size={28} />
              <span class="grow bold">{c.name}</span>
              <span class="small muted">{p ? fmtUsd(p.totalUsd) : ''}</span>
              {c.id === current && <span class="green"><Icon name="check" size={16} /></span>}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

function TokenSheet({ chain, tokens, onPick, onClose }) {
  const [q, setQ] = useState('');
  const list = tokens.filter((x) => !q || x.symbol.toLowerCase().includes(q.toLowerCase()) || x.name?.toLowerCase().includes(q.toLowerCase()));
  return (
    <Sheet title={t('send.pickToken')} onClose={onClose}>
      <input class="input" placeholder={t('send.searchPlaceholder')} value={q} onInput={(e) => setQ(e.target.value)} />
      <div class="list">
        {list.map((x) => (
          <button class="item" onClick={() => onPick(x)}>
            <TokenIcon symbol={x.symbol} icon={x.icon} color={x.native ? chain.color : undefined} />
            <div class="grow"><div class="bold">{x.symbol}</div><div class="small muted ellipsis">{x.name}</div></div>
            {x.amount != null && <div class="right small"><div class="bold">{fmtNum(x.amount)}</div>{x.usd != null && <div class="muted">{fmtUsd(x.usd)}</div>}</div>}
          </button>
        ))}
        {!list.length && <Empty>{t('send.noTokens')}</Empty>}
      </div>
    </Sheet>
  );
}

function RecipientSheet({ current, self, onPick, onClose, chain }) {
  const { state } = useApp();
  const [addr, setAddr] = useState('');
  const valid = isAddress(addr.trim());
  const check = useRecipientCheck(valid ? addr : '', chain);
  const [ack, setAck] = useState(false);
  useEffect(() => setAck(false), [addr]);
  return (
    <Sheet title={t('bridge.recipient')} onClose={onClose}>
      <div class="list">
        {state.accounts.filter((a) => a.type !== 'ton').map((a) => (
          <button class="item" onClick={() => onPick(a.address)}>
            <Avatar address={a.address} />
            <div class="grow"><div class="bold">{a.name}{a.address === self ? ` (${t('bridge.thisAccount')})` : ''}</div><div class="tiny muted">{shortAddr(a.address, 6)}</div></div>
            {a.address.toLowerCase() === current.toLowerCase() && <span class="green"><Icon name="check" size={16} /></span>}
          </button>
        ))}
      </div>
      <div class="field">
        <label>{t('bridge.externalAddress')}</label>
        <input class="input mono" placeholder="0x…" value={addr} onInput={(e) => setAddr(e.target.value)} autoCapitalize="off" spellcheck={false} />
      </div>
      {addr && valid && !check.risky && <div class="warn small">{t('bridge.externalWarn')}</div>}
      <PoisonWarning check={check} to={addr} ack={ack} setAck={setAck} />
      <Btn kind={check.risky ? 'danger' : 'primary'} disabled={!valid || (check.risky && !ack)} onClick={() => onPick(getAddress(addr.trim()))}>{t('bridge.useAddress')}</Btn>
    </Sheet>
  );
}

const STATUS_BADGE = { pending: 'amber', done: 'green', refunded: 'primary', failed: 'red' };

/** Progress of a sent transfer (updates while the app polls the provider). */
function BridgeDone({ entry, onNew }) {
  const live = useBridgeEntry(entry.id) || entry;
  const fc = chainOf(live.fromChainId), tc = chainOf(live.toChainId);
  const stepsDone = live.status === 'done' ? 3 : live.status === 'pending' ? 2 : 3;
  return (
    <div class="screen">
      <div class="content" style={{ alignItems: 'center', textAlign: 'center', justifyContent: 'center', gap: '0.875rem' }}>
        {live.status === 'done' ? <SuccessMark /> : live.status === 'pending' ? <div class="bridge-spin"><Spinner lg /></div> : <div class="err-icon"><Icon name="warn" size={30} /></div>}
        <h2 style={{ margin: 0 }}>{t(`bridge.status.${live.status}.title`)}</h2>
        <div class="muted">{t(`bridge.status.${live.status}.text`, { chain: tc.name, time: minutes(live.durationSec) })}</div>
        <div class="bridge-steps">
          {[t('bridge.step.sent', { chain: fc.name }), t('bridge.step.transit'), t('bridge.step.arrived', { chain: tc.name })].map((s, i) => (
            <div class={`bstep ${i < stepsDone ? 'on' : ''} ${i === stepsDone - 1 && live.status === 'pending' ? 'cur' : ''}`}><span class="bdot" />{s}</div>
          ))}
        </div>
        <div class="row" style={{ gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {explorerTx(fc, live.txHash) && <a class="btn secondary sm" href={explorerTx(fc, live.txHash)} target="_blank"><Icon name="external" size={14} /> {fc.name}</a>}
          {live.destTxHash && explorerTx(tc, live.destTxHash) && <a class="btn secondary sm" href={explorerTx(tc, live.destTxHash)} target="_blank"><Icon name="external" size={14} /> {tc.name}</a>}
        </div>
      </div>
      <div class="footer"><Btn kind="secondary" onClick={onNew}>{t('bridge.newTransfer')}</Btn></div>
    </div>
  );
}

/** Calls read() whenever the saved transfers change (the tracker updates them); returns the cleanup. */
function onBridges(read, stop) {
  const f = (changes, area) => { if (area === 'local' && changes.bridges) read(); };
  ext.storage.onChanged.addListener(f);
  return () => { stop(); ext.storage.onChanged.removeListener(f); };
}

function useBridgeEntry(id) {
  const [e, setE] = useState(null);
  useEffect(() => {
    let alive = true;
    const read = () => local.get('bridges', []).then((l) => alive && setE(l.find((x) => x.id === id) || null));
    read();
    return onBridges(read, () => { alive = false; });
  }, [id]);
  return e;
}

/** Recent transfers of the active wallet, with their status. */
function RecentBridges() {
  const { state } = useApp();
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    let alive = true;
    const mine = new Set(state.accounts.map((a) => a.address.toLowerCase()));
    const read = () => local.get('bridges', []).then((l) => alive && setList(l.filter((x) => mine.has(x.from.toLowerCase())).slice(0, 8)));
    read();
    return onBridges(read, () => { alive = false; });
  }, [state.accounts.length]);
  if (!list.length) return null;
  return (
    <>
      {open && <BridgeDoneSheet entry={open} onClose={() => setOpen(null)} />}
      <div class="section-title">{t('bridge.recent')}</div>
      <div class="card" style={{ padding: '0.375rem' }}>
        {list.map((b) => {
          const fc = chainOf(b.fromChainId), tc = chainOf(b.toChainId);
          return (
            <button class="item" onClick={() => setOpen(b)}>
              <span class="bridge-pair"><ChainIcon chain={fc} size={22} /><ChainIcon chain={tc} size={22} /></span>
              <div class="grow" style={{ minWidth: 0 }}>
                <div class="bold ellipsis">{fmtAmount(b.amountIn, b.fromToken.decimals)} {b.fromToken.symbol} · {fc.name} → {tc.name}</div>
                <div class="tiny muted">{fmtDateTime(b.created)} · {b.provider}</div>
              </div>
              <span class={`badge ${STATUS_BADGE[b.status]}`}>{t(`bridge.badge.${b.status}`)}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function BridgeDoneSheet({ entry, onClose }) {
  const live = useBridgeEntry(entry.id) || entry;
  const fc = chainOf(live.fromChainId), tc = chainOf(live.toChainId);
  return (
    <Sheet title={`${fc.name} → ${tc.name}`} onClose={onClose}>
      <div class="kv small">
        <span class="k">{t('bridge.sentAmount')}</span><span class="v">{fmtAmount(live.amountIn, live.fromToken.decimals)} {live.fromToken.symbol}</span>
        <span class="k">{t('bridge.expected')}</span><span class="v">{fmtAmount(live.amountOut, live.toToken.decimals)} {live.toToken.symbol}</span>
        <span class="k">{t('bridge.via')}</span><span class="v">{live.provider}{live.tool && live.tool !== live.provider ? ` · ${live.tool}` : ''}</span>
        <span class="k">{t('bridge.statusLabel')}</span><span class="v"><span class={`badge ${STATUS_BADGE[live.status]}`}>{t(`bridge.badge.${live.status}`)}</span></span>
        <span class="k">{t('bridge.date')}</span><span class="v">{fmtDateTime(live.created)}</span>
      </div>
      <div class="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        {explorerTx(fc, live.txHash) && <a class="btn secondary sm" href={explorerTx(fc, live.txHash)} target="_blank"><Icon name="external" size={14} /> {fc.name}</a>}
        {live.destTxHash && explorerTx(tc, live.destTxHash) && <a class="btn secondary sm" href={explorerTx(tc, live.destTxHash)} target="_blank"><Icon name="external" size={14} /> {tc.name}</a>}
      </div>
    </Sheet>
  );
}
