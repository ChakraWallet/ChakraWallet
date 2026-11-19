// MetaMask Card compatibility (Linea, Base): the card's face on the home (stacked with the balance card), the operations that
// can be done on-chain (top-up through a bridge, a swap into a token the card spends, spending limits) and the
// management screen. The card's own data and settings stay in the MetaMask app: these screens say so, and link to it.
// MetaMask and MetaMask Card are trademarks of their owners; Chakra is not affiliated with them.
import { useState, useEffect, useMemo, useCallback } from 'preact/hooks';
import { local, bg } from '../../shared/ext.js';
import { cardConfig, cardStatus, limitTx, isUnlimited, oneSpender, MMCARD_SITE, MMCARD } from '../../shared/mmcard.js';
import { getChain } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { getPrices, tokenPriceKey } from '../../shared/prices.js';
import { waitForReceipt } from '../../shared/rpc.js';
import { fmtUsd, fmtNum, fmtAmount, toFloat, parseAmount, rawToInput, shortAddr } from '../../shared/format.js';
import { TopBar, Btn, Sheet, Icon, TokenIcon, ChainIcon, Spinner, Guilloche, CopyBtn, FeeView, useApp, richText, usePrivacy, PrivacyBtn } from '../components.jsx';
import { useChainAddress, useNativePrice } from '../hooks.js';
import { useOperationAuth, runStep } from '../steps.js';
import { txStep } from '../chains/evm.js';
import { t, tn } from '../../shared/i18n.js';

/** MetaMask's own "no limit" (2^41 - 1 whole tokens): what its app sets, so the two apps show the same thing. */
const NO_LIMIT = 2199023255551n;
const iconOf = (chain, address) => (POPULAR_TOKENS[chain.id] || []).find((p) => p.address === address)?.icon || '';
const memo = new Map(); // `${chainId}:${address}` -> { data, at }

/**
 * The card linked to the selected account on this network: { cfg, data, loading, error, reload, total, priced }.
 * cfg is null on networks without the card. data: shared/mmcard.js cardStatus + the tokens' prices.
 */
export function useMmCard() {
  const { chain } = useApp();
  const addr = useChainAddress();
  const cfg = cardConfig(chain);
  const key = `${chain.id}:${String(addr.raw || '').toLowerCase()}`;
  const [data, setData] = useState(() => memo.get(key)?.data || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!cfg || !addr.raw) return;
    setLoading(true); setError('');
    try {
      const s = await cardStatus(chain, addr.raw);
      const prices = await getPrices(s.tokens.map((x) => tokenPriceKey(chain, x.address))).catch(() => ({}));
      const d = { ...s, tokens: s.tokens.map((x) => ({ ...x, price: prices[tokenPriceKey(chain, x.address)] ?? null, icon: iconOf(chain, x.address) })), updated: Date.now() };
      memo.set(key, { data: d }); setData(d);
      local.set(`mmcard:${key}`, d).catch(() => {});
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [key]);

  useEffect(() => {
    if (!cfg || !addr.raw) { setData(null); return; }
    const m = memo.get(key);
    if (m) setData(m.data);
    else { setData(null); local.get(`mmcard:${key}`, null).then((c) => c && !memo.has(key) && setData(c)).catch(() => {}); }
    if (!m || Date.now() - m.data.updated > 30000) load();
  }, [key]);

  const usd = (x, raw) => (x.price != null ? toFloat(raw, x.decimals) * x.price : null);
  const active = data?.tokens.filter((x) => x.active) || [];
  const total = active.reduce((s, x) => s + (usd(x, x.spendable) || 0), 0);
  const unpriced = active.filter((x) => x.price == null && BigInt(x.spendable) > 0n);
  return { cfg, data: cfg ? data : null, loading, error, reload: load, total, unpriced, active, usd };
}

// ---------------------------------------------------------------- the card's face
/** The card on the home (and, small, on the management screen): what the card can spend now. */
export function MmCardFace({ card, onRefresh, peek }) {
  const { chain } = useApp();
  const { m } = usePrivacy();
  const shown = card.active.slice(0, 4);
  return (
    <div class="hero mmc-face">
      <Guilloche seed="metamask-card-compat" />
      <div class="row between">
        <span class="label mmc-label"><Icon name="card" size={14} /> MetaMask Card<span class="mmc-compat">{t('mmcard.compat')}</span></span>
        <span class="hero-tools"><PrivacyBtn />
        {onRefresh && (
          <button class="iconbtn hero-btn" title={t('home.refresh')} onClick={(e) => { e.stopPropagation(); onRefresh(); }}>
            {card.loading ? <Spinner /> : <Icon name="refresh" size={15} />}
          </button>
        )}</span>
      </div>
      <div>
        <div class="mmc-sub">{t('mmcard.spendable')}</div>
        <div class="total">{card.data ? m(fmtUsd(card.total)) : <span class="skeleton" style={{ display: 'inline-block', width: '8.75rem', height: '2.25rem', opacity: .3 }} />}</div>
      </div>
      <div class="row between hero-foot">
        <span class="mmc-toks">
          {shown.map((x) => <TokenIcon sm symbol={x.symbol} icon={x.icon} />)}
          <span class="small">{shown.length ? shown.map((x) => x.symbol).join(' · ') : t('mmcard.noTokens')}</span>
        </span>
        <span class="mmc-net"><ChainIcon chain={chain} size={16} /> {chain.name}</span>
      </div>
      {peek && <span class="hs-peek">{peek}</span>}
    </div>
  );
}

/**
 * The balance card and the MetaMask Card, one in front of the other: tap the one behind (its edge shows under the
 * front one) or swipe sideways to switch. face: 'wallet' | 'card'.
 */
export function HeroStack({ face, setFace, wallet, card }) {
  const [moved, setMoved] = useState(false); // no animation on the first paint
  const [x0, setX0] = useState(null);
  const go = (f) => { if (f !== face) { setMoved(true); setFace(f); } };
  const other = face === 'wallet' ? 'card' : 'wallet';
  return (
    <div class={`hstack ${moved ? 'moved' : ''}`}
      onTouchStart={(e) => setX0(e.touches[0].clientX)}
      onTouchEnd={(e) => { if (x0 != null && Math.abs(e.changedTouches[0].clientX - x0) > 48) go(other); setX0(null); }}>
      <div class={`hs-slot ${face === 'wallet' ? 'front' : 'back'}`} onClick={face === 'card' ? () => go('wallet') : undefined}>{wallet}</div>
      <div class={`hs-slot ${face === 'card' ? 'front' : 'back'}`} onClick={face === 'wallet' ? () => go('card') : undefined}>{card}</div>
      <div class="hs-dots" role="tablist">
        <button class={face === 'wallet' ? 'on' : ''} aria-label={t('mmcard.showWallet')} onClick={() => go('wallet')} />
        <button class={`mmc ${face === 'card' ? 'on' : ''}`} aria-label={t('mmcard.showCard')} onClick={() => go('card')} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the card on the other network
const elsewhere = new Map(); // `${chainId}:${address}` -> { at, linked }
/**
 * On a network of the card where the account has none: the other network of the card where it has one (read from what
 * was saved, else asked once: one multicall), or null.
 */
function useCardElsewhere(chain, owner, here) {
  const [other, setOther] = useState(null);
  useEffect(() => {
    setOther(null);
    if (!owner || !here || here.linked) return undefined;
    let alive = true;
    (async () => {
      for (const id of Object.keys(MMCARD).map(Number).filter((id) => id !== chain.id)) {
        const c = getChain(id);
        if (!c) continue;
        const k = `${id}:${String(owner).toLowerCase()}`;
        let e = elsewhere.get(k);
        if (!e || Date.now() - e.at > 10 * 60e3) {
          const saved = await local.get(`mmcard:${k}`, null).catch(() => null);
          if (saved && Date.now() - (saved.updated || 0) < 10 * 60e3) e = { at: saved.updated, linked: saved.linked };
          else e = { at: Date.now(), linked: !!(await cardStatus(c, owner).catch(() => null))?.linked };
          elsewhere.set(k, e);
        }
        if (e.linked) { if (alive) setOther(c); return; }
      }
    })();
    return () => { alive = false; };
  }, [chain.id, owner, here?.linked]);
  return other;
}

/** Under the balance card, quietly: "Your MetaMask Card is on Linea" - a tap goes there. */
export function CardElsewhere({ card }) {
  const { chain, refresh } = useApp();
  const addr = useChainAddress();
  const other = useCardElsewhere(chain, addr.raw, card.data);
  if (!other) return null;
  const go = async () => { await bg('setChain', { chainId: other.id }); await refresh(); };
  return (
    <button class="mmc-elsewhere" onClick={go}>
      <Icon name="card" size={13} /><span>{t('mmcard.elsewhere', { network: other.name })}</span><Icon name="forward" size={12} />
    </button>
  );
}

// ---------------------------------------------------------------- home: the card's operations
const firstActive = (card) => card.active.find((x) => BigInt(x.spendable) > 0n) || card.active[0] || card.data?.tokens[0];

/** Action buttons under the card (in place of Send / Receive / Swap / Bridge). */
export function CardActions({ card }) {
  const { nav, chain } = useApp();
  const tk = firstActive(card);
  return (
    <div class="actions mmc">
      <button class="action" onClick={() => nav('bridge', { toChainId: chain.id, toAddress: tk?.address })}><span class="ic"><Icon name="route" /></span>{t('mmcard.topUp')}</button>
      <button class="action" onClick={() => nav('swap', { toAddress: tk?.address })}><span class="ic"><Icon name="swap" /></span>{t('mmcard.convert')}</button>
      <button class="action" onClick={() => nav('mmcard')}><span class="ic"><Icon name="approve" /></span>{t('mmcard.limits')}</button>
      <a class="action" href={MMCARD_SITE} target="_blank" rel="noopener" data-external><span class="ic"><Icon name="external" /></span>MetaMask</a>
    </div>
  );
}

/** The "Operations" tab: what the card can spend, token by token, and what can be done from here. */
export function CardOps({ card }) {
  const { nav, chain } = useApp();
  const net = { network: chain.name };
  const symbols = card.cfg ? card.cfg.tokens.map((x) => x.symbol).join(', ') : '';
  const { m } = usePrivacy();
  const tk = firstActive(card);
  const Op = ({ icon, title, sub, onClick, href, danger }) => {
    const body = <><span class={`mmc-op-ic ${danger ? 'danger' : ''}`}><Icon name={icon} size={18} /></span><div class="grow" style={{ minWidth: 0 }}><div class="bold">{title}</div><div class="small muted">{sub}</div></div><Icon name={href ? 'external' : 'forward'} size={14} /></>;
    return href ? <a class="item" href={href} target="_blank" rel="noopener" data-external>{body}</a> : <button class="item" onClick={onClick}>{body}</button>;
  };
  return (
    <>
      <div class="card" style={{ padding: '0.375rem' }}>
        <div class="list">
          {card.active.map((x) => (
            <button class="item" onClick={() => nav('mmcard')}>
              <TokenIcon symbol={x.symbol} icon={x.icon} />
              <div class="grow" style={{ minWidth: 0 }}>
                <div class="bold">{x.symbol}</div>
                <div class="small muted ellipsis">{isUnlimited(x.allowance, x.decimals) ? t('mmcard.limitNone') : t('mmcard.limitOf', { amount: fmtAmount(x.allowance, x.decimals, 4), symbol: x.symbol })}</div>
              </div>
              <div class="right">
                <div class="bold">{m(card.usd(x, x.spendable) != null ? fmtUsd(card.usd(x, x.spendable)) : `${fmtNum(toFloat(x.spendable, x.decimals))} ${x.symbol}`)}</div>
                <div class="small muted">{t('mmcard.spendableShort')}</div>
              </div>
            </button>
          ))}
          {!card.active.length && <div class="item small muted">{t('mmcard.noTokensLong')}</div>}
        </div>
      </div>
      <div class="section-title">{t('mmcard.opsTitle')}</div>
      <div class="card" style={{ padding: '0.375rem' }}>
        <div class="list">
          <Op icon="route" title={t('mmcard.op.topUp')} sub={t('mmcard.op.topUpSub', net)} onClick={() => nav('bridge', { toChainId: chain.id, toAddress: tk?.address })} />
          <Op icon="swap" title={t('mmcard.op.convert')} sub={t('mmcard.op.convertSub', { ...net, tokens: symbols })} onClick={() => nav('swap', { toAddress: tk?.address })} />
          <Op icon="receive" title={t('mmcard.op.receive', net)} sub={t('mmcard.op.receiveSub')} onClick={() => nav('receive')} />
          <Op icon="approve" title={t('mmcard.op.limits')} sub={t('mmcard.op.limitsSub')} onClick={() => nav('mmcard')} />
          {card.active.length > 0 && <Op icon="lock" danger title={t('mmcard.op.block')} sub={t('mmcard.op.blockSub')} onClick={() => nav('mmcard', { revokeAll: true })} />}
          <Op icon="card" title={t('mmcard.op.app')} sub={t('mmcard.op.appSub')} href={MMCARD_SITE} />
        </div>
      </div>
      <Disclaimer />
    </>
  );
}

function Disclaimer() {
  return <div class="tiny muted mmc-legal">{t('mmcard.legal')}</div>;
}

// ---------------------------------------------------------------- transactions (limits)
/** Review and send one or more approvals: the network fee of each, one password for all. */
function LimitTxs({ items, onDone, onClose }) {
  const { chain, toast } = useApp();
  const addr = useChainAddress();
  const nativePrice = useNativePrice(chain);
  const auth = useOperationAuth(t('mmcard.confirmTitle'));
  const steps = useMemo(() => items.map((it, i) => txStep({
    key: `limit${i}`, title: it.title, chain, from: addr.raw, sentTitle: it.title,
    build: async () => limitTx(it.token, it.spender, it.amount),
  })), [items]);
  const [idx, setIdx] = useState(0);
  const [review, setReview] = useState(null);
  const [speed, setSpeed] = useState('normal');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [hashes, setHashes] = useState([]);
  useEffect(() => { setReview(null); setErr(''); steps[idx].prepare().then(setReview).catch((e) => setErr(e.message)); }, [idx]);

  const confirm = async () => {
    setErr(''); setBusy(t('mmcard.sending'));
    try {
      const r = await runStep(steps, idx, review, { speed, auth });
      const all = [...hashes, r.hash];
      setHashes(all);
      if (idx < steps.length - 1) { setIdx(idx + 1); setBusy(''); return; }
      setBusy(t('mmcard.waiting'));
      await Promise.all(all.map((h) => waitForReceipt(chain, h).catch(() => null)));
      toast(t('mmcard.done'));
      onDone();
    } catch (e) { setErr(e.message); }
    setBusy('');
  };
  const it = items[idx];
  return (
    <Sheet title={it.title} onClose={busy ? () => {} : onClose}>
      {steps.length > 1 && <div class="steps">{steps.map((_, i) => <div class={`s ${i <= idx ? 'on' : ''}`} />)}</div>}
      <div class="card flat row">
        <TokenIcon symbol={it.token.symbol} icon={it.token.icon} />
        <div class="grow">
          <div class="bold">{it.token.symbol}</div>
          <div class="small muted">{BigInt(it.amount) === 0n ? t('mmcard.newLimitZero') : isUnlimited(it.amount, it.token.decimals) ? t('mmcard.newLimitNone') : t('mmcard.newLimit', { amount: fmtAmount(it.amount, it.token.decimals, 6), symbol: it.token.symbol })}</div>
        </div>
      </div>
      <div class="small muted">{richText(t('mmcard.spenderNote'), { addr: <span class="mono-s">{shortAddr(it.spender, 6)}</span> })}</div>
      <FeeView chain={chain} fee={review?.fee} speed={speed} setSpeed={setSpeed} nativePrice={nativePrice} />
      {busy && <div class="info row"><Spinner /> {busy}</div>}
      {err && <div class="error">{err}</div>}
      <Btn loading={!!busy} disabled={!review} onClick={confirm}>{t('mmcard.confirm')}</Btn>
    </Sheet>
  );
}

/** Choose a token's new limit: an amount, the token's balance, or no limit (as the MetaMask app does). */
function LimitSheet({ token, spender, onPick, onClose }) {
  const [amount, setAmount] = useState('');
  const [none, setNone] = useState(false);
  const raw = none ? NO_LIMIT * 10n ** BigInt(token.decimals) : parseAmount(amount, token.decimals);
  const raising = raw != null && raw > BigInt(token.allowance);
  return (
    <Sheet title={t('mmcard.limitTitle', { symbol: token.symbol })} onClose={onClose}>
      <div class="small muted">{token.active ? (isUnlimited(token.allowance, token.decimals) ? t('mmcard.limitNowNone') : t('mmcard.limitNow', { amount: fmtAmount(token.allowance, token.decimals, 6), symbol: token.symbol })) : t('mmcard.limitNowOff')}</div>
      <div class="field">
        <label>{t('mmcard.limitLabel')}</label>
        <div class="row">
          <input class="input grow" inputMode="decimal" placeholder="0" value={none ? '' : amount} disabled={none} onInput={(e) => setAmount(e.target.value)} />
          <button class="chip" disabled={none} onClick={() => setAmount(rawToInput(BigInt(token.balance), token.decimals))}>{t('mmcard.limitBalance')}</button>
        </div>
      </div>
      <label class="row small"><input type="checkbox" checked={none} onChange={(e) => setNone(e.target.checked)} /> {t('mmcard.limitNoneOpt')}</label>
      {!token.active && <div class="warn small">{t('mmcard.activateWarn')}</div>}
      {token.active && raising && <div class="info small">{t('mmcard.raiseNote')}</div>}
      <Btn disabled={raw == null || raw <= 0n} onClick={() => onPick({ token, spender, amount: raw.toString(), title: t('mmcard.txLimit', { symbol: token.symbol }) })}>{t('common.continue')}</Btn>
    </Sheet>
  );
}

// ---------------------------------------------------------------- the management screen
export function MmCard({ revokeAll }) {
  const { chain, nav } = useApp();
  const { m } = usePrivacy();
  const card = useMmCard();
  const [limitOf, setLimitOf] = useState(null); // the token whose limit is being changed
  const [txs, setTxs] = useState(null); // the approvals to review and send
  const [askAll, setAskAll] = useState(!!revokeAll);
  if (!card.cfg) return <div class="screen"><TopBar title="MetaMask Card" /><div class="content"><div class="info">{t('mmcard.onlyLinea', { networks: Object.keys(MMCARD).map((id) => getChain(id)?.name).filter(Boolean).join(', ') })}</div></div></div>;
  const d = card.data;
  const spender = d?.spender;
  const revoke = (list) => setTxs(list.map((x) => ({ token: x, spender, amount: '0', title: t('mmcard.txRevoke', { symbol: x.symbol }) })));
  const inactive = d?.tokens.filter((x) => !x.active) || [];
  return (
    <div class="screen">
      <TopBar title="MetaMask Card" right={<button class="iconbtn" title={t('home.refresh')} onClick={card.reload}>{card.loading ? <Spinner /> : <Icon name="refresh" size={16} />}</button>} />
      <div class="content">
        {!d && !card.error && <div class="empty"><Spinner /></div>}
        {card.error && !d && <div class="error">{t('mmcard.loadFailed', { network: chain.name })}</div>}
        {d && <>
          <MmCardFace card={card} />
          {!d.linked && <div class="info small">{t('mmcard.notLinked')}</div>}
          {card.unpriced.length > 0 && <div class="tiny muted">{t('mmcard.unpriced', { list: card.unpriced.map((x) => x.symbol).join(', ') })}</div>}

          {card.active.length > 0 && <div class="section-title">{t('mmcard.activeTitle')}</div>}
          {card.active.map((x) => {
            const pct = BigInt(x.balance) > 0n ? Math.min(100, (Number(BigInt(x.spendable) * 1000n / BigInt(x.balance)) / 10)) : 0;
            return (
              <div class="card col mmc-tok">
                <div class="row">
                  <TokenIcon symbol={x.symbol} icon={x.icon} />
                  <div class="grow" style={{ minWidth: 0 }}>
                    <div class="bold">{x.symbol}</div>
                    <div class="small muted">{t('mmcard.balance', { amount: m(fmtAmount(x.balance, x.decimals, 6)), symbol: x.symbol })}</div>
                  </div>
                  <div class="right">
                    <div class="bold">{m(card.usd(x, x.spendable) != null ? fmtUsd(card.usd(x, x.spendable)) : fmtNum(toFloat(x.spendable, x.decimals)))}</div>
                    <div class="small muted">{t('mmcard.spendableShort')}</div>
                  </div>
                </div>
                <div class="mmc-bar"><span style={{ width: `${pct}%` }} /></div>
                <div class="row between small muted mmc-limrow">
                  <span class="ellipsis">{isUnlimited(x.allowance, x.decimals) ? t('mmcard.limitNone') : t('mmcard.limitOf', { amount: fmtAmount(x.allowance, x.decimals, 4), symbol: x.symbol })}</span>
                  <span class="nowrap">{t('mmcard.ofBalance', { pct: Math.round(pct) })}</span>
                </div>
                <div class="row mmc-btns">
                  <Btn kind="secondary" class="sm grow" onClick={() => setLimitOf(x)}><Icon name="edit" size={14} /> {t('mmcard.changeLimit')}</Btn>
                  <Btn kind="secondary" class="sm grow mmc-danger" onClick={() => revoke([x])}><Icon name="close" size={14} /> {t('mmcard.revoke')}</Btn>
                </div>
              </div>
            );
          })}

          {inactive.length > 0 && <div class="section-title">{t('mmcard.otherTitle')}</div>}
          {inactive.length > 0 && (
            <div class="card" style={{ padding: '0.375rem' }}>
              <div class="list">
                {inactive.map((x) => (
                  <div class="item">
                    <TokenIcon symbol={x.symbol} icon={x.icon} />
                    <div class="grow" style={{ minWidth: 0 }}>
                      <div class="bold">{x.symbol}</div>
                      <div class="small muted">{t('mmcard.balance', { amount: m(fmtAmount(x.balance, x.decimals, 6)), symbol: x.symbol })}</div>
                    </div>
                    {d.linked && <button class="link small" onClick={() => setLimitOf(x)}>{t('mmcard.authorize')}</button>}
                  </div>
                ))}
              </div>
              <div class="tiny muted" style={{ padding: '0.375rem' }}>{t('mmcard.otherNote')}</div>
            </div>
          )}

          {card.active.length > 1 && <Btn kind="secondary" class="mmc-danger" onClick={() => setAskAll(true)}><Icon name="lock" size={16} /> {t('mmcard.revokeAll')}</Btn>}

          <div class="section-title">{t('mmcard.infoTitle')}</div>
          <div class="card flat tx-rows">
            <div class="tx-row"><span class="k">{t('history.network')}</span><span class="v"><ChainIcon chain={chain} size={16} /><span class="ellipsis">{chain.name}</span></span></div>
            {d.linked && !oneSpender(card.cfg) && <div class="tx-row"><span class="k">{t('mmcard.region')}</span><span class="v">{t(d.region === 'us' ? 'mmcard.regionUs' : 'mmcard.regionGlobal')}</span></div>}
            <div class="tx-row"><span class="k">{t('mmcard.contract')}</span><span class="v"><span class="mono-s">{shortAddr(spender, 6)}</span><CopyBtn text={spender} /></span></div>
          </div>
          {chain.explorer && <a class="btn secondary block" href={`${chain.explorer}/address/${spender}`} target="_blank" rel="noopener" data-external><Icon name="external" size={16} /> {t('mmcard.viewContract')}</a>}
          <button class="btn secondary block" onClick={() => nav('history', { filter: 'card' })}><Icon name="history" size={16} /> {t('mmcard.history')}</button>
          <a class="btn secondary block" href={MMCARD_SITE} target="_blank" rel="noopener" data-external><Icon name="card" size={16} /> {t('mmcard.op.app')}</a>
          <div class="info small">{t('mmcard.whatHere')}</div>
          <Disclaimer />
        </>}
      </div>
      {limitOf && <LimitSheet token={limitOf} spender={spender} onClose={() => setLimitOf(null)} onPick={(it) => { setLimitOf(null); setTxs([it]); }} />}
      {askAll && d && (
        <Sheet title={t('mmcard.revokeAllTitle')} onClose={() => setAskAll(false)}>
          <div class="small">{t('mmcard.revokeAllText')}</div>
          <div class="small muted">{tn('mmcard.revokeAllCount', card.active.length, { network: chain.name })}</div>
          {card.active.length > 0
            ? <Btn class="mmc-danger-fill" onClick={() => { setAskAll(false); revoke(card.active); }}>{t('mmcard.revokeAll')}</Btn>
            : <div class="info small">{t('mmcard.nothingToRevoke')}</div>}
        </Sheet>
      )}
      {txs && <LimitTxs items={txs} onClose={() => setTxs(null)} onDone={() => { setTxs(null); memo.clear(); card.reload(); }} />}
    </div>
  );
}
