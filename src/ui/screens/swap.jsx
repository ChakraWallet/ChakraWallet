// Swap screen, the same for every network: the chain driver gives the tokens, the quotes (one round or live) and the
// steps (EVM: approval of the exact amount + swap; TON: one transfer); this screen runs them (src/ui/steps.js).
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { NATIVE } from '../../shared/chains.js';
import { fmtNum, fmtUsd, parseAmount, rawToInput, fmtAmount, toFloat } from '../../shared/format.js';
import { TopBar, Btn, TokenIcon, Icon, FeeView, Spinner, useApp, explorerTx, Empty, SuccessMark, richText } from '../components.jsx';
import { TokenPicker, useTokenList } from './send.jsx';
import { useChainAddress } from '../hooks.js';
import { driverFor } from '../chains/index.js';
import { useOperationAuth, runStep } from '../steps.js';
import { t, tn } from '../../shared/i18n.js';

const SLIPPAGES = [10, 50, 100, 300]; // bps

/** fromAddress / toAddress: the tokens to start with (e.g. converting into a token the MetaMask Card spends). */
export function Swap({ fromAddress, toAddress }) {
  const { chain, account, reset, setPortfolioCache } = useApp();
  const drv = driverFor(chain);
  const wallet = useChainAddress();
  const auth = useOperationAuth(t('swap.confirmTitle'));
  const { tokens: owned, data } = useTokenList();
  const [extra, setExtra] = useState([]); // well-known tokens to swap to (from the driver)
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(50);
  const [picker, setPicker] = useState(null);
  const [quotes, setQuotes] = useState(null);
  const [qErrors, setQErrors] = useState([]);
  const [selected, setSelected] = useState(0);
  const [quoting, setQuoting] = useState(false);
  const [ctx, setCtx] = useState(null); // { nativePrice, priceIn, priceOut }
  const [steps, setSteps] = useState(null); // the operation's steps, once started
  const [idx, setIdx] = useState(0);
  const [review, setReview] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null); // { hash, status: 'sent' | 'pending' | 'ok' | 'late' }
  const qid = useRef(0);
  const session = useRef(null);
  useEffect(() => { drv.swapTokens?.(chain).then(setExtra).catch(() => {}); }, [chain.id]);
  useEffect(() => () => session.current?.stop(), []);

  const allTokens = useMemo(() => {
    const map = new Map(owned.map((x) => [x.address, x]));
    for (const x of extra) if (!map.has(x.address)) map.set(x.address, x);
    return [...map.values()];
  }, [owned, extra]);

  useEffect(() => {
    if (!data) return;
    if (!from) setFrom(allTokens.find((x) => x.address === (fromAddress || NATIVE)) || allTokens[0]);
    if (!to) setTo((toAddress && allTokens.find((x) => x.address === toAddress.toLowerCase() && x.address !== (fromAddress || NATIVE)))
      || allTokens.find((x) => ['USDC', 'USD₮', 'USDT'].includes(x.symbol) && x.address !== (fromAddress || NATIVE)) || allTokens[1]);
  }, [data, extra.length]);

  const raw = from ? parseAmount(amount, from.decimals) : null;
  const balance = BigInt(from?.balance || 0);

  // quotes (debounced): the driver calls back once (aggregators) or at every update (live quotes)
  useEffect(() => {
    setQuotes(null); setQErrors([]); setSelected(0);
    session.current?.stop(); session.current = null;
    if (!from || !to || !raw || raw <= 0n || from.address === to.address || !wallet.ready) return undefined;
    const id = ++qid.current;
    const tm = setTimeout(() => {
      setQuoting(true);
      session.current = drv.swapQuotes(chain, { from, to, amountRaw: raw, slippageBps: slippage, wallet, nativePrice: owned[0]?.price ?? null }, {
        onQuotes: (r) => { if (id !== qid.current) return; setCtx(r.ctx); setQuotes(r.quotes); setQErrors(r.errors || []); setQuoting(false); },
        onError: (m) => { if (id !== qid.current) return; setQErrors([{ provider: 'Chakra', error: m }]); setQuotes((q) => q || []); setQuoting(false); },
      });
    }, 600);
    return () => { clearTimeout(tm); session.current?.stop(); session.current = null; };
  }, [from?.address, to?.address, amount, slippage, chain.id, wallet.ready]);

  // the quote being confirmed stays fixed (live quotes keep updating the list, and their session builds the swap)
  const [opQuote, setOpQuote] = useState(null);
  const q = (steps || done) && opQuote ? opQuote : quotes?.[selected];
  const inUsd = raw && ctx?.priceIn != null ? toFloat(raw, from.decimals) * ctx.priceIn : null;
  const impact = q?.outUsd != null && inUsd ? ((q.outUsd - inUsd) / inUsd) * 100 : null;

  if (!drv.swapSupported?.(chain)) {
    return <div class="screen"><TopBar title={t('swap.title')} /><div class="content"><Empty>{t('swap.unavailable', { chain: chain.name })}</Empty></div></div>;
  }
  if (!from || !to) return <div class="screen"><TopBar title={t('swap.title')} /><div class="content"><div class="empty"><Spinner /></div></div></div>;

  // ---------- actions
  const start = async () => {
    setErr(''); setBusy(t('swap.checkingApproval'));
    try {
      const title = t('swap.txTitle', { amount: fmtNum(toFloat(raw, from.decimals)), from: from.symbol, to: to.symbol, provider: q.provider });
      const list = await drv.swapSteps(chain, q, { from, to, amountRaw: raw, wallet, account, portfolio: data, inUsd, title });
      setOpQuote(q); setSteps(list); setIdx(0); setReview(null);
      setReview(await list[0].prepare());
    } catch (e) { setErr(e.message); setSteps(null); }
    setBusy('');
  };
  const cancel = () => { setSteps(null); setReview(null); setErr(''); };

  const confirm = async () => {
    setErr(''); setBusy(t('swap.sending'));
    try {
      const r = await runStep(steps, idx, review, { speed, auth, onWaiting: () => setBusy(t('swap.waitingNetwork')) });
      if (idx < steps.length - 1) { // next step (after an approval: the swap, prepared now that the allowance is there)
        setBusy(t('swap.preparing')); setReview(null); setIdx(idx + 1);
        setReview(await steps[idx + 1].prepare());
      } else {
        session.current?.stop(); session.current = null;
        setDone({ hash: r.hash, status: r.wait ? 'pending' : 'sent' });
        const key = `${chain.id}:${account.address}`;
        r.wait?.then((x) => { setDone({ hash: x.hash || x.txHash || r.hash, status: 'ok' }); setPortfolioCache((c) => { const n = { ...c }; delete n[key]; return n; }); })
          .catch(() => setDone((d) => ({ ...d, status: 'late' })));
      }
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };

  const Summary = () => (
    <div class="card col" style={{ gap: '0.625rem' }}>
      <div class="row between">
        <div class="row"><TokenIcon symbol={from.symbol} icon={from.icon} color={from.native ? chain.color : undefined} /><div><div class="small muted">{t('swap.youPay')}</div><div class="bold">{fmtAmount(raw, from.decimals)} {from.symbol}</div></div></div>
        <div class="small muted right">{inUsd != null && fmtUsd(inUsd)}</div>
      </div>
      <div class="row between">
        <div class="row"><TokenIcon symbol={to.symbol} icon={to.icon} color={to.native ? chain.color : undefined} /><div><div class="small muted">{t('swap.youReceiveEst')}</div><div class="bold green">{fmtAmount(q.amountOut, to.decimals)} {to.symbol}</div></div></div>
        <div class="small muted right">{q.outUsd != null && fmtUsd(q.outUsd)}</div>
      </div>
      <div class="kv">
        <span class="k">{t('swap.minReceived')}</span><span class="v">{fmtAmount(q.minOut, to.decimals)} {to.symbol}</span>
        <span class="k">{t('swap.maxSlippage')}</span><span class="v">{slippage / 100}%</span>
        <span class="k">{t('swap.via')}</span><span class="v">{q.provider}</span>
      </div>
    </div>
  );

  if (done) {
    const link = done.hash ? explorerTx(chain, done.hash) : null;
    return (
      <div class="screen">
        <div class="content" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          {done.status === 'pending' ? <Spinner lg /> : <SuccessMark />}
          <h2 style={{ margin: 0 }}>{done.status === 'ok' ? t('swap.confirmed') : t('swap.sent')}</h2>
          <div class="muted">{fmtAmount(raw, from.decimals)} {from.symbol} → ~{fmtAmount(q.amountOut, to.decimals)} {to.symbol}</div>
          <div class="small muted">{done.status === 'pending' ? t('tx.waiting') : done.status === 'late' ? t('tx.late') : ''}</div>
          {link && <a href={link} target="_blank" class="btn secondary sm"><Icon name="external" size={14} /> {t('send.viewOnExplorer')}</a>}
        </div>
        <div class="footer"><Btn onClick={() => reset('home')}>{t('send.done')}</Btn></div>
      </div>
    );
  }

  if (steps) {
    const s = steps[idx];
    const approving = s.key === 'approve';
    return (
      <div class="screen">
        <TopBar title={steps.length > 1 ? (approving ? t('swap.step1') : t('swap.step2')) : t('swap.confirmTitle')} onBack={cancel} />
        <div class="content">
          {steps.length > 1 && <div class="steps">{steps.map((_, i) => <div class={`s ${i <= idx ? 'on' : ''}`} />)}</div>}
          {approving && (
            <div class="info small">
              {richText(t('swap.approveInfo', { provider: q.provider }), { token: <b>{from.symbol}</b>, exact: <b>{t('swap.exactly', { amount: fmtAmount(raw, from.decimals), symbol: from.symbol })}</b> })}
            </div>
          )}
          <Summary />
          <FeeView chain={chain} fee={review?.fee} speed={speed} setSpeed={setSpeed} nativePrice={ctx?.nativePrice ?? owned[0]?.price} />
          {review?.problem?.(speed) && <div class="error">{review.problem(speed)}</div>}
          {busy && <div class="info row"><Spinner /> {busy}</div>}
          {err && <div class="error">{err}</div>}
        </div>
        <div class="footer">
          <Btn kind="secondary" onClick={cancel}>{t('common.cancel')}</Btn>
          <Btn loading={!!busy} disabled={!review || !!review.problem?.(speed)} onClick={confirm}>{approving ? t('swap.approve') : t('swap.confirmTitle')}</Btn>
        </div>
      </div>
    );
  }

  const tooMuch = raw != null && raw > balance;
  return (
    <div class="screen">
      <TopBar title={t('swap.title')} right={<span class="badge primary">{chain.name}</span>} />
      <div class="content">
        <div class="card col" style={{ gap: '0.375rem' }}>
          <div class="row between small muted"><span>{t('swap.from')}</span><span>{t('swap.balance', { amount: fmtNum(from.amount ?? 0) })} <button class="link" onClick={() => setAmount(rawToInput(drv.swapMax(chain, from, balance), from.decimals))}>{t('send.max')}</button></span></div>
          <div class="row">
            <input class="input big" style={{ border: 0, padding: '0.25rem 0', background: 'transparent', boxShadow: 'none' }} inputMode="decimal" placeholder="0" value={amount} onInput={(e) => setAmount(e.target.value)} />
            <button class="token-select" onClick={() => setPicker('from')}><TokenIcon sm symbol={from.symbol} icon={from.icon} color={from.native ? chain.color : undefined} />{from.symbol}<Icon name="chevron" size={14} /></button>
          </div>
          <div class="small muted">{inUsd != null ? fmtUsd(inUsd) : ' '}</div>
        </div>
        <button class="swap-flip" onClick={() => { setFrom(to); setTo(from); setAmount(''); }} title={t('swap.flip')}><Icon name="swap" /></button>
        <div class="card col" style={{ gap: '0.375rem' }}>
          <div class="row between small muted"><span>{t('swap.toEst')}</span><span>{t('swap.balance', { amount: fmtNum(to.amount ?? 0) })}</span></div>
          <div class="row">
            <div class="grow" style={{ fontSize: '1.375rem', fontWeight: 650 }}>{quoting ? <Spinner /> : q ? fmtNum(toFloat(q.amountOut, to.decimals)) : '0'}</div>
            <button class="token-select" onClick={() => setPicker('to')}><TokenIcon sm symbol={to.symbol} icon={to.icon} color={to.native ? chain.color : undefined} />{to.symbol}<Icon name="chevron" size={14} /></button>
          </div>
          <div class="small muted">{q?.outUsd != null ? fmtUsd(q.outUsd) : ' '}{impact != null && Math.abs(impact) >= 0.01 && <span class={impact < -3 ? 'red' : ''}> ({impact > 0 ? '+' : ''}{impact.toFixed(2)}%)</span>}</div>
        </div>

        <div class="row between">
          <span class="small muted">{t('swap.maxSlippageLong')}</span>
          <div class="pills">{SLIPPAGES.map((s) => <button class={`pill ${slippage === s ? 'active' : ''}`} onClick={() => setSlippage(s)}>{s / 100}%</button>)}</div>
        </div>

        {tooMuch && <div class="error small">{t('swap.insufficient', { symbol: from.symbol })}</div>}
        {impact != null && impact < -5 && <div class="warn small">{richText(t('swap.highImpactWarn'), { impact: <b>{t('swap.highImpact', { pct: impact.toFixed(1) })}</b> })}</div>}

        {quotes && quotes.length > 0 && (
          <div class="col" style={{ gap: '0.375rem' }}>
            <div class="section-title">{tn('swap.compare', quotes.length)}</div>
            {quotes.map((x, i) => (
              <button class={`quote ${i === 0 ? 'best' : ''} ${i === selected ? 'sel' : ''}`} onClick={() => setSelected(i)}>
                <div class="row between">
                  <span class="bold">{x.provider} {i === 0 && <span class="badge green">{t('swap.best')}</span>}</span>
                  <span class="bold">{fmtNum(toFloat(x.amountOut, to.decimals))} {to.symbol}</span>
                </div>
                <div class="row between small muted">
                  <span>{t('swap.networkFee', { amount: x.gasUsd != null ? fmtUsd(x.gasUsd) : `${fmtAmount(x.gasCostWei, chain.native.decimals, 8)} ${chain.native.symbol}` })}</span>
                  <span>{x.netUsd != null ? t('swap.net', { amount: fmtUsd(x.netUsd) }) : x.outUsd != null ? fmtUsd(x.outUsd) : ''}</span>
                </div>
              </button>
            ))}
            <div class="tiny muted">{drv.swapNote ? drv.swapNote(chain) : <>{t('swap.sortedBy')} {qErrors.length > 0 && t('swap.unavailableProviders', { list: qErrors.map((e) => e.provider).join(', ') })}</>}</div>
          </div>
        )}
        {quotes && !quotes.length && !quoting && <div class="error small">{drv.swapNoQuotes ? drv.swapNoQuotes(qErrors) : <>{t('swap.noQuotes')} {qErrors.map((e) => `${e.provider}: ${e.error}`).join(' · ')}</>}</div>}
        {busy && <div class="info row"><Spinner /> {busy}</div>}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer">
        <Btn loading={!!busy} disabled={!q || tooMuch || quoting} onClick={start}>
          {q ? (!from.native && drv.features.approvals ? t('common.continue') : t('swap.review')) : t('swap.enterAmount')}
        </Btn>
      </div>
      {picker && (
        <TokenPicker allowCustom tokens={allTokens.filter((x) => x.address !== (picker === 'from' ? to.address : from.address))}
          title={picker === 'from' ? t('swap.pickFrom') : t('swap.pickTo')}
          onPick={(x) => (picker === 'from' ? setFrom(x) : setTo(x))} onClose={() => setPicker(null)} />
      )}
    </div>
  );
}
