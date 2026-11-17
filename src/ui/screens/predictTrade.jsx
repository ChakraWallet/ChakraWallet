// Predictions: buy / sell sheet, deposit / withdraw, open orders. Every action asks for the fingerprint or the
// password once (authorize) and then runs its steps (API key, approval, signature, sending).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Icon, Btn, Sheet, Spinner, SuccessMark, TokenIcon, Avatar, useApp } from '../components.jsx';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { t, locale } from '../../shared/i18n.js';
import { feePerShare } from '../../shared/polytrade.js';
import { C } from '../../shared/polytrade.js';
import {
  polyAccount, bookOf, balances, shareBalance, quoteMarket, placeOrder, deposit, withdraw, rampState,
  openOrders, cancelOrder, hasCreds, ensureCreds, SLIPPAGE,
  hasRelayerKey, setRelayerKey, emergencyState, emergencyPause, emergencyUnpause, emergencyWithdraw,
} from '../polyClient.js';

const TOK = Object.fromEntries((POPULAR_TOKENS[137] || []).map((x) => [x.address, x]));
TOK.usdc = TOK[C.usdc.toLowerCase()]; TOK.usdce = TOK[C.usdce.toLowerCase()];
const PUSD = TOK[C.pusd.toLowerCase()] || {};
const usd = (n) => (n == null || !isFinite(n) ? '–' : n.toLocaleString(locale(), { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cents = (p) => (p == null || !isFinite(p) ? '–' : `${(p * 100).toFixed(p < 0.01 || p > 0.99 ? 1 : p * 100 % 1 ? 1 : 0)}¢`);
const num = (s) => { const v = Number(String(s || '').replace(',', '.')); return isFinite(v) ? v : 0; };
const fmtN = (n, d = 2) => (n == null || !isFinite(n) ? '–' : n.toLocaleString(locale(), { maximumFractionDigits: d }));
const outcomeName = (n) => ({ Yes: t('predict.yes'), No: t('predict.no') }[n] || n);
const raw6 = (x) => BigInt(Math.floor(x * 1e6 + 1e-6));
/** Best price you'd get right now: lowest ask to buy, highest bid to sell (null if nobody is there). */
const bestOf = (book, side) => {
  const l = (side === 'BUY' ? book?.asks : book?.bids) || [];
  if (!l.length) return null;
  const ps = l.map((x) => Number(x.price));
  return side === 'BUY' ? Math.min(...ps) : Math.max(...ps);
};

/** The Polymarket account of the current address (own address or its Polymarket Safe). */
export function usePolyAccount() {
  const { account } = useApp();
  const [acc, setAcc] = useState(null);
  useEffect(() => { setAcc(null); polyAccount(account.address).then(setAcc).catch(() => setAcc({ mode: 'error' })); }, [account.address]);
  return acc;
}

function Steps({ step, steps }) {
  const i = steps.indexOf(step);
  return (
    <div class="pt-steps">
      {steps.map((s, k) => (
        <div class={`pt-step ${k < i ? 'done' : k === i ? 'now' : ''}`}>
          <span class="pt-step-dot">{k < i ? <Icon name="check" size={13} stroke={3} /> : k === i ? <Spinner /> : null}</span>
          <span>{t(`predict.step.${s}`)}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ buy / sell
/**
 * market: { question, conditionId, outcomes: [{ name, token, price }] }. side: 'BUY' | 'SELL'.
 * lockSide: selling from the portfolio (no switch to buying, one outcome).
 */
export function TradeSheet({ market, outcome = 0, side: side0 = 'BUY', lockSide, acc, onClose, onDone }) {
  const { authorize } = useApp();
  const [side, setSide] = useState(side0);
  const [oi, setOi] = useState(outcome);
  const [kind, setKind] = useState('market');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [expiry, setExpiry] = useState('gtc');
  const [slip, setSlip] = useState(SLIPPAGE);
  const [book, setBook] = useState(null);
  const fee = market.fee || null; // from Gamma (feeSchedule); unknown when selling from the portfolio
  const [bal, setBal] = useState(null);
  const [owned, setOwned] = useState(null);
  const [step, setStep] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const o = market.outcomes[oi];
  const token = o?.token;

  // book (refreshed while open), fee, balances
  useEffect(() => {
    let alive = true;
    const load = () => bookOf(token).then((b) => alive && setBook(b)).catch((e) => alive && setErr(e.message));
    setBook(null); load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 6000);
    return () => { alive = false; clearInterval(id); };
  }, [token]);
  useEffect(() => { if (acc?.mode && acc.mode !== 'readonly' && acc.mode !== 'error') balances(acc).then(setBal).catch(() => setBal(null)); }, [acc, result]);
  useEffect(() => { if (acc?.wallet && token) shareBalance(acc, token).then((x) => setOwned(Number(x) / 1e6)).catch(() => setOwned(null)); }, [acc, token, result]);
  const [errKey, setErrKey] = useState('');
  useEffect(() => { setErr(''); setErrKey(''); }, [side, oi, kind, amount, price]);

  const cash = bal ? Number(bal.pusd) / 1e6 : null;
  const a = num(amount), lp = num(price) / 100;
  const isBuy = side === 'BUY';

  // estimate
  const est = useMemo(() => {
    if (!book) return null;
    if (kind === 'limit') {
      if (!(lp > 0 && a > 0)) return null;
      const cost = lp * a, f = feePerShare(lp, fee) * a;
      return { shares: a, usd: cost, avg: lp, fee: f, limitPrice: lp };
    }
    if (!(a > 0)) return null;
    const q = quoteMarket(book, side, a, slip);
    if (!q.worst) return { empty: true };
    return { ...q, fee: feePerShare(q.avg, fee) * q.shares };
  }, [book, kind, side, a, lp, slip, fee]);

  const minUsd = 1, minShares = book?.minSize || 0;
  let problem = '';
  if (est?.empty) problem = t('predict.err.noLiquidity');
  else if (est && kind === 'market' && !est.complete) problem = t('predict.err.partial');
  if (a > 0 && isBuy && kind === 'market' && a < minUsd) problem = t('predict.err.minUsd', { v: usd(minUsd) });
  if (a > 0 && kind === 'limit' && a < minShares) problem = t('predict.err.minShares', { n: minShares });
  if (a > 0 && kind === 'limit' && lp > 0 && book && (lp < book.tick || lp > 1 - book.tick || Math.abs(Math.round(lp / book.tick) * book.tick - lp) > 1e-9)) problem = t('predict.err.tick', { tick: cents(book.tick) });
  const needCash = isBuy ? (kind === 'limit' ? (est?.usd || 0) + (est?.fee || 0) : a + (est?.fee || 0)) : 0;
  if (isBuy && cash != null && needCash > cash + 1e-9) problem = t('predict.err.noCash');
  if (!isBuy && owned != null && a > owned + 1e-9) problem = t('predict.err.noShares');
  const blocking = problem && problem !== t('predict.err.partial');
  const can = acc && acc.mode !== 'readonly' && acc.mode !== 'error' && est && !est.empty && !blocking && !step;

  const setMax = () => {
    if (isBuy && kind === 'market' && cash != null) {
      const p = bestOf(book, 'BUY') ?? 0.5;
      const rate = feePerShare(p, fee) / p; // fee per dollar spent
      setAmount(String(Math.floor((cash / (1 + rate)) * 100) / 100));
    } else if (!isBuy && owned != null) setAmount(String(Math.floor(owned * 100) / 100));
  };
  const add = (x) => setAmount(String(Math.round((a + x) * 100) / 100));

  const submit = async () => {
    setErr(''); setResult(null);
    const expiration = kind === 'limit' && expiry !== 'gtc' ? Math.floor(Date.now() / 1000) + (expiry === '1d' ? 86400 : 7 * 86400) + 60 : 0;
    try {
      const r = await authorize(async (password) => placeOrder(acc, {
        tokenId: token, side, kind, book, expiration,
        amount: kind === 'market' && isBuy ? Math.floor(a * 100) / 100 : a,
        price: kind === 'limit' ? lp : est.limitPrice,
      }, password, setStep), isBuy ? t('predict.confirmBuy') : t('predict.confirmSell'));
      setResult(r); onDone?.();
    } catch (e) { if (!e.cancelled) { setErr(e.message); setErrKey(e.key || ''); } }
    setStep(null);
  };

  const steps = ['auth', 'approve', 'sign', 'send'];
  if (result) {
    const matched = result.status === 'matched';
    const shares = isBuy ? result.taking : result.making, spent = isBuy ? result.making : result.taking;
    return (
      <Sheet title={isBuy ? t('predict.buy') : t('predict.sell')} onClose={onClose}>
        <div class="pt-done">
          <SuccessMark />
          <h3>{matched ? (isBuy ? t('predict.done.bought') : t('predict.done.sold')) : t('predict.done.live')}</h3>
          <p class="muted">
            {matched && shares > 0 ? t(isBuy ? 'predict.done.boughtBody' : 'predict.done.soldBody', { n: fmtN(shares), outcome: outcomeName(o.name), usd: usd(spent), avg: cents(spent / shares) })
              : t('predict.done.liveBody')}
          </p>
        </div>
        <Btn onClick={onClose}>{t('predict.done.ok')}</Btn>
      </Sheet>
    );
  }

  return (
    <Sheet title={market.question} onClose={onClose}>
      {!acc ? <div class="pm-center"><Spinner /></div> : acc.mode === 'readonly' || acc.mode === 'error' ? (
        <div class="pt-ro"><Icon name="lock" size={22} /><span>{t(acc.reason || 'predict.acc.error')}</span></div>
      ) : (
        <div class="pt">
          {!lockSide && (
            <div class="tabs pt-side">
              <button class={`tab ${isBuy ? 'active' : ''}`} onClick={() => { setSide('BUY'); setAmount(''); }}>{t('predict.buy')}</button>
              <button class={`tab ${!isBuy ? 'active' : ''}`} onClick={() => { setSide('SELL'); setAmount(''); }}>{t('predict.sell')}</button>
            </div>
          )}
          {market.outcomes.length > 1 && !lockSide && (
            <div class="pt-outs">
              {market.outcomes.slice(0, 2).map((x, i) => (
                <button class={`pt-out ${i ? 'no' : 'yes'} ${oi === i ? 'on' : ''}`} onClick={() => setOi(i)}>
                  <span>{outcomeName(x.name)}</span><b>{cents(i === oi ? (bestOf(book, side) ?? x.price) : x.price)}</b>
                </button>
              ))}
            </div>
          )}

          <div class="pt-amount">
            <label>{kind === 'market' && isBuy ? t('predict.amountUsd') : t('predict.amountShares')}</label>
            <div class="input-wrap">
              {kind === 'market' && isBuy && <span class="pt-cur">$</span>}
              <input inputMode="decimal" value={amount} onInput={(e) => setAmount(e.target.value)} placeholder="0" />
              <button class="pt-max" onClick={setMax}>{t('predict.max')}</button>
            </div>
            <div class="pt-avail small muted">
              {isBuy ? t('predict.available', { v: cash != null ? usd(cash) : '…' }) : t('predict.owned', { n: owned != null ? fmtN(owned) : '…' })}
            </div>
            {kind === 'market' && isBuy && <div class="pt-chips">{[1, 5, 10, 25].map((x) => <button onClick={() => add(x)}>+{x} $</button>)}</div>}
          </div>

          {kind === 'limit' && (
            <div class="pt-limit">
              <div class="field">
                <label>{t('predict.limitPrice')}</label>
                <div class="input-wrap"><input inputMode="decimal" value={price} onInput={(e) => setPrice(e.target.value)} placeholder={book?.last != null ? String(Math.round(book.last * 100)) : '50'} /><span class="pt-cur">¢</span></div>
              </div>
              <div class="field">
                <label>{t('predict.expiry')}</label>
                <div class="pills">{['gtc', '1d', '1w'].map((x) => <button class={`pill ${expiry === x ? 'active' : ''}`} onClick={() => setExpiry(x)}>{t(`predict.expiry.${x}`)}</button>)}</div>
              </div>
            </div>
          )}

          {est && !est.empty && (
            <div class="pt-est">
              <div><span>{isBuy ? t('predict.est.shares') : t('predict.est.receive')}</span><b>{isBuy ? fmtN(est.shares) : usd(est.usd)}</b></div>
              <div><span>{t('predict.est.avg')}</span><b>{cents(est.avg)}</b></div>
              {kind === 'market' && <div><span>{isBuy ? t('predict.est.maxPrice', { p: Math.round(slip * 100) }) : t('predict.est.minPrice', { p: Math.round(slip * 100) })}</span><b>{cents(est.limitPrice)}</b></div>}
              {kind === 'limit' && isBuy && <div><span>{t('predict.est.cost')}</span><b>{usd(est.usd)}</b></div>}
              {est.fee > 0.0001 && <div><span>{t('predict.est.fee')}</span><b>{usd(est.fee)}</b></div>}
              {isBuy && <div class="pt-win"><span>{t('predict.est.ifWins')}</span><b>{usd(est.shares)} <small>{est.usd > 0 ? `(+${Math.round(((est.shares - est.usd - (est.fee || 0)) / (est.usd + (est.fee || 0))) * 100)}%)` : ''}</small></b></div>}
            </div>
          )}

          {kind === 'market' && (
            <div class="pt-slip small muted">
              {t('predict.slippage')}
              <span class="pills">{[0.01, 0.03, 0.05].map((x) => <button class={`pill ${slip === x ? 'active' : ''}`} onClick={() => setSlip(x)}>{Math.round(x * 100)}%</button>)}</span>
            </div>
          )}
          <button class="link small pt-adv" onClick={() => { setKind(kind === 'market' ? 'limit' : 'market'); setAmount(''); }}>
            {kind === 'market' ? t('predict.toLimit') : t('predict.toMarket')}
          </button>

          {problem && <div class={blocking ? 'error small' : 'warn small'}>{problem}</div>}
          {err && <div class="error small">{err}</div>}
          {/* this address can't trade directly: create the polymarket.com account (Deposit Wallet) from our browser */}
          {errKey === 'predict.err.eoaNotAllowed' && (
            <Btn kind="secondary" onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('ck-open-url', { detail: 'https://polymarket.com' })); }}>
              <Icon name="external" size={16} /> {t('predict.err.openSite')}
            </Btn>
          )}
          {step && <Steps step={step} steps={steps} />}
          <Btn class={isBuy ? '' : 'pt-sell-btn'} disabled={!can} loading={!!step} onClick={submit}>
            {isBuy ? t('predict.buyBtn', { outcome: outcomeName(o.name) }) : t('predict.sellBtn', { outcome: outcomeName(o.name) })}
          </Btn>
          {acc.mode === 'safe' && <div class="tiny muted center">{t('predict.acc.safeNote')}</div>}
          {acc.mode === 'deposit' && <div class="tiny muted center">{t('predict.acc.depositNote')}</div>}
        </div>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------ deposit / withdraw
export function CashSheet({ kind, acc, onClose, onDone }) {
  const { authorize } = useApp();
  const [bal, setBal] = useState(null);
  const [asset, setAsset] = useState('usdc');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => { balances(acc).then(setBal).catch((e) => setErr(e.message)); }, [acc]);
  const dep = kind === 'deposit';
  // Polymarket may pause the conversion of one asset (it did for native USDC): that option is turned off
  const [to, setTo] = useState('usdc'); // withdraw: what arrives on the address
  const [paused, setPaused] = useState({});
  useEffect(() => {
    let alive = true;
    rampState().then((s) => {
      if (!alive) return;
      const p = dep ? s.deposit : s.withdraw;
      setPaused(p);
      const open = ['usdc', 'usdce'].find((k) => !p[k]);
      if (dep) setAsset((k) => (p[k] && open ? open : k));
      else setTo((k) => (p[k] && open ? open : k));
    });
    return () => { alive = false; };
  }, [dep]);
  const options = dep
    ? [['usdc', 'USDC'], ['usdce', 'USDC.e'], ...(bal?.separate || acc.wallet !== acc.signer ? [['pusdOwn', 'pUSD']] : [])]
    : [['usdc', 'USDC'], ['usdce', 'USDC.e']];
  const choice = dep ? asset : to;
  const allPaused = !dep && paused.usdc && paused.usdce;
  // a Deposit Wallet withdraws through Polymarket's relayer: its key must be linked first
  const [relayer, setRelayer] = useState(null);
  const needsRelayer = !dep && acc.mode === 'deposit';
  useEffect(() => { if (needsRelayer) hasRelayerKey(acc).then(setRelayer); }, [acc]);
  const avail = bal ? Number(dep ? bal[asset] : bal.pusd) / 1e6 : null;
  const a = num(amount);
  const lowGas = bal && bal.pol < 2n * 10n ** 16n && !needsRelayer; // the relayer pays the gas
  const go = async () => {
    setErr(''); setBusy(true);
    try {
      await authorize(async (password) => (dep ? deposit(acc, asset === 'usdc' ? C.usdc : asset === 'usdce' ? C.usdce : C.pusd, raw6(a), password) : withdraw(acc, raw6(a), password, to === 'usdce' ? C.usdce : C.usdc)), dep ? t('predict.deposit') : t('predict.withdraw'));
      setDone(true); onDone?.();
    } catch (e) { if (e.key === 'predict.relayer.needKey') setRelayer(false); else if (!e.cancelled) setErr(e.message); }
    setBusy(false);
  };
  if (done) {
    return (
      <Sheet title={dep ? t('predict.deposit') : t('predict.withdraw')} onClose={onClose}>
        <div class="pt-done"><SuccessMark /><h3>{dep ? t('predict.cash.deposited', { v: usd(a) }) : t('predict.cash.withdrawn', { v: usd(a) })}</h3></div>
        <Btn onClick={onClose}>{t('predict.done.ok')}</Btn>
      </Sheet>
    );
  }
  const ends = [
    <span class="cs-end" key="w"><Avatar address={acc.signer} /><span>{t('predict.cash.wallet')}</span></span>,
    <span class="cs-end" key="p"><TokenIcon symbol="pUSD" icon={PUSD.icon} /><span>Polymarket</span></span>,
  ];
  const pick = (f) => avail != null && setAmount(String(Math.floor(avail * f * 1e6) / 1e6));
  if (needsRelayer && relayer === false) {
    return <Sheet title={t('predict.withdraw')} onClose={onClose}><RelayerSetup acc={acc} onSaved={() => setRelayer(true)} /></Sheet>;
  }
  return (
    <Sheet title={dep ? t('predict.deposit') : t('predict.withdraw')} onClose={onClose}>
      <div class="pt">
        {/* where the money goes: your address <-> Polymarket */}
        <div class="cs-route">{dep ? ends[0] : ends[1]}<span class="cs-arrow"><Icon name="forward" size={16} /></span>{dep ? ends[1] : ends[0]}</div>
        <p class="small muted pt-cash-info">{dep ? t(acc.mode === 'safe' || acc.mode === 'deposit' ? 'predict.cash.depositInfoSafe' : 'predict.cash.depositInfo') : t('predict.cash.withdrawInfo')}</p>
        {!dep && <div class="cs-label small muted">{t('predict.cash.receiveAs')}</div>}
        <div class="cs-assets">
          {options.map(([k, sym]) => {
            const tk = k === 'pusdOwn' ? { ...PUSD, name: t('predict.cash.onAddress') } : TOK[k];
            const off = !!paused[k];
            return (
              <button key={k} class={`cs-asset ${choice === k ? 'on' : ''} ${off ? 'off' : ''}`} disabled={off} onClick={() => (dep ? setAsset(k) : setTo(k))}>
                <TokenIcon symbol={sym} icon={tk?.icon} />
                <span class="cs-name"><b>{sym}</b><small>{off ? t('predict.cash.paused') : tk?.name}</small></span>
                {dep && <span class="cs-bal">{bal ? usd(Number(bal[k]) / 1e6) : '…'}</span>}
                <span class="cs-check"><Icon name="check" size={13} stroke={3} /></span>
              </button>
            );
          })}
        </div>
        <div class="pt-amount">
          <label>{t('predict.amountUsd')}</label>
          <div class="input-wrap">
            <span class="pt-cur">$</span>
            <input inputMode="decimal" value={amount} onInput={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          <div class="cs-quick">
            <span class="pt-avail small muted">{t('predict.available', { v: avail != null ? usd(avail) : '…' })}</span>
            <button onClick={() => pick(0.25)}>25%</button>
            <button onClick={() => pick(0.5)}>50%</button>
            <button onClick={() => pick(1)}>{t('predict.max')}</button>
          </div>
        </div>
        {lowGas && <div class="cs-gas"><TokenIcon sm symbol="POL" /><span>{t('predict.err.lowGas')}</span></div>}
        {allPaused && <div class="cs-gas"><Icon name="warn" size={16} /><span>{t('predict.cash.allPaused')}</span></div>}
        {err && <div class="error small">{err}</div>}
        <Btn disabled={!(a > 0) || avail == null || a > avail + 1e-9 || busy || !!paused[choice]} loading={busy} onClick={go}>{dep ? t('predict.deposit') : t('predict.withdraw')}</Btn>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------ Deposit Wallet: relayer key, emergency exit
const SETTINGS_URL = 'https://polymarket.com/settings';

/**
 * Link the account's Relayer API key: withdrawals and redeems of a Deposit Wallet are run by Polymarket's
 * relayer, which wants a key the user creates once on polymarket.com (it can't move funds by itself: every
 * operation is still signed here). Kept encrypted in the vault.
 */
export function RelayerSetup({ acc, onSaved, linked }) {
  const { authorize, toast } = useApp();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async (value) => {
    setErr(''); setBusy(true);
    try {
      await authorize((password) => setRelayerKey(acc, value, password), value ? t('predict.relayer.save') : t('predict.relayer.remove'));
      toast(value ? t('predict.relayer.saved') : t('predict.relayer.removed'));
      onSaved?.(!!value);
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy(false);
  };
  return (
    <div class="pt">
      <div class="rl-head"><span class="rl-ic"><Icon name="key" size={20} /></span><div><b>{t('predict.relayer.title')}</b><p class="small muted">{t('predict.relayer.why')}</p></div></div>
      {linked ? (
        <>
          <div class="rl-linked"><Icon name="check" size={16} stroke={2.6} />{t('predict.relayer.linked')}</div>
          <Btn kind="secondary" class="red" loading={busy} onClick={() => save(null)}>{t('predict.relayer.remove')}</Btn>
        </>
      ) : (
        <>
          <ol class="rl-steps">
            <li>{t('predict.relayer.step1')}</li>
            <li>{t('predict.relayer.step2')}</li>
            <li>{t('predict.relayer.step3')}</li>
          </ol>
          <Btn kind="secondary" onClick={() => window.dispatchEvent(new CustomEvent('ck-open-url', { detail: SETTINGS_URL }))}><Icon name="external" size={16} /> {t('predict.relayer.open')}</Btn>
          <div class="input-wrap"><input value={key} onInput={(e) => setKey(e.target.value)} placeholder={t('predict.relayer.placeholder')} autoCapitalize="off" autoComplete="off" spellcheck={false} style={{ fontSize: '1rem' }} /></div>
          {err && <div class="error small">{err}</div>}
          <Btn disabled={key.trim().length < 8 || busy} loading={busy} onClick={() => save(key.trim())}>{t('predict.relayer.save')}</Btn>
        </>
      )}
    </div>
  );
}

export function RelayerSheet({ acc, onClose }) {
  const [linked, setLinked] = useState(null);
  useEffect(() => { hasRelayerKey(acc).then(setLinked); }, [acc]);
  return (
    <Sheet title={t('predict.relayer.title')} onClose={onClose}>
      {linked == null ? <div class="pm-center"><Spinner /></div> : <RelayerSetup acc={acc} linked={linked} onSaved={(v) => (v ? onClose() : setLinked(false))} />}
    </Sheet>
  );
}

/**
 * Emergency exit of a Deposit Wallet, without Polymarket: the owner pauses the wallet, waits the factory's
 * timelock, then withdraws the pUSD to the address (direct transactions, gas in POL). Trading stops while paused.
 */
export function EmergencySheet({ acc, onClose, onDone }) {
  const { authorize } = useApp();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [now, setNow] = useState(Date.now());
  const load = () => emergencyState(acc).then(setSt).catch((e) => setErr(e.message));
  useEffect(() => { load(); const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [acc]);
  const run = async (name, fn, title) => {
    setErr(''); setBusy(name);
    try { await authorize((password) => fn(acc, password), title); await load(); onDone?.(); } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };
  const left = st?.paused ? Math.max(0, st.readyAt - now) : 0;
  const hm = (ms) => { const m = Math.ceil(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
  return (
    <Sheet title={t('predict.emergency.title')} onClose={onClose}>
      <div class="pt">
        <p class="small muted pt-cash-info">{t('predict.emergency.info', { h: st ? hm(st.delay * 1000) : '…' })}</p>
        {!st ? <div class="pm-center"><Spinner /></div> : (
          <>
            <div class="em-steps">
              <div class={`em-step ${st.paused ? 'done' : 'now'}`}><i>1</i><span>{t('predict.emergency.s1')}</span></div>
              <div class={`em-step ${st.paused && !left ? 'done' : st.paused ? 'now' : ''}`}><i>2</i><span>{st.paused && left ? t('predict.emergency.wait', { t: hm(left) }) : t('predict.emergency.s2', { h: hm(st.delay * 1000) })}</span></div>
              <div class={`em-step ${st.paused && !left ? 'now' : ''}`}><i>3</i><span>{t('predict.emergency.s3', { v: usd(Number(st.pusd) / 1e6) })}</span></div>
            </div>
            {err && <div class="error small">{err}</div>}
            {!st.paused && <Btn kind="secondary" class="red" loading={busy === 'pause'} disabled={!!busy} onClick={() => run('pause', emergencyPause, t('predict.emergency.txPause'))}>{t('predict.emergency.pause')}</Btn>}
            {st.paused > 0 && <Btn loading={busy === 'withdraw'} disabled={!!busy || left > 0 || !st.pusd} onClick={() => run('withdraw', emergencyWithdraw, t('predict.emergency.txWithdraw'))}>{t('predict.emergency.withdraw')}</Btn>}
            {st.paused > 0 && <Btn kind="secondary" loading={busy === 'unpause'} disabled={!!busy} onClick={() => run('unpause', emergencyUnpause, t('predict.emergency.txUnpause'))}>{t('predict.emergency.unpause')}</Btn>}
            <div class="tiny muted center">{t('predict.emergency.gas')}</div>
          </>
        )}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------ open orders
export function OpenOrders({ acc }) {
  const { authorize } = useApp();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => { setErr(''); openOrders(acc).then(setRows).catch((e) => { setErr(e.message); setRows([]); }); };
  useEffect(() => { if (acc && hasCreds(acc)) load(); }, [acc]);
  if (!acc) return <div class="pm-center"><Spinner /></div>;
  if (acc.mode === 'readonly' || acc.mode === 'error') return <div class="pt-ro"><Icon name="lock" size={22} /><span>{t(acc.reason || 'predict.acc.error')}</span></div>;
  if (!hasCreds(acc)) {
    return (
      <div class="pm-empty">
        <Icon name="key" size={26} />
        <span>{t('predict.orders.locked')}</span>
        <Btn kind="secondary" onClick={async () => { try { await authorize((password) => ensureCreds(acc, password), t('predict.orders.unlock')); load(); } catch (e) { if (!e.cancelled) setErr(e.message); } }}>{t('predict.orders.unlock')}</Btn>
        {err && <div class="error small">{err}</div>}
      </div>
    );
  }
  if (rows === null) return <div class="pm-center"><Spinner /></div>;
  return (
    <>
      {err && <div class="pm-err"><Icon name="wifiOff" size={18} /><span>{err}</span></div>}
      {!rows.length && <div class="pm-empty"><Icon name="history" size={26} /><span>{t('predict.orders.empty')}</span></div>}
      {rows.map((r) => (
        <div class="pm-pos pt-order">
          <span class={`pt-order-side ${r.side === 'BUY' ? 'buy' : 'sell'}`}>{r.side === 'BUY' ? t('predict.buy') : t('predict.sell')}</span>
          <span class="grow">
            <span class="pm-pos-title">{outcomeName(r.outcome)} · {cents(r.price)}</span>
            <span class="pm-pos-sub"><span>{t('predict.orders.filled', { a: fmtN(r.filled), b: fmtN(r.size) })}</span></span>
          </span>
          <Btn kind="secondary" class="pt-cancel" loading={busy === r.id} onClick={async () => {
            setBusy(r.id);
            try { await cancelOrder(acc, r.id); setRows((x) => x.filter((y) => y.id !== r.id)); } catch (e) { setErr(e.message); }
            setBusy('');
          }}>{t('predict.orders.cancel')}</Btn>
        </div>
      ))}
    </>
  );
}
