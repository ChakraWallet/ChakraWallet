// TON swap (Android app): live quotes from Omniston (STON.fi aggregator: STON.fi, DeDust, Tonco...), messages built
// by Omniston, signed here like any TON send. 1% maximum slippage, no fee added by Chakra.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon, TokenIcon, Btn, Sheet, TopBar, Spinner, SuccessMark, useApp } from '../components.jsx';
import { bg } from '../../shared/ext.js';
import { fmtNum, fmtUsd, parseAmount, rawToInput } from '../../shared/format.js';
import { t } from '../../shared/i18n.js';
import { Address } from '../../shared/ton/core.js';
import { stonAsset, tonWaitApplied, tonTxUrl } from '../../shared/ton/api.js';
import { omnistonQuotes, POPULAR_JETTONS } from '../../shared/ton/swap.js';
import { useTonWallet, useTonPortfolio, invalidateTon } from './hooks.js';
import { units } from './home.jsx';

const key = (master) => (master ? Address.parse(master).toRawString() : null); // one form for every address spelling
const GAS_RESERVE = 150_000_000n; // GRAM kept for the swap's gas when swapping GRAM with Max

export function TonSwap() {
  const { chain, account, authorize, reset } = useApp();
  const w = useTonWallet();
  const { data, reload } = useTonPortfolio(chain, w?.raw);
  const [from, setFrom] = useState(null); // null = GRAM
  const [to, setTo] = useState(key(POPULAR_JETTONS[0]));
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState(null);
  const [qState, setQState] = useState('idle'); // idle | quoting | live | none | error
  const [info, setInfo] = useState({}); // jetton key -> { symbol, decimals, image, price }
  const [picker, setPicker] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const session = useRef(null);

  // token data: held jettons (balances) + well-known ones (STON.fi asset list)
  const held = useMemo(() => Object.fromEntries((data?.jettons || []).map((j) => [key(j.master), j])), [data]);
  useEffect(() => {
    for (const m of POPULAR_JETTONS) {
      const k = key(m);
      if (info[k]) continue;
      stonAsset(Address.parse(m).toRawString()).then((a) => a.known && setInfo((x) => ({ ...x, [k]: { symbol: a.symbol, decimals: a.decimals ?? 9, image: a.image, price: a.price } }))).catch(() => {});
    }
  }, []);
  const tok = (k) => (k == null
    ? { symbol: chain.native.symbol, decimals: 9, color: chain.color, price: data?.gram.price, balance: data?.gram.balance ?? 0n }
    : { ...(info[k] || {}), ...(held[k] ? { symbol: held[k].symbol, decimals: held[k].decimals, image: held[k].image, price: held[k].price, balance: held[k].balance } : { balance: 0n }) });
  const fromT = tok(from), toT = tok(to);
  const raw = fromT.decimals != null ? parseAmount(amount, fromT.decimals) : null;
  const tooMuch = raw != null && raw > (fromT.balance ?? 0n);

  // live quotes (debounced): a new session for every change of tokens or amount
  useEffect(() => {
    session.current?.stop(); session.current = null;
    setQuote(null); setErr('');
    if (!raw || raw <= 0n || tooMuch || from === to || toT.decimals == null || done) { setQState('idle'); return undefined; }
    setQState('quoting');
    const tm = setTimeout(() => {
      session.current = omnistonQuotes({ from, to, units: raw }, {
        onQuote: (q) => { setQuote(q); setQState('live'); },
        onNone: () => setQState((s) => (s === 'live' ? s : 'none')),
        onError: () => setQState((s) => (s === 'live' ? s : 'error')),
      });
    }, 600);
    return () => { clearTimeout(tm); session.current?.stop(); session.current = null; };
  }, [from, to, amount, toT.decimals, !!done]);

  const setMax = () => {
    let v = fromT.balance ?? 0n;
    if (from == null) v = v > GAS_RESERVE ? v - GAS_RESERVE : 0n;
    setAmount(rawToInput(v, fromT.decimals ?? 9));
  };

  const swap = async () => {
    setBusy(true); setErr('');
    try {
      const messages = await session.current.build(quote, w.address);
      const need = messages.reduce((s, m) => s + BigInt(m.value), 0n) + 30_000_000n; // + the wallet's own fee
      if (need > data.gram.balance) throw new Error(t('ton.swap.needGram', { amount: fmtNum(units(need, 9), 3), symbol: chain.native.symbol }));
      const r = await authorize((password) => bg('tonSend', { from: account.address, chainId: chain.id, messages, password }), t('ton.swap.confirmTitle'));
      const q = quote;
      session.current?.stop(); session.current = null;
      invalidateTon(chain.id, w.raw);
      setDone({ status: 'pending', q, fromT, toT });
      tonWaitApplied(chain, r.wallet, r.seqno, { hash: r.hash })
        .then((x) => { setDone((d) => ({ ...d, status: 'ok', txHash: x.txHash })); reload(); })
        .catch(() => setDone((d) => ({ ...d, status: 'late' })));
    } catch (e) {
      if (!e.cancelled) setErr(e.info?.reason === 'QUOTE_VALIDATION_FAILED' ? t('ton.swap.buildFailed') : e.message);
    }
    setBusy(false);
  };

  if (w === null) return <div class="screen"><TopBar title={t('home.swap')} /><div class="content"><div class="error">{t('ton.noKey.body')}</div></div></div>;
  if (!w || !data) return <div class="screen"><TopBar title={t('home.swap')} /><div class="content" style={{ alignItems: 'center' }}><Spinner lg /></div></div>;

  if (done) {
    const url = tonTxUrl(chain, done.txHash);
    return (
      <div class="screen">
        <div class="content" style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          {done.status === 'pending' ? <Spinner lg /> : <SuccessMark />}
          <h2 style={{ margin: 0 }}>{done.status === 'ok' ? t('ton.swap.done') : t('ton.swap.sent')}</h2>
          <div class="muted">{fmtNum(units(done.q.inputUnits, done.fromT.decimals))} {done.fromT.symbol} → ≈ {fmtNum(units(done.q.outputUnits, done.toT.decimals))} {done.toT.symbol}</div>
          <div class="small muted">{done.status === 'pending' ? t('ton.send.waiting') : done.status === 'late' ? t('ton.send.late') : ''}</div>
          {url && <a href={url} target="_blank" class="btn secondary sm"><Icon name="external" size={14} /> {t('send.viewOnExplorer')}</a>}
        </div>
        <div class="footer"><Btn onClick={() => reset('home')}>{t('send.done')}</Btn></div>
      </div>
    );
  }

  const outAmt = quote ? units(quote.outputUnits, toT.decimals) : null;
  const choices = (side) => {
    const keys = [null, ...Object.keys(held), ...(side === 'to' ? POPULAR_JETTONS.map(key).filter((k) => !held[k]) : [])];
    return keys.filter((k) => k !== (side === 'to' ? from : to)).map((k) => ({ k, ...tok(k) })).filter((x) => x.symbol);
  };
  return (
    <div class="screen">
      <TopBar title={t('home.swap')} />
      <div class="content">
        <div class="card col" style={{ gap: '0.375rem' }}>
          <div class="row between small muted"><span>{t('swap.from')}</span><span>{t('swap.balance', { amount: fmtNum(units(fromT.balance ?? 0n, fromT.decimals ?? 9)) })} <button class="link" onClick={setMax}>{t('send.max')}</button></span></div>
          <div class="row">
            <input class="input big" style={{ border: 0, padding: '0.25rem 0', background: 'transparent', boxShadow: 'none' }} inputMode="decimal" placeholder="0" value={amount} onInput={(e) => setAmount(e.target.value)} />
            <button class="token-select" onClick={() => setPicker('from')}><TokenIcon sm symbol={fromT.symbol || '?'} icon={fromT.image} color={fromT.color} />{fromT.symbol}<Icon name="chevron" size={14} /></button>
          </div>
          <div class="small muted">{raw && fromT.price != null ? fmtUsd(units(raw, fromT.decimals) * fromT.price) : ' '}</div>
        </div>
        <button class="swap-flip" onClick={() => { setFrom(to); setTo(from); setAmount(''); }} title={t('swap.flip')}><Icon name="swap" /></button>
        <div class="card col" style={{ gap: '0.375rem' }}>
          <div class="row between small muted"><span>{t('swap.toEst')}</span><span>{t('swap.balance', { amount: fmtNum(units(toT.balance ?? 0n, toT.decimals ?? 9)) })}</span></div>
          <div class="row">
            <div class="grow" style={{ fontSize: '1.375rem', fontWeight: 650 }}>{qState === 'quoting' ? <Spinner /> : outAmt != null ? fmtNum(outAmt) : '0'}</div>
            <button class="token-select" onClick={() => setPicker('to')}><TokenIcon sm symbol={toT.symbol || '?'} icon={toT.image} color={toT.color} />{toT.symbol || '…'}<Icon name="chevron" size={14} /></button>
          </div>
          <div class="small muted">{outAmt != null && toT.price != null ? fmtUsd(outAmt * toT.price) : ' '}</div>
        </div>
        {tooMuch && <div class="error small">{t('send.overBalance')}</div>}
        {qState === 'none' && <div class="warn small">{t('ton.swap.noRoute')}</div>}
        {qState === 'error' && <div class="error small">{t('ton.swap.unreachable')}</div>}
        {quote && (
          <div class="card kv">
            <span class="k">{t('ton.swap.rate')}</span><span class="v">1 {fromT.symbol} = {fmtNum(units(quote.outputUnits, toT.decimals) / units(quote.inputUnits, fromT.decimals))} {toT.symbol}</span>
            <span class="k">{t('ton.swap.min')}</span><span class="v">{fmtNum(units(quote.minOutput, toT.decimals))} {toT.symbol}</span>
            {quote.impactPips != null && <><span class="k">{t('ton.swap.impact')}</span><span class={`v ${quote.impactPips > 30000 ? 'red' : ''}`}>{(quote.impactPips / 10000).toFixed(2)}%</span></>}
            <span class="k">{t('ton.swap.route')}</span><span class="v">{quote.protocols.join(' · ') || quote.resolver || 'Omniston'}</span>
            <span class="k">{t('ton.swap.gas')}</span><span class="v">≈ {fmtNum(units(quote.gasBudget, 9), 3)} {chain.native.symbol}</span>
          </div>
        )}
        {quote && <div class="tiny muted">{t('ton.swap.note')}</div>}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="footer"><Btn loading={busy} disabled={!quote || busy || tooMuch} onClick={swap}>{t('home.swap')}</Btn></div>
      {picker && (
        <Sheet title={t('send.pickToken')} onClose={() => setPicker(null)}>
          <div class="list">
            {choices(picker).map((c) => (
              <button class={`item ${(picker === 'from' ? from : to) === c.k ? 'sel' : ''}`} onClick={() => { if (picker === 'from') setFrom(c.k); else setTo(c.k); setAmount(''); setPicker(null); }}>
                <TokenIcon symbol={c.symbol} icon={c.image} color={c.color} />
                <div class="grow"><div class="bold">{c.symbol}</div></div>
                <span class="small muted">{c.balance > 0n ? fmtNum(units(c.balance, c.decimals ?? 9)) : ''}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}
