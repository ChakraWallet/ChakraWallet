import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { bg } from '../../shared/ext.js';
import { NATIVE } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { erc20, getAllowance, waitForReceipt } from '../../shared/rpc.js';
import { getPrices, tokenPriceKey } from '../../shared/prices.js';
import { getFeeData, prepareTx, finalizeTx } from '../../shared/tx.js';
import { getQuotes, swapSupported } from '../../shared/swap.js';
import { fmtNum, fmtUsd, parseAmount, rawToInput, fmtAmount, toFloat } from '../../shared/format.js';
import { TopBar, Btn, TokenIcon, Icon, FeeBox, Spinner, useApp, explorerTx, Empty, SuccessMark, richText } from '../components.jsx';
import { TokenPicker, useTokenList } from './send.jsx';
import { WRONG_PASSWORD } from '../auth.jsx';
import { t, tn } from '../../shared/i18n.js';

const SLIPPAGES = [10, 50, 100, 300]; // bps
// translated text with {name} slots filled by JSX nodes (e.g. bold parts)

export function Swap({ fromAddress }) {
  const { chain, account, reset, authorize } = useApp();
  // one authorization covers the whole swap (token approval + swap): the password is kept only
  // in this screen's memory between the two transactions and dropped after the swap or on exit
  const authPw = useRef(null);
  useEffect(() => () => { authPw.current = null; }, []);
  const sendAuthorized = async (params, keep) => {
    const send = (password) => bg('sendTransaction', { ...params, password });
    if (authPw.current) {
      try { const h = await send(authPw.current); if (!keep) authPw.current = null; return h; } catch (e) { authPw.current = null; if (e.key !== WRONG_PASSWORD) throw e; }
    }
    return authorize(async (password) => { const h = await send(password); if (keep) authPw.current = password; return h; }, t('swap.confirmTitle'));
  };
  const { tokens: owned, data } = useTokenList();
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(50);
  const [picker, setPicker] = useState(null);
  const [quotes, setQuotes] = useState(null);
  const [qErrors, setQErrors] = useState([]);
  const [selected, setSelected] = useState(0);
  const [quoting, setQuoting] = useState(false);
  const [ctx, setCtx] = useState(null); // {gasPrice, nativePrice, priceIn, priceOut}
  const [step, setStep] = useState('form');
  const [prepared, setPrepared] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [hash, setHash] = useState('');
  const [needsApproval, setNeedsApproval] = useState(false);
  const qid = useRef(0);

  const allTokens = useMemo(() => {
    const map = new Map(owned.map((t) => [t.address, t]));
    for (const t of POPULAR_TOKENS[chain.id] || []) if (!map.has(t.address)) map.set(t.address, { ...t, amount: 0, balance: '0' });
    return [...map.values()];
  }, [owned, chain.id]);

  useEffect(() => {
    if (!data) return;
    if (!from) setFrom(allTokens.find((t) => t.address === (fromAddress || NATIVE)) || allTokens[0]);
    if (!to) setTo(allTokens.find((t) => t.symbol === 'USDC' && t.address !== (fromAddress || NATIVE)) || allTokens[1]);
  }, [data]);

  const raw = from ? parseAmount(amount, from.decimals) : null;
  const balance = BigInt(from?.balance || 0);

  // fetch quotes (debounced)
  useEffect(() => {
    setQuotes(null); setQErrors([]); setSelected(0);
    if (!from || !to || !raw || raw <= 0n || from.address === to.address) return;
    const id = ++qid.current;
    const t = setTimeout(async () => {
      setQuoting(true);
      try {
        const [fee, prices] = await Promise.all([
          getFeeData(chain),
          getPrices([chain.native.priceId, tokenPriceKey(chain, from.address), tokenPriceKey(chain, to.address)]),
        ]);
        const priceOf = (t) => (t.address === NATIVE ? prices[chain.native.priceId] : prices[tokenPriceKey(chain, t.address)] ?? t.price ?? null);
        const c = { gasPrice: fee.speeds.normal.effective, nativePrice: prices[chain.native.priceId] ?? null, priceIn: priceOf(from), priceOut: priceOf(to) };
        const r = await getQuotes({
          chainId: chain.id, tokenIn: from.address, tokenOut: to.address, amountIn: raw, decIn: from.decimals, decOut: to.decimals,
          from: account.address, slippageBps: slippage, gasPrice: c.gasPrice, priceOut: c.priceOut, nativePrice: c.nativePrice,
        });
        if (id !== qid.current) return;
        setCtx(c); setQuotes(r.quotes); setQErrors(r.errors);
      } catch (e) { if (id === qid.current) setQErrors([{ provider: 'Chakra', error: e.message }]); }
      if (id === qid.current) setQuoting(false);
    }, 600);
    return () => clearTimeout(t);
  }, [from?.address, to?.address, amount, slippage, chain.id]);

  const q = quotes?.[selected];
  const inUsd = raw && ctx?.priceIn != null ? toFloat(raw, from.decimals) * ctx.priceIn : null;
  const impact = q?.outUsd != null && inUsd ? ((q.outUsd - inUsd) / inUsd) * 100 : null;

  if (!swapSupported(chain.id) || !chain.swap) {
    return <div class="screen"><TopBar title={t('swap.title')} /><div class="content"><Empty>{t('swap.unavailable', { chain: chain.name })}</Empty></div></div>;
  }
  if (!from || !to) return <div class="screen"><TopBar title={t('swap.title')} /><div class="content"><div class="empty"><Spinner /></div></div></div>;

  // ---------- actions
  const start = async () => {
    setErr(''); setBusy(t('swap.checkingApproval'));
    try {
      let approval = false;
      if (from.address !== NATIVE) {
        const allowance = await getAllowance(chain, from.address, account.address, q.spender);
        approval = allowance < raw;
      }
      setNeedsApproval(approval);
      if (approval) {
        setPrepared(null); setStep('approve');
        setPrepared(await prepareTx(chain, account.address, { to: from.address, value: '0', data: erc20.encodeFunctionData('approve', [q.spender, raw]) }));
      } else {
        await buildSwap();
      }
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const buildSwap = async () => {
    setPrepared(null); setStep('swap');
    try {
      const tx = await q.build();
      const p = await prepareTx(chain, account.address, { to: tx.to, data: tx.data, value: tx.value });
      setPrepared(p);
    } catch (e) { setErr(t('swap.prepareFailed', { error: e.message })); }
  };

  const sendApproval = async () => {
    setErr(''); setBusy(t('swap.sendingApproval'));
    try {
      const h = await sendAuthorized({ from: account.address, tx: finalizeTx(prepared, speed), title: t('swap.approvalTxTitle', { symbol: from.symbol }) }, true);
      setBusy(t('swap.waitingNetwork'));
      const rc = await waitForReceipt(chain, h);
      if (rc.status !== '0x1') throw new Error(t('swap.approvalFailed'));
      setBusy(t('swap.preparing'));
      await buildSwap();
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };

  const sendSwap = async () => {
    setErr(''); setBusy(t('swap.sending'));
    try {
      const h = await sendAuthorized({ from: account.address, tx: finalizeTx(prepared, speed), title: t('swap.txTitle', { amount: fmtNum(toFloat(raw, from.decimals)), from: from.symbol, to: to.symbol, provider: q.provider }) }, false);
      setHash(h); setStep('done');
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };

  const Summary = () => (
    <div class="card col" style={{ gap: '0.625rem' }}>
      <div class="row between">
        <div class="row"><TokenIcon symbol={from.symbol} icon={from.icon} color={from.address === NATIVE ? chain.color : undefined} /><div><div class="small muted">{t('swap.youPay')}</div><div class="bold">{fmtAmount(raw, from.decimals)} {from.symbol}</div></div></div>
        <div class="small muted right">{inUsd != null && fmtUsd(inUsd)}</div>
      </div>
      <div class="row between">
        <div class="row"><TokenIcon symbol={to.symbol} icon={to.icon} color={to.address === NATIVE ? chain.color : undefined} /><div><div class="small muted">{t('swap.youReceiveEst')}</div><div class="bold green">{fmtAmount(q.amountOut, to.decimals)} {to.symbol}</div></div></div>
        <div class="small muted right">{q.outUsd != null && fmtUsd(q.outUsd)}</div>
      </div>
      <div class="kv">
        <span class="k">{t('swap.minReceived')}</span><span class="v">{fmtAmount(q.minOut, to.decimals)} {to.symbol}</span>
        <span class="k">{t('swap.maxSlippage')}</span><span class="v">{slippage / 100}%</span>
        <span class="k">{t('swap.via')}</span><span class="v">{q.provider}</span>
      </div>
    </div>
  );

  if (step === 'done') {
    const link = explorerTx(chain, hash);
    return (
      <div class="screen">
        <div class="content" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <SuccessMark />
          <h2 style={{ margin: 0 }}>{t('swap.sent')}</h2>
          <div class="muted">{fmtAmount(raw, from.decimals)} {from.symbol} → ~{fmtAmount(q.amountOut, to.decimals)} {to.symbol}</div>
          {link && <a href={link} target="_blank" class="btn secondary sm"><Icon name="external" size={14} /> {t('send.viewOnExplorer')}</a>}
        </div>
        <div class="footer"><Btn onClick={() => reset('home')}>{t('send.done')}</Btn></div>
      </div>
    );
  }

  if (step === 'approve' || step === 'swap') {
    return (
      <div class="screen">
        <TopBar title={step === 'approve' ? t('swap.step1') : needsApproval ? t('swap.step2') : t('swap.confirmTitle')} onBack={() => { setStep('form'); setErr(''); }} />
        <div class="content">
          {needsApproval && <div class="steps"><div class="s on" /><div class={`s ${step === 'swap' ? 'on' : ''}`} /></div>}
          {step === 'approve' && (
            <div class="info small">
              {richText(t('swap.approveInfo', { provider: q.provider }), { token: <b>{from.symbol}</b>, exact: <b>{t('swap.exactly', { amount: fmtAmount(raw, from.decimals), symbol: from.symbol })}</b> })}
            </div>
          )}
          <Summary />
          <FeeBox chain={chain} prepared={prepared} speed={speed} setSpeed={setSpeed} nativePrice={ctx?.nativePrice}
            valueWei={step === 'swap' && from.address === NATIVE ? raw : 0n}
            valueUsd={step === 'swap' && from.address !== NATIVE ? inUsd : null}
            extraRows={step === 'swap' ? [{ k: t('swap.aggFee'), v: t('swap.aggFeeValue'), sub: t('swap.aggFeeSub') }] : []} />
          {busy && <div class="info row"><Spinner /> {busy}</div>}
          {err && <div class="error">{err}</div>}
        </div>
        <div class="footer">
          <Btn kind="secondary" onClick={() => { setStep('form'); setErr(''); }}>{t('common.cancel')}</Btn>
          {step === 'approve'
            ? <Btn loading={!!busy} disabled={!prepared} onClick={sendApproval}>{t('swap.approve')}</Btn>
            : <Btn loading={!!busy} disabled={!prepared} onClick={sendSwap}>{t('swap.confirmTitle')}</Btn>}
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
          <div class="row between small muted"><span>{t('swap.from')}</span><span>{t('swap.balance', { amount: fmtNum(from.amount ?? 0) })} <button class="link" onClick={() => setAmount(rawToInput(from.address === NATIVE ? (balance * 97n) / 100n : balance, from.decimals))}>{t('send.max')}</button></span></div>
          <div class="row">
            <input class="input big" style={{ border: 0, padding: '0.25rem 0', background: 'transparent', boxShadow: 'none' }} inputMode="decimal" placeholder="0" value={amount} onInput={(e) => setAmount(e.target.value)} />
            <button class="token-select" onClick={() => setPicker('from')}><TokenIcon sm symbol={from.symbol} icon={from.icon} color={from.address === NATIVE ? chain.color : undefined} />{from.symbol}<Icon name="chevron" size={14} /></button>
          </div>
          <div class="small muted">{inUsd != null ? fmtUsd(inUsd) : ' '}</div>
        </div>
        <button class="swap-flip" onClick={() => { setFrom(to); setTo(from); setAmount(''); }} title={t('swap.flip')}><Icon name="swap" /></button>
        <div class="card col" style={{ gap: '0.375rem' }}>
          <div class="row between small muted"><span>{t('swap.toEst')}</span><span>{t('swap.balance', { amount: fmtNum(to.amount ?? 0) })}</span></div>
          <div class="row">
            <div class="grow" style={{ fontSize: '1.375rem', fontWeight: 650 }}>{quoting ? <Spinner /> : q ? fmtNum(toFloat(q.amountOut, to.decimals)) : '0'}</div>
            <button class="token-select" onClick={() => setPicker('to')}><TokenIcon sm symbol={to.symbol} icon={to.icon} color={to.address === NATIVE ? chain.color : undefined} />{to.symbol}<Icon name="chevron" size={14} /></button>
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
                  <span>{t('swap.networkFee', { amount: x.gasUsd != null ? fmtUsd(x.gasUsd) : `${fmtAmount(x.gasCostWei, 18, 8)} ${chain.native.symbol}` })}</span>
                  <span>{x.netUsd != null ? t('swap.net', { amount: fmtUsd(x.netUsd) }) : x.outUsd != null ? fmtUsd(x.outUsd) : ''}</span>
                </div>
              </button>
            ))}
            <div class="tiny muted">{t('swap.sortedBy')} {qErrors.length > 0 && t('swap.unavailableProviders', { list: qErrors.map((e) => e.provider).join(', ') })}</div>
          </div>
        )}
        {quotes && !quotes.length && !quoting && <div class="error small">{t('swap.noQuotes')} {qErrors.map((e) => `${e.provider}: ${e.error}`).join(' · ')}</div>}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer">
        <Btn loading={!!busy} disabled={!q || tooMuch || quoting} onClick={start}>
          {q ? (from.address !== NATIVE ? t('common.continue') : t('swap.review')) : t('swap.enterAmount')}
        </Btn>
      </div>
      {picker && (
        <TokenPicker allowCustom tokens={allTokens.filter((t) => t.address !== (picker === 'from' ? to.address : from.address))}
          title={picker === 'from' ? t('swap.pickFrom') : t('swap.pickTo')}
          onPick={(t) => (picker === 'from' ? setFrom(t) : setTo(t))} onClose={() => setPicker(null)} />
      )}
    </div>
  );
}
