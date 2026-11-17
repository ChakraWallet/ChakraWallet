// Bridge: move tokens from one network to another, the same screen for every network. The routes come from the chain
// drivers' `bridge` (src/ui/chains): EVM <-> EVM through LI.FI, Relay, Across, deBridge (shared/bridge.js); TON <-> EVM
// through Relay (GRAM) and Symbiosis (USD₮) in the Android app. Flow: networks / tokens / amount -> compare routes ->
// steps (an approval of the exact amount when needed, then the transfer) -> tracked until the funds arrive.
import { useState, useEffect, useMemo } from 'preact/hooks';
import { ext, local } from '../../shared/ext.js';
import { NATIVE, isChainEnabled, getChain } from '../../shared/chains.js';
import { getNativePrice } from '../../shared/prices.js';
import { fmtNum, fmtUsd, fmtAmount, parseAmount, rawToInput, toFloat, shortAddr, fmtDateTime } from '../../shared/format.js';
import { TopBar, Btn, TokenIcon, ChainIcon, Icon, Sheet, FeeView, Spinner, Avatar, useApp, explorerTx, SuccessMark, Empty, richText } from '../components.jsx';
import { tokenPrefs, indexerKeys } from '../hooks.js';
import { driverFor, bridgeNetworks, bridgeFor, useAccountAddresses } from '../chains/index.js';
import { useOperationAuth, runStep } from '../steps.js';
import { useRecipientCheck, PoisonWarning } from '../poisonCheck.jsx';
import { t, tn } from '../../shared/i18n.js';

const chainOf = (id) => bridgeNetworks().find((c) => c.id === id) || getChain(id);
const nativeToken = (c) => ({ address: NATIVE, symbol: c.native.symbol, name: c.native.name, decimals: c.native.decimals, native: true });
const STABLES = ['USDC', 'USDT', 'USD₮', 'USD₮0', 'USDT0'];
const plain = (s) => String(s || '').replace(/\.e$/i, '');
/** Tokens on network c that a route to / from `other` can move. */
const tokensOn = (c, other) => bridgeFor(c, other)?.tokens(c, other) || [nativeToken(c)];
/** The same asset on another network (by symbol; a stablecoin to a stablecoin), else its native currency. */
function sameOn(tk, c, other) {
  const list = tokensOn(c, other);
  if (tk.native || tk.address === NATIVE) return list.find((x) => x.native) || nativeToken(c);
  return list.find((x) => plain(x.symbol) === plain(tk.symbol)) || (STABLES.includes(tk.symbol) && list.find((x) => STABLES.includes(x.symbol))) || list.find((x) => x.native) || nativeToken(c);
}
/** A route's capability that may depend on the tokens / direction (a function of the route's parameters) or not. */
const cap = (v, ...a) => (typeof v === 'function' ? v(...a) : !!v);
const minutes = (s) => (s == null ? '' : s < 60 ? t('bridge.time.sec', { n: Math.max(1, Math.round(s)) }) : t('bridge.time.min', { n: Math.round(s / 60) }));

/** toChainId / toAddress: open towards a network and a token (e.g. topping up the MetaMask Card on Linea). */
export function Bridge({ toChainId, toAddress }) {
  const { chain, account, state, portfolioCache, setPortfolioCache } = useApp();
  const auth = useOperationAuth(t('bridge.confirmTitle'));
  const usable = bridgeNetworks().filter((c) => isChainEnabled(c.id, state.settings)); // networks switched off in Settings are not offered
  const want = toChainId && usable.some((c) => c.id === toChainId) ? toChainId : null;
  // towards a given network: from another one (Base and Arbitrum first, cheap), else from the current network
  const [fromId, setFromId] = useState(() => (want ? [8453, 42161, 1, ...usable.map((c) => c.id)].find((id) => id !== want && usable.some((c) => c.id === id)) ?? 1
    : usable.some((c) => c.id === chain.id) ? chain.id : 1));
  const [toId, setToId] = useState(() => want ?? [8453, 42161, ...usable.map((c) => c.id)].find((id) => id !== fromId && usable.some((c) => c.id === id)) ?? fromId);
  const fromChain = chainOf(fromId), toChain = chainOf(toId);
  const route = bridgeFor(fromChain, toChain); // the driver bridge that connects them (null: none)
  // the account's address on both sides; an account of one family only uses the wallet's first account that has one
  const fromMap = useAccountAddresses(fromChain, state.accounts);
  const toMap = useAccountAddresses(toChain, state.accounts);
  const own = (map) => {
    if (!map) return null;
    const a = [account, ...state.accounts].find((x) => map[x.address]);
    return a ? { ...map[a.address], owner: a.address } : null;
  };
  const fromAddr = own(fromMap), selfTo = own(toMap);
  const [toToken, setToToken] = useState(() => (toAddress && tokensOn(toChain, fromChain).find((x) => x.address.toLowerCase() === toAddress.toLowerCase())) || nativeToken(toChain));
  const [fromToken, setFromToken] = useState(() => (toAddress ? sameOn(toToken, fromChain, toChain) : nativeToken(fromChain))); // the same asset
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState(''); // routes with freeRecipient: another address ('' = this account)
  const [refuel, setRefuel] = useState(false);
  const [quotes, setQuotes] = useState(null);
  const [qErrors, setQErrors] = useState([]);
  const [picked, setPicked] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [sheet, setSheet] = useState(null); // fromChain | toChain | fromToken | toToken | recipient
  const [steps, setSteps] = useState(null);
  const [idx, setIdx] = useState(0);
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [speed, setSpeed] = useState('normal');
  const [sent, setSent] = useState(null);
  const [nativePrice, setNativePrice] = useState(null);

  const toAddr = route?.freeRecipient && recipient ? { address: recipient, raw: recipient } : selfTo;
  const missing = !fromAddr && fromMap ? fromChain : !selfTo && toMap ? toChain : null; // no key for one of the networks

  // source balances (same cache as the home and accounts screens)
  const pKey = `${fromId}:${fromAddr?.owner || account.address}`;
  const portfolio = portfolioCache[pKey];
  useEffect(() => {
    getNativePrice(fromChain).then(setNativePrice).catch(() => setNativePrice(null));
    if (!fromAddr || (portfolio && Date.now() - portfolio.updated < 60000)) return;
    (async () => {
      try {
        const p = await driverFor(fromChain).loadPortfolio(fromChain, fromAddr.raw, { ...(await tokenPrefs(fromId)), ...indexerKeys(state.settings) });
        setPortfolioCache((c) => ({ ...c, [pKey]: p }));
        local.set(`cache:${pKey}`, p).catch(() => {});
      } catch { /* the toast about failed scans is shown by the hooks */ }
    })();
  }, [pKey, fromAddr?.raw]);
  const destNative = portfolioCache[`${toId}:${recipient || account.address}`]?.native?.amount;

  const sourceTokens = useMemo(() => {
    const p = portfolio;
    const nat = { ...nativeToken(fromChain), amount: p?.native.amount, usd: p?.native.usd, balance: p?.native.balance };
    let list = (p?.tokens || []).filter((x) => !x.spam && (x.price != null || x.custom) && BigInt(x.balance || 0) > 0n);
    if (route && cap(route.onlyTokens, fromChain, 'from')) { const ok = route.tokens(fromChain, toChain); list = list.filter((x) => ok.some((y) => y.address.toLowerCase() === x.address.toLowerCase())); }
    return [nat, ...list];
  }, [portfolio, fromId, toId]);
  const balance = BigInt(sourceTokens.find((x) => x.address.toLowerCase() === fromToken.address.toLowerCase())?.balance || 0);
  const destTokens = useMemo(() => tokensOn(toChain, fromChain), [toId, fromId]);
  // a route that moves only some tokens: switch to one that it does
  useEffect(() => {
    if (!route) return;
    const ok = (c, other, tk) => route.tokens(c, other).some((x) => x.address.toLowerCase() === tk.address.toLowerCase());
    if (cap(route.onlyTokens, fromChain, 'from') && !ok(fromChain, toChain, fromToken)) setFromToken(nativeToken(fromChain));
    if (!ok(toChain, fromChain, toToken)) setToToken(sameOn(fromToken, toChain, fromChain));
  }, [fromId, toId]);

  const raw = parseAmount(amount, fromToken.decimals);
  const tooMuch = raw != null && raw > balance;
  // the wallet's accounts on the destination network, by their address there (TON: UQ…)
  const mine = state.accounts.filter((a) => toMap?.[a.address]).map((a) => ({ name: a.name, address: toMap[a.address].address }));
  const extRecipient = !!recipient && !mine.some((a) => a.address.toLowerCase() === recipient.toLowerCase());
  const recipCheck = useRecipientCheck(extRecipient ? recipient : '', toChain);
  const [recipAck, setRecipAck] = useState(false);
  useEffect(() => setRecipAck(false), [recipient]);
  useEffect(() => { if (!route?.freeRecipient) setRecipient(''); }, [route]);

  // suggest the gas top-up when the destination has no native currency for gas
  const canRefuel = !!route && cap(route.refuel, { fromChain, toChain, fromToken, toToken }) && !toToken.native;
  useEffect(() => { setRefuel(canRefuel && destNative === 0); }, [toId, toToken.address, fromToken.address, destNative, route]);

  const setMax = async () => setAmount(rawToInput(await route.reserve(fromChain, fromToken, balance), fromToken.decimals));

  const title = () => t('bridge.txTitle', { amount: fmtNum(toFloat(raw, fromToken.decimals)), symbol: fromToken.symbol, from: fromChain.name, to: toChain.name, provider: quote?.provider });
  const params = () => ({ fromChain, toChain, fromToken, toToken, amount: raw.toString(), fromAddr, toAddr, account, refuel, nativePrice, portfolio, title: title() });

  // ---- quotes (debounced, refreshed every 30 s while choosing)
  const reqId = useState({ n: 0 })[0];
  const fetchQuotes = async () => {
    if (!raw || raw <= 0n || tooMuch || !route || !fromAddr || !toAddr) { setQuotes(route ? null : []); return; }
    const id = ++reqId.n;
    setQuoting(true); setErr('');
    try {
      const r = await route.quotes(params());
      if (id !== reqId.n) return;
      setQuotes(r.quotes); setQErrors(r.errors);
      setPicked((p) => (r.quotes.some((q) => q.provider === p) ? p : r.quotes[0]?.provider || null));
    } catch (e) { if (id === reqId.n) { setQuotes([]); setErr(e.message); } }
    if (id === reqId.n) setQuoting(false);
  };
  useEffect(() => {
    if (steps) return undefined;
    setQuotes(null);
    const tm = setTimeout(fetchQuotes, 650);
    const iv = setInterval(() => { if (!document.hidden) fetchQuotes(); }, 30000);
    return () => { clearTimeout(tm); clearInterval(iv); };
  }, [amount, fromId, toId, fromToken.address, toToken.address, recipient, refuel, !!steps, !!fromAddr, !!toAddr]);

  const quote = quotes?.find((q) => q.provider === picked);
  const fastest = quotes?.length ? quotes.reduce((a, b) => ((b.durationSec ?? 1e9) < (a.durationSec ?? 1e9) ? b : a)) : null;

  // ---- steps: an approval when needed, then the transfer
  const proceed = async () => {
    if (!quote) return;
    setErr(''); setBusy(t('bridge.busy.checkingApproval'));
    try {
      const list = await route.steps(quote, params());
      setSteps(list); setIdx(0); setReview(null);
      setBusy(t('bridge.busy.preparing'));
      setReview(await list[0].prepare());
    } catch (e) { if (!e.cancelled) setErr(e.message); setSteps(null); }
    setBusy('');
  };
  const cancel = () => { setSteps(null); setReview(null); setErr(''); };
  const confirm = async () => {
    setErr(''); setBusy(t(steps[idx].key === 'approve' ? 'bridge.busy.approving' : 'bridge.busy.sending'));
    try {
      const r = await runStep(steps, idx, review, { speed, auth, onWaiting: () => setBusy(t('bridge.busy.waitingApproval')) });
      if (idx < steps.length - 1) {
        setBusy(t('bridge.busy.preparing')); setReview(null); setIdx(idx + 1);
        setReview(await steps[idx + 1].prepare());
      } else {
        const used = r.quote || quote; // a quote refreshed by the last step (after an approval or a swap): its reference tracks the transfer
        const entry = {
          id: r.hash, txHash: r.hash, provider: used.provider, tool: used.tool, ref: used.ref, created: Date.now(), status: 'pending',
          fromChainId: fromId, toChainId: toId, from: fromAddr.address, to: toAddr.address,
          fromToken: { symbol: fromToken.symbol, decimals: fromToken.decimals }, toToken: { symbol: toToken.symbol, decimals: toToken.decimals },
          amountIn: raw.toString(), amountOut: used.amountOut, durationSec: used.durationSec, refuel: used.refuel,
        };
        await local.update('bridges', [], (l) => [entry, ...l].slice(0, 50));
        setPortfolioCache((c) => { const n = { ...c }; delete n[pKey]; return n; });
        // networks that confirm in seconds (TON): the transaction's hash on the explorer, once known
        r.wait?.then((x) => x?.txHash && local.update('bridges', [], (l) => l.map((b) => (b.id === entry.id ? { ...b, txHash: x.txHash } : b)))).catch(() => {});
        setSent(entry); setSteps(null);
      }
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };

  // ---------------------------------------------------------------- render
  if (sent) return <BridgeDone entry={sent} onNew={() => { setSent(null); setAmount(''); }} />;

  if (steps) {
    const s = steps[idx];
    const approving = s.key === 'approve';
    return (
      <div class="screen">
        <TopBar title={steps.length > 1 ? t('bridge.stepOf', { i: idx + 1, n: steps.length, title: approving ? t('bridge.approveTitle') : s.title }) : s.title} onBack={cancel} />
        <div class="content">
          {steps.length > 1 && <div class="steps">{steps.map((_, i) => <div class={`s ${i <= idx ? 'on' : ''}`} />)}</div>}
          {s.note && <div class="info small">{s.note}</div>}
          {approving && (
            <div class="info small">
              {richText(t('swap.approveInfo', { provider: quote.provider }), { token: <b>{fromToken.symbol}</b>, exact: <b>{t('swap.exactly', { amount: fmtAmount(raw, fromToken.decimals), symbol: fromToken.symbol })}</b> })}
            </div>
          )}
          <RouteSummary q={quote} fromChain={fromChain} toChain={toChain} fromToken={fromToken} toToken={toToken} raw={raw} recipient={toAddr.address} self={selfTo?.address} mine={mine} ext={extRecipient} />
          <FeeView chain={fromChain} fee={review?.fee} speed={speed} setSpeed={setSpeed} nativePrice={nativePrice} />
          {busy && <div class="info small row"><Spinner />{busy}</div>}
          {err && <div class="error">{err}</div>}
          {err && quote.twoStep && idx > 0 && <div class="warn small">{t('bridge.twoStep.afterSwap')}</div>}
        </div>
        <div class="footer">
          <Btn kind="secondary" onClick={cancel}>{t('common.cancel')}</Btn>
          <Btn loading={!!busy} disabled={!review} onClick={confirm}>{approving ? t('swap.approve') : t('bridge.send')}</Btn>
        </div>
      </div>
    );
  }

  const canGo = quote && !quoting && !busy && raw && raw > 0n && !tooMuch && !missing && toAddr && (!recipCheck.risky || recipAck);
  const note = route?.note?.({ fromChain, toChain, fromToken, toToken });
  return (
    <div class="screen">
      <TopBar title={t('bridge.title')} />
      <div class="content">
        {/* from */}
        <div class="card bridge-side">
          <div class="row between small muted"><span>{t('bridge.from')}</span><span>{t('bridge.balance', { amount: fmtAmount(balance, fromToken.decimals), symbol: fromToken.symbol })}</span></div>
          <div class="row">
            <button class="chain-pick" onClick={() => setSheet('fromChain')}><ChainIcon chain={fromChain} size={22} /><span>{fromChain.name}</span><Icon name="chevron" size={14} /></button>
            <span class="spacer" />
            <button class="token-select" onClick={() => setSheet('fromToken')}><TokenIcon sm symbol={fromToken.symbol} icon={fromToken.icon} color={fromToken.native ? fromChain.color : undefined} />{fromToken.symbol}<Icon name="chevron" size={14} /></button>
          </div>
          <div class="input-wrap">
            <input inputMode="decimal" placeholder="0" value={amount} onInput={(e) => setAmount(e.target.value)} />
            {route && <button class="btn ghost sm" onClick={setMax}>{t('send.max')}</button>}
          </div>
          {tooMuch && <div class="small red">{t('bridge.insufficient')}</div>}
        </div>

        <button class="swap-flip" title={t('bridge.flip')} onClick={() => { setFromId(toId); setToId(fromId); setFromToken(sameOn(toToken, toChain, fromChain)); setToToken(sameOn(fromToken, fromChain, toChain)); setAmount(''); }}><Icon name="receive" /></button>

        {/* to */}
        <div class="card bridge-side">
          <div class="row between small muted"><span>{t('bridge.to')}</span>{quote && <span>≈ {quote.outUsd != null ? fmtUsd(quote.outUsd) : ''}</span>}</div>
          <div class="row">
            <button class="chain-pick" onClick={() => setSheet('toChain')}><ChainIcon chain={toChain} size={22} /><span>{toChain.name}</span><Icon name="chevron" size={14} /></button>
            <span class="spacer" />
            <button class="token-select" onClick={() => setSheet('toToken')}><TokenIcon sm symbol={toToken.symbol} icon={toToken.icon} color={toToken.native ? toChain.color : undefined} />{toToken.symbol}<Icon name="chevron" size={14} /></button>
          </div>
          <div class="bridge-out">{quote ? `${fmtAmount(quote.amountOut, toToken.decimals)} ${toToken.symbol}` : quoting ? <span class="skeleton" style={{ display: 'inline-block', width: '8rem', height: '1.5rem' }} /> : <span class="muted">0</span>}</div>
          {route?.freeRecipient ? (
            <button class="row recip" onClick={() => setSheet('recipient')}>
              <Avatar address={recipient || account.address} />
              <span class="small grow ellipsis" style={{ textAlign: 'left' }}>{recipientLabel(recipient || selfTo?.address || '', selfTo?.address, mine)}</span>
              <Icon name="chevron" size={14} />
            </button>
          ) : ( // the funds go to this account on the other side
            <div class="row recip">
              <Avatar address={account.address} />
              <span class="small grow ellipsis" style={{ textAlign: 'left' }}>{t('bridge.toSelf')}{selfTo ? ` · ${shortAddr(selfTo.address, 4)}` : ''}</span>
            </div>
          )}
          {extRecipient && !recipCheck.risky && <div class="warn small">{t('bridge.externalWarn')}</div>}
          {extRecipient && route?.recipientNote?.(toChain) && <div class="warn small">{route.recipientNote(toChain)}</div>}
          <PoisonWarning check={recipCheck} to={recipient} ack={recipAck} setAck={setRecipAck} />
        </div>

        {missing && <div class="error small">{t('chain.noKey.body', { network: missing.name })}</div>}
        {!route && <div class="warn small">{t('bridge.noRoutes')}</div>}
        {note && <div class="tiny muted">{note}</div>}
        {canRefuel && (
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
        {route && raw > 0n && !tooMuch && (
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
                    {q.twoStep && <span class="badge amber">{t('bridge.twoStep.badge')}</span>}
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
            {quotes && !quotes.length && !quoting && <div class="warn small">{t('bridge.noRoutes')}{qErrors.length ? ` ${qErrors.map((e) => `${e.provider}: ${e.error}`).join(' · ')}` : ''}</div>}
            {quote?.twoStep && ( // what a two-step route does, before anything is signed
              <div class="info small col" style={{ gap: '.375rem' }}>
                <b>{t('bridge.twoStep.title')}</b>
                <span>1. {t('bridge.twoStep.line1', { amount: fmtAmount(raw, fromToken.decimals), symbol: fromToken.symbol, gram: fmtAmount(quote.twoStep.gram, 9) })}</span>
                <span>2. {t('bridge.twoStep.line2', { gram: fmtAmount(quote.twoStep.gram, 9), out: fmtAmount(quote.amountOut, toToken.decimals), symbol: toToken.symbol, network: toChain.name })}</span>
                <span class="muted">{t('bridge.twoStep.footer')}</span>
              </div>
            )}
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
        <ChainSheet exclude={sheet === 'fromChain' ? null : fromId} current={sheet === 'fromChain' ? fromId : toId} address={account.address}
          onClose={() => setSheet(null)}
          onPick={(id) => {
            if (sheet === 'fromChain') {
              const other = id === toId ? fromId : toId;
              if (id === toId) setToId(fromId);
              setFromId(id); setFromToken(nativeToken(chainOf(id))); setToToken(sameOn(toToken, chainOf(other), chainOf(id))); setAmount('');
            } else { setToId(id); setToToken(sameOn(fromToken, chainOf(id), fromChain)); }
            setSheet(null);
          }} />
      )}
      {sheet === 'fromToken' && <TokenSheet chain={fromChain} tokens={sourceTokens} onClose={() => setSheet(null)} onPick={(tk) => { setFromToken(tk); setToToken(sameOn(tk, toChain, fromChain)); setAmount(''); setSheet(null); }} />}
      {sheet === 'toToken' && <TokenSheet chain={toChain} tokens={destTokens} onClose={() => setSheet(null)} onPick={(tk) => { setToToken(tk); setSheet(null); }} />}
      {sheet === 'recipient' && <RecipientSheet chain={toChain} current={recipient || selfTo?.address || ''} self={account.address} note={route?.recipientNote?.(toChain)}
        onClose={() => setSheet(null)} onPick={(a) => { setRecipient(a === selfTo?.address ? '' : a); setSheet(null); }} />}
    </div>
  );
}

/** accounts: the wallet's accounts as { name, address } with their address on the destination network. */
function recipientLabel(addr, self, accounts) {
  if (self && addr.toLowerCase() === self.toLowerCase()) return t('bridge.toSelf');
  const a = accounts.find((x) => x.address.toLowerCase() === addr.toLowerCase());
  return a ? t('bridge.toAccount', { name: a.name }) : t('bridge.toExternal', { address: shortAddr(addr, 6) });
}

function RouteSummary({ q, fromChain, toChain, fromToken, toToken, raw, recipient, self, mine, ext }) {
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
        <span class="k">{t('bridge.recipient')}</span><span class="v">{recipientLabel(recipient, self, mine)}</span>
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
        {bridgeNetworks().filter((c) => c.id !== exclude && isChainEnabled(c.id, state.settings)).map((c) => {
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

function RecipientSheet({ current, self, note, onPick, onClose, chain }) {
  const { state } = useApp();
  const mine = useAccountAddresses(chain, state.accounts); // the wallet's accounts that have an address on this network
  const [addr, setAddr] = useState('');
  const checked = driverFor(chain).validateAddress(chain, addr);
  const valid = checked.ok;
  const check = useRecipientCheck(valid ? addr : '', chain);
  const [ack, setAck] = useState(false);
  useEffect(() => setAck(false), [addr]);
  return (
    <Sheet title={t('bridge.recipient')} onClose={onClose}>
      <div class="list">
        {state.accounts.filter((a) => mine?.[a.address]).map((a) => (
          <button class="item" onClick={() => onPick(mine[a.address].address)}>
            <Avatar address={a.address} />
            <div class="grow"><div class="bold">{a.name}{a.address === self ? ` (${t('bridge.thisAccount')})` : ''}</div><div class="tiny muted">{shortAddr(mine[a.address].address, 6)}</div></div>
            {mine[a.address].address.toLowerCase() === current.toLowerCase() && <span class="green"><Icon name="check" size={16} /></span>}
          </button>
        ))}
      </div>
      <div class="field">
        <label>{t('bridge.externalAddress')}</label>
        <input class="input mono" placeholder={driverFor(chain).addressPlaceholder(chain)} value={addr} onInput={(e) => setAddr(e.target.value)} autoCapitalize="off" spellcheck={false} />
      </div>
      {addr && valid && !check.risky && <div class="warn small">{t('bridge.externalWarn')}</div>}
      {addr && valid && note && <div class="warn small">{note}</div>}
      <PoisonWarning check={check} to={addr} ack={ack} setAck={setAck} />
      <Btn kind={check.risky ? 'danger' : 'primary'} disabled={!valid || (check.risky && !ack)} onClick={() => onPick(checked.normalized)}>{t('bridge.useAddress')}</Btn>
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
