// Tron's energy and bandwidth: the card on the home (what the account has now and what it pays for) and the Resources
// page - the two resources drawn as rings that fill up again within a day, what the usual operations cost now, and
// what can be done about it: stake TRX (and unstake), rent energy from JustLend, vote with the staked TRX and claim the
// rewards, delegate resources to another address; who controls the account. Every operation is one transaction,
// built here, signed after the password (src/ui/tron/tx.js).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Icon, Btn, Sheet, Spinner, TopBar, useApp } from '../components.jsx';
import { useChainAddress } from '../hooks.js';
import { t, tn } from '../../shared/i18n.js';
import { fmtNum, shortAddr } from '../../shared/format.js';
import { isAddress } from '../../shared/tron/core.js';
import { chainParams, constantCall } from '../../shared/tron/api.js';
import { encodeRawData } from '../../shared/tron/proto.js';
import { resourceState, costOf, bandwidthBytes, feeLimitFor } from '../../shared/tron/fees.js';
import {
  USDT_ENERGY, TRX_SEND_BYTES, TOKEN_SEND_BYTES, coverage, stakeOverview, stakeTx, unstakeTx, withdrawTx, cancelUnstakeTx,
  delegateTx, undelegateTx, voteTx, claimTx, canDelegate, delegations, rewards, superReps, brokerage, voteApr, permissionsOf,
} from '../../shared/tron/resources.js';
import { rentMarketOf, rentTerms, rentQuote, myRental, rentTx, returnTx } from '../../shared/tron/rent.js';
import { sendContract } from './tx.js';
import { useTronAccounts } from './hooks.js';

const SUN = 1e6;
const trxOf = (sun) => Number(sun) / SUN;
const TRX = (sun, d = 2) => `${fmtNum(trxOf(sun), d)} TRX`;
/** 12400 -> "12,4K" (the app's language) */
function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${fmtNum(v / 1e9, 1)}B`;
  if (a >= 1e6) return `${fmtNum(v / 1e6, 1)}M`;
  if (a >= 1e4) return `${fmtNum(v / 1e3, 1)}K`;
  return fmtNum(Math.floor(v), 0);
}
const toSun = (text) => {
  const m = /^(\d+)(?:[.,](\d{0,6}))?$/.exec(String(text || '').trim());
  return m ? BigInt(m[1]) * 1_000_000n + BigInt((m[2] || '').padEnd(6, '0') || '0') : null;
};
const inputOf = (sun) => String(trxOf(sun)).replace(/\.?0+$/, '');
/** "in 5 h", "in 9 days" */
function inTime(ms) {
  const s = Math.max(0, (ms - Date.now()) / 1000);
  if (s < 3600) return t('tron.res.inMin', { n: Math.max(1, Math.ceil(s / 60)) });
  if (s < 86400 * 2) return t('tron.res.inHours', { n: Math.ceil(s / 3600) });
  return t('tron.res.inDays', { n: Math.ceil(s / 86400) });
}

// ------------------------------------------------------------ data
const memo = new Map(); // `${chainId}:${address}` -> { at, data }
/** Energy, bandwidth and the account of the selected Tron address: { data: { res, params }, error, loading, reload }. */
export function useTronRes() {
  const { chain } = useApp();
  const addr = useChainAddress();
  const key = `${chain.id}:${addr.raw || ''}`;
  const [data, setData] = useState(() => memo.get(key)?.data || null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!addr.raw) return undefined;
    let alive = true;
    const m = memo.get(key);
    if (m) setData(m.data);
    if (m && Date.now() - m.at < 20e3 && !tick) return undefined;
    setLoading(true);
    Promise.all([resourceState(chain, addr.raw), chainParams(chain)])
      .then(([res, params]) => { const d = { res, params }; memo.set(key, { at: Date.now(), data: d }); if (alive) { setData(d); setError(''); } })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [key, tick]);
  return { data, error, loading, address: addr.raw, reload: () => setTick((x) => x + 1) };
}

// ------------------------------------------------------------ pieces
/** The round icon of the app's buttons (white, bordered, the icon in the primary colour). */
const Ic = ({ name, sm }) => <span class={`tr-ic ${sm ? 'sm' : ''}`}><Icon name={name} size={sm ? 15 : 17} /></span>;

/** A section of the page: a title (and something on its right), its rows, its buttons at the bottom, a short note. */
function Box({ title, aside, children, actions, hint }) {
  return (
    <section class="card tr-box">
      {title && <header class="tr-box-head"><h3>{title}</h3>{aside}</header>}
      {children}
      {actions && <div class="tr-actions">{actions}</div>}
      {hint && <p class="tr-box-hint">{hint}</p>}
    </section>
  );
}
/** A row of a section: round icon, title and a line under it, a value on the right (off: nothing there yet). */
function Line({ icon, title, sub, value, off }) {
  return (
    <div class={`tr-line ${off ? 'off' : ''}`}>
      <Ic name={icon} sm />
      <span class="tr-line-text"><span class="tr-line-title">{title}</span>{sub && <span class="tr-line-sub">{sub}</span>}</span>
      {value != null && <span class="tr-line-val">{value}</span>}
    </div>
  );
}
/** Short notes under a sheet's figures, one per line with its icon: [[icon, text], …] (empty ones left out). */
const Notes = ({ items }) => (
  <ul class="tr-notes">{items.filter((x) => x && x[1]).map(([icon, text]) => <li><Icon name={icon} size={15} /><span>{text}</span></li>)}</ul>
);
/** Two figures side by side (label, value, a line under it). */
const Stat = ({ label, value, sub, tone }) => (
  <div class="tr-stat"><span class="tr-stat-label">{label}</span><b class={tone || ''}>{value}</b>{sub && <span class="tr-stat-sub">{sub}</span>}</div>
);

const bwLimit = (res) => res.bandwidth.free.limit + res.bandwidth.staked.limit;
const fullAt = (x) => Math.max(x.fullAt || 0, 0);
const pctOf = (avail, limit) => (limit > 0 ? avail / limit : 0);

// ------------------------------------------------------------ the home card
/** The battery and the gauge of the page, small: drawn again at this size (strokes that a scaled-down copy would lose). */
function MiniBattery({ pct, tone }) {
  const p = clamp01(pct);
  return (
    <svg class={`tr-mb tr-lvl ${tone}`} viewBox="0 0 48 24" aria-hidden="true">
      <defs><clipPath id="tr-mb-in"><rect x="4.5" y="4.5" width="34" height="15" rx="3" /></clipPath></defs>
      <rect class="tr-mb-body" x="1.5" y="1.5" width="40" height="21" rx="5.5" />
      <rect class="tr-mb-nub" x="43.5" y="8" width="3" height="8" rx="1.2" />
      {p > 0 && <rect class="tr-mb-fill" x="4.5" y="4.5" width={34 * p} height="15" clip-path="url(#tr-mb-in)" />}
    </svg>
  );
}
function MiniGauge({ pct }) {
  const p = clamp01(pct), arc = 'M 5 25 A 19 19 0 0 1 43 25';
  return (
    <svg class={`tr-mg tr-lvl ${level(p)}`} viewBox="0 0 48 28" aria-hidden="true">
      <path class="tr-mg-track" d={arc} />
      {p > 0 && <path class="tr-mg-val" d={arc} pathLength="100" style={{ strokeDasharray: `${p * 100} 100` }} />}
      <line class="tr-mg-needle" x1="24" y1="25" x2="24" y2="12" style={{ transform: `rotate(${-90 + 180 * p}deg)` }} />
      <circle class="tr-hub" cx="24" cy="25" r="3.2" />
    </svg>
  );
}
/** One resource on the home card, top to bottom: its name, its small drawing, what is left of the day's amount. */
function ResCol({ viz, label, avail, limit }) {
  return (
    <div class="tr-col">
      <span class="tr-col-label">{label}</span>
      <span class="tr-mini">{viz}</span>
      <span class="tr-row-val">{avail == null ? <span class="skeleton" style={{ width: '4rem' }} /> : <>{compact(avail)}{limit > 0 && <small> / {compact(limit)}</small>}</>}</span>
    </div>
  );
}

/** The home's card on Tron networks: energy and bandwidth now, what they pay for; opens the Resources page. */
export function TronHomeExtra({ chain, data: portfolio }) {
  const { nav } = useApp();
  const { data } = useTronRes();
  if (!portfolio?.tron?.activated) return null;
  const res = data?.res;
  const cov = res ? coverage(res) : null;
  const perm = res ? permissionsOf(res.account, res.account?.address) : null;
  const usdtFee = data ? (USDT_ENERGY * Number(data.params.getEnergyFee ?? 100)) / SUN : null;
  const holdsTokens = (portfolio.tokens || []).some((x) => !x.native && !x.trc10 && !x.hidden && BigInt(x.balance || 0) > 0n);
  const burnHint = perm?.safe && cov && !cov.tokens && holdsTokens && usdtFee != null;
  return (
    <button class="card tr-card" onClick={() => nav('tronResources')}>
      <div class="tr-card-head"><b>{t('tron.res.title')}</b><span class="muted"><Icon name="forward" size={15} /></span></div>
      <div class="tr-cols">
        <ResCol viz={<MiniBattery pct={res ? pctOf(res.energy.available, res.energy.limit) : 0} tone={res ? batteryTone(res) : 'none'} />} label={t('tron.res.energy')} avail={res?.energy.available} limit={res?.energy.limit || 0} />
        <ResCol viz={<MiniGauge pct={res ? pctOf(res.bandwidth.available, bwLimit(res)) : 0} />} label={t('tron.res.bandwidth')} avail={res?.bandwidth.available} limit={res ? bwLimit(res) : 0} />
      </div>
      {perm && !perm.safe ? <div class="tr-card-note alarm"><Icon name="warn" size={14} /><span>{t('tron.sec.alarmShort')}</span></div>
        : burnHint ? <div class="tr-card-note"><Icon name="flame" size={14} /><span>{t('tron.res.burnHint', { amount: fmtNum(usdtFee, 1) })}</span></div>
          : <span class="tiny muted">{cov ? t('tron.res.pill', { tokens: tn('tron.res.pillTokens', cov.tokens), sends: tn('tron.res.pillSends', cov.sends) }) : ' '}</span>}
    </button>
  );
}

// ------------------------------------------------------------ the page
const TABS = [['stake', 'tron.res.tab.stake'], ['rent', 'tron.res.tab.rent'], ['vote', 'tron.res.tab.vote'], ['delegate', 'tron.res.tab.delegate']];

export function TronResources() {
  const { chain, toast, setPortfolioCache, account, authorize } = useApp();
  const { data, error, loading, address, reload } = useTronRes();
  const [tab, setTab] = useState('stake');
  const [sheet, setSheet] = useState(null);
  const res = data?.res, params = data?.params;
  const acc = res?.account;
  const stake = useMemo(() => (acc ? stakeOverview(acc) : null), [acc]);
  const balance = BigInt(acc?.balance || 0);

  /** One operation: built, its cost checked, signed and sent; then the page and the balances are read again. */
  const run = async (contract, { title, done, energy = 0 }) => {
    const draft = encodeRawData({ contract, ref: { ref_block_bytes: '0000', ref_block_hash: '0000000000000000' }, expiration: Date.now(), timestamp: Date.now(), fee_limit: energy ? 50_000_000 : 0 });
    const cost = costOf({ res, params, bytes: bandwidthBytes(draft), energy });
    const value = BigInt(contract.parameter.call_value || 0) + BigInt(contract.type === 'FreezeBalanceV2Contract' ? contract.parameter.frozen_balance : 0);
    if (cost.total + value > balance) throw new Error(t('tron.send.noTrxFee', { amount: TRX(cost.total + value) }));
    const feeLimit = energy ? feeLimitFor(energy, res, params) : 0;
    const sent = await sendContract(chain, { account, contract, feeLimit, auth: (fn) => authorize(fn, title) });
    await sent.wait;
    toast(done);
    memo.delete(`${chain.id}:${address}`);
    setPortfolioCache((c) => { const n = { ...c }; delete n[`${chain.id}:${account.address}`]; return n; });
    reload();
  };
  const ctx = { chain, res, params, stake, balance, address, run, reload, setSheet };

  return (
    <div class="screen">
      <TopBar title={t('tron.res.pageTitle')} right={<button class="iconbtn" title={t('home.refresh')} onClick={reload}>{loading ? <Spinner /> : <Icon name="refresh" />}</button>} />
      <div class="content tr-page">
        {error && !data && <div class="error">{error}</div>}
        {!data && !error && <div class="empty"><Spinner lg /></div>}
        {data && <>
          <Hero res={res} />
          <CostStrip res={res} params={params} />
          <div class="tabs">{TABS.map(([k, l]) => <button class={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{t(l)}</button>)}</div>
          {tab === 'stake' && <StakePanel {...ctx} />}
          {tab === 'rent' && <RentPanel {...ctx} />}
          {tab === 'vote' && <VotePanel {...ctx} />}
          {tab === 'delegate' && <DelegatePanel {...ctx} />}
          <SecurityCard acc={acc} address={address} />
          <div class="tiny muted tr-foot">{t('tron.res.foot')}</div>
        </>}
      </div>
      {sheet?.kind === 'stake' && <StakeSheet {...ctx} initial={sheet.resource} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'unstake' && <UnstakeSheet {...ctx} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'vote' && <VoteSheet {...ctx} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'delegate' && <DelegateSheet {...ctx} onClose={() => setSheet(null)} />}
    </div>
  );
}

const clamp01 = (x) => Math.max(0, Math.min(1, x || 0));
/** How full a resource is, for its colour: green, amber when low, red when almost empty. */
const level = (p) => (p >= 0.5 ? 'ok' : p >= 0.2 ? 'low' : 'crit');
/** The battery's colour: grey without energy, red when it pays for 2 token transfers or fewer, green otherwise. */
const batteryTone = (res) => (!res.energy.limit ? 'none' : coverage(res).tokens <= 2 ? 'crit' : 'ok');

/** Energy as a battery: filled with what is left of the day's amount (in cells), a bolt and a sheen while it recharges. */
function Battery({ pct, charging, tone }) {
  const p = clamp01(pct), w = 106 * p;
  return (
    <svg class={`tr-batt tr-lvl ${tone}`} viewBox="0 0 132 64" aria-hidden="true">
      <defs>
        <clipPath id="tr-batt-in"><rect x="8" y="8" width="106" height="48" rx="8" /></clipPath>
        <linearGradient id="tr-batt-sheen" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0" /><stop offset=".5" stop-color="#fff" stop-opacity=".45" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></linearGradient>
      </defs>
      <rect class="tr-batt-body" x="2" y="2" width="118" height="60" rx="14" />
      <rect class="tr-batt-nub" x="122.5" y="21" width="7.5" height="22" rx="3" />
      <g clip-path="url(#tr-batt-in)">
        {w > 0 && <rect class="tr-batt-fill" x="8" y="8" width={w} height="48" />}
        {charging && w > 0 && <svg x="8" y="8" width={w} height="48"><rect class="tr-batt-sheen" x="-44" y="0" width="44" height="48" fill="url(#tr-batt-sheen)" /></svg>}
      </g>
      {[1, 2, 3, 4].map((i) => <line class="tr-batt-cell" x1={8 + (106 * i) / 5} y1="8" x2={8 + (106 * i) / 5} y2="56" />)}
      {charging && <path class="tr-batt-bolt" d="M65 13 L50 35 H60 L56.5 51 L72 28 H62 Z" />}
    </svg>
  );
}

/** Bandwidth as a gauge: an arc filled with what is left of the day's amount, the needle on it. */
function Gauge({ pct }) {
  const p = clamp01(pct);
  const arc = 'M 11 68 A 55 55 0 0 1 121 68';
  const tick = (i) => {
    const a = Math.PI * (1 - i / 10), r1 = i % 5 ? 39 : 35.5, r2 = 44;
    return <line class={`tr-tick ${i % 5 ? '' : 'major'}`} x1={66 + r1 * Math.cos(a)} y1={68 - r1 * Math.sin(a)} x2={66 + r2 * Math.cos(a)} y2={68 - r2 * Math.sin(a)} />;
  };
  return (
    <svg class={`tr-gauge tr-lvl ${level(p)}`} viewBox="0 0 132 76" aria-hidden="true">
      <path class="tr-gauge-track" d={arc} />
      {p > 0 && <path class="tr-gauge-val" d={arc} pathLength="100" style={{ strokeDasharray: `${p * 100} 100` }} />}
      {Array.from({ length: 11 }, (_, i) => tick(i))}
      <line class="tr-needle" x1="66" y1="68" x2="66" y2="36" style={{ transform: `rotate(${-90 + 180 * p}deg)` }} />
      <circle class="tr-hub" cx="66" cy="68" r="6.5" />
      <circle class="tr-hub-dot" cx="66" cy="68" r="2.4" />
    </svg>
  );
}

/** One resource's widget: its name and how full it is, the drawing, what is left now and of how much a day, what it pays for, when it is full again. */
function Meter({ label, avail, limit, viz, enough, again, tone }) {
  const p = pctOf(avail, limit);
  return (
    <div class="card tr-meter" role="group" aria-label={`${label}: ${compact(avail)} / ${compact(limit)}`}>
      <div class="tr-meter-head"><span class="small bold">{label}</span>{limit > 0 && <span class={`tr-meter-pct ${tone || level(p)}`}>{Math.round(clamp01(p) * 100)}%</span>}</div>
      <div class="tr-meter-viz">{viz}</div>
      <div class="tr-meter-val">{compact(avail)}</div>
      {limit > 0 && <div class="tr-meter-sub">{t('tron.res.ofDaily', { n: compact(limit) })}</div>}
      <div class="tr-meter-sub">{enough}</div>
      {again && <div class="tr-meter-sub dim">{again}</div>}
    </div>
  );
}

/**
 * On top: energy as a battery, bandwidth as a gauge (both have a daily amount that comes back over 24 hours): what is
 * left now, what it pays for, when it is full again.
 */
function Hero({ res }) {
  const e = res.energy, b = res.bandwidth;
  const bLimit = bwLimit(res), bUsed = b.free.used || b.staked.used, bFull = Math.max(fullAt(b.free), fullAt(b.staked));
  const cov = coverage(res);
  const refill = (used, at) => (!used ? t('tron.res.full') : at > Date.now() ? t('tron.res.fullIn', { when: inTime(at) }) : t('tron.res.refilling'));
  return (
    <div class="tr-meters">
      <Meter
        label={t('tron.res.energy')} avail={e.available} limit={e.limit}
        viz={<Battery pct={pctOf(e.available, e.limit)} charging={e.limit > 0 && e.used > 0} tone={batteryTone(res)} />} tone={batteryTone(res)}
        enough={e.limit ? t('tron.res.enoughFor', { what: tn('tron.res.pillTokens', cov.tokens) }) : t('tron.res.noneDaily')}
        again={e.limit ? refill(e.used, fullAt(e)) : ''}
      />
      <Meter
        label={t('tron.res.bandwidth')} avail={b.available} limit={bLimit}
        viz={<Gauge pct={pctOf(b.available, bLimit)} />}
        enough={t('tron.res.enoughFor', { what: tn('tron.res.pillSends', cov.sends) })}
        again={refill(bUsed, bFull)}
      />
    </div>
  );
}

/** What the usual operations cost now, with the account's resources. */
function CostStrip({ res, params }) {
  const usdt = costOf({ res, params, bytes: TOKEN_SEND_BYTES, energy: USDT_ENERGY });
  const send = costOf({ res, params, bytes: TRX_SEND_BYTES });
  const price = (c) => <b class={c.total ? 'amber' : 'green'}>{c.total ? `≈ ${TRX(c.total)}` : t('tron.res.covered')}</b>;
  // why it costs something: the energy that is missing, or bandwidth below the transaction's size (then all of it is paid)
  const why = (c) => [
    c.energy.burn ? t('tron.res.missingEnergy', { n: compact(c.energy.need - c.energy.covered) }) : '',
    c.bandwidth.burn ? t('tron.res.bwShort', { n: fmtNum(c.bandwidth.bytes, 0) }) : '',
  ].filter(Boolean).join(' · ') || null;
  return (
    <Box title={t('tron.res.costsNow')}>
      <Line icon="flash" title={t('tron.res.costToken')} sub={why(usdt) || t('tron.res.tokenRef', { n: compact(USDT_ENERGY) })} value={price(usdt)} />
      <Line icon="signal" title={t('tron.res.costTrx')} sub={why(send)} value={price(send)} />
    </Box>
  );
}

// ------------------------------------------------------------ stake
function StakePanel({ res, stake, run, setSheet }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const go = async (k, contract, title, done) => { setErr(''); setBusy(k); try { await run(contract, { title, done }); } catch (e) { if (!e.cancelled) setErr(e.message); } setBusy(''); };
  const perE = res.perTrx.energy, perB = res.perTrx.bandwidth;
  const pending = stake.unstaking.filter((u) => u.at > Date.now());
  const eSun = stake.energy + stake.delegatedEnergy, bSun = stake.bandwidth + stake.delegatedBandwidth;
  // what the staked TRX give a day; with none yet, what 1,000 TRX would
  const sub = (sun, delegated, per) => (sun
    ? `${t('tron.stake.gives', { n: compact(trxOf(sun) * per) })}${delegated ? ` · ${t('tron.stake.delegatedPart', { amount: TRX(delegated, 0) })}` : ''}`
    : t('tron.stake.per1000', { n: compact(per * 1000) }));
  return (
    <div class="tr-panel">
      <Box
        title={t('tron.stake.yours')} aside={<b class="tr-box-total">{TRX(eSun + bSun, 0)}</b>}
        actions={<>
          <Btn onClick={() => setSheet({ kind: 'stake', resource: 'ENERGY' })}><Icon name="lock" size={16} /> {t('tron.stake.do')}</Btn>
          <Btn kind="secondary" disabled={!(stake.energy + stake.bandwidth)} onClick={() => setSheet({ kind: 'unstake' })}><Icon name="lockOpen" size={16} /> {t('tron.stake.undo')}</Btn>
        </>}
        hint={t('tron.stake.how')}
      >
        <Line icon="flash" title={t('tron.res.energy')} sub={sub(eSun, stake.delegatedEnergy, perE)} value={TRX(eSun, 0)} off={!eSun} />
        <Line icon="signal" title={t('tron.res.bandwidth')} sub={sub(bSun, stake.delegatedBandwidth, perB)} value={TRX(bSun, 0)} off={!bSun} />
        {stake.unstaking.length > 0 && <>
          <div class="tr-sub">{t('tron.stake.unstaking')}</div>
          {stake.unstaking.map((u) => (
            <Line icon="timer" title={TRX(u.amount)} sub={u.resource === 'ENERGY' ? t('tron.res.energy') : t('tron.res.bandwidth')}
              value={u.at <= Date.now() ? <span class="badge green">{t('tron.stake.ready')}</span> : <span class="badge amber">{inTime(u.at)}</span>} />
          ))}
          <div class="tr-actions">
            {stake.withdrawable > 0n && <Btn class="sm" loading={busy === 'w'} onClick={() => go('w', withdrawTx(res.account.address), t('tron.stake.withdraw'), t('tron.stake.withdrawn'))}>{t('tron.stake.withdrawAmount', { amount: TRX(stake.withdrawable) })}</Btn>}
            {pending.length > 0 && <Btn kind="secondary" class="sm" loading={busy === 'c'} onClick={() => go('c', cancelUnstakeTx(res.account.address), t('tron.stake.cancel'), t('tron.stake.cancelled'))}>{t('tron.stake.cancel')}</Btn>}
          </div>
        </>}
        {err && <div class="error small">{err}</div>}
      </Box>
    </div>
  );
}

function ResourceSeg({ value, onChange }) {
  return (
    <div class="seg seg-full tr-seg">
      <button class={value === 'ENERGY' ? 'on' : ''} onClick={() => onChange('ENERGY')}><Icon name="flash" size={14} /> {t('tron.res.energy')}</button>
      <button class={value === 'BANDWIDTH' ? 'on' : ''} onClick={() => onChange('BANDWIDTH')}><Icon name="signal" size={14} /> {t('tron.res.bandwidth')}</button>
    </div>
  );
}

function AmountField({ value, onInput, max, label }) {
  return (
    <div class="field">
      <label>{label}</label>
      <div class="input-wrap">
        <input inputMode="decimal" placeholder="0" value={value} onInput={(e) => onInput(e.target.value)} />
        <span class="muted small">TRX</span>
        {max != null && <button class="btn ghost sm" onClick={() => onInput(inputOf(max))}>{t('send.max')}</button>}
      </div>
    </div>
  );
}

const RESERVE = 2_000_000n; // TRX left for the fees of the next operations

function StakeSheet({ res, params, balance, run, onClose, initial }) {
  const [resource, setResource] = useState(initial || 'ENERGY');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sun = toSun(amount);
  const max = balance > RESERVE ? balance - RESERVE : 0n;
  const energy = resource === 'ENERGY';
  const per = energy ? res.perTrx.energy : res.perTrx.bandwidth;
  const gets = sun ? trxOf(sun) * per : 0;
  const days = params.getUnfreezeDelayDays ?? 14;
  const bad = !sun || sun < 1_000_000n ? t('tron.stake.min') : sun > max ? t('tron.stake.tooMuch') : null;
  const go = async () => { setErr(''); setBusy(true); try { await run(stakeTx(res.account.address, sun, resource), { title: t('tron.stake.do'), done: t('tron.stake.done') }); onClose(); } catch (e) { if (!e.cancelled) setErr(e.message); setBusy(false); } };
  return (
    <Sheet title={t('tron.stake.title')} onClose={onClose}>
      <ResourceSeg value={resource} onChange={setResource} />
      <AmountField label={t('tron.stake.amount')} value={amount} onInput={setAmount} max={max} />
      <div class="tr-preview">
        <Icon name={energy ? 'flash' : 'signal'} size={18} />
        <span class="grow">
          <b>{t(energy ? 'tron.stake.getsEnergy' : 'tron.stake.getsBw', { n: compact(gets) })}</b>
          <span class="tiny">{energy
            ? (gets >= USDT_ENERGY ? tn('tron.stake.tokensPerDay', Math.floor(gets / USDT_ENERGY)) : t('tron.stake.tokenNeeds', { n: compact(Math.ceil(USDT_ENERGY / Math.max(per, 1e-9))) }))
            : (gets >= TRX_SEND_BYTES ? tn('tron.stake.sendsPerDay', Math.floor(gets / TRX_SEND_BYTES)) : t('tron.stake.sendNeeds', { n: compact(Math.ceil(TRX_SEND_BYTES / Math.max(per, 1e-9))) }))}</span>
        </span>
      </div>
      <Notes items={[['vote', sun ? t('tron.stake.votesToo', { n: fmtNum(trxOf(sun), 0) }) : ''], ['timer', t('tron.stake.unlockNote', { days })]]} />
      {sun > 0n && bad && <div class="warn small">{bad}</div>}
      {err && <div class="error">{err}</div>}
      <Btn loading={busy} disabled={!!bad} onClick={go}>{t('tron.stake.confirm', { amount: sun ? TRX(sun, 6) : 'TRX' })}</Btn>
    </Sheet>
  );
}

function UnstakeSheet({ res, params, stake, run, onClose }) {
  const [resource, setResource] = useState(stake.energy >= stake.bandwidth ? 'ENERGY' : 'BANDWIDTH');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sun = toSun(amount);
  const max = resource === 'ENERGY' ? stake.energy : stake.bandwidth;
  const days = params.getUnfreezeDelayDays ?? 14;
  const bad = !sun || sun < 1_000_000n ? t('tron.stake.min') : sun > max ? t('tron.stake.tooMuchStaked') : null;
  const go = async () => { setErr(''); setBusy(true); try { await run(unstakeTx(res.account.address, sun, resource), { title: t('tron.stake.undo'), done: t('tron.stake.undone', { days }) }); onClose(); } catch (e) { if (!e.cancelled) setErr(e.message); setBusy(false); } };
  return (
    <Sheet title={t('tron.stake.undoTitle')} onClose={onClose}>
      <ResourceSeg value={resource} onChange={setResource} />
      <AmountField label={t('tron.stake.amountStaked', { amount: TRX(max, 0) })} value={amount} onInput={setAmount} max={max} />
      <div class="tr-preview">
        <Icon name="timer" size={18} />
        <span class="grow"><b>{t('tron.stake.backIn', { days })}</b><span class="tiny">{t('tron.stake.undoLose')}</span></span>
      </div>
      {sun > 0n && bad && <div class="warn small">{bad}</div>}
      {err && <div class="error">{err}</div>}
      <Btn loading={busy} disabled={!!bad} onClick={go}>{t('tron.stake.undoConfirm', { amount: sun ? TRX(sun, 6) : 'TRX' })}</Btn>
    </Sheet>
  );
}

// ------------------------------------------------------------ rent (JustLend)
const PER_DAY = [1, 3, 5, 10, 20, 50];
const DAYS = [1, 3, 7, 30];

function RentPanel({ chain, res, params, address, run }) {
  const market = rentMarketOf(chain);
  const [terms, setTerms] = useState(null);
  const [rental, setRental] = useState(undefined);
  const [perDay, setPerDay] = useState(1);
  const [days, setDays] = useState(7);
  const [q, setQ] = useState(null);
  const [txEnergy, setTxEnergy] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!market) return;
    rentTerms(chain).then(setTerms).catch((e) => setErr(e.message));
    myRental(chain, address).then(setRental).catch(() => setRental(null));
  }, [chain.id, address, tick]);
  useEffect(() => {
    if (!terms) return undefined;
    let alive = true;
    setQ(null);
    rentQuote(chain, { terms, energyPerDay: perDay * USDT_ENERGY, days, energyPerTrx: res.perTrx.energy, energyFee: params.getEnergyFee })
      .then(async (x) => {
        if (!alive) return;
        setQ(x);
        // the rental is itself a contract call: what its energy costs
        const sim = await constantCall(chain, { owner: address, contract: market, data: rentTx(address, address, x.amount, x.prepay, market).parameter.data, callValue: x.prepay }).catch(() => null);
        if (alive) setTxEnergy(sim?.ok ? sim.energy : 90_000);
      })
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [terms, perDay, days]);
  if (!market) return <div class="tr-panel"><Box title={t('tron.rent.do')}><p class="tr-box-empty">{t('tron.rent.testnet')}</p></Box></div>;

  const energyFee = Number(params.getEnergyFee ?? 100);
  const txFee = txEnergy != null ? BigInt(Math.max(0, txEnergy - res.energy.available)) * BigInt(energyFee) : null;
  const total = q && txFee != null ? q.cost + txFee : null;
  const saves = q && total != null ? q.burn - total : null;
  const doRent = async () => {
    setErr(''); setBusy('rent');
    try {
      await run(rentTx(address, address, q.amount, q.prepay, market), { title: t('tron.rent.do'), done: t('tron.rent.done'), energy: txEnergy || 90_000 });
      setTick((x) => x + 1);
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };
  const doReturn = async () => {
    setErr(''); setBusy('return');
    try {
      const data = returnTx(address, address, rental.amount, market);
      const sim = await constantCall(chain, { owner: address, contract: market, data: data.parameter.data }).catch(() => null);
      await run(data, { title: t('tron.rent.return'), done: t('tron.rent.returned'), energy: sim?.ok ? sim.energy : 60_000 });
      setTick((x) => x + 1);
    } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };
  return (
    <div class="tr-panel">
      {rental && (
        <Box title={t('tron.rent.activeTitle')} actions={<Btn kind="secondary" loading={busy === 'return'} onClick={doReturn}>{t('tron.rent.return')}</Btn>}>
          <Line icon="flash" title={t('tron.rent.active', { n: compact(trxOf(rental.amount) * res.perTrx.energy) })} sub={t('tron.rent.deposit', { amount: TRX(rental.deposit), days: rental.daysLeft != null ? fmtNum(rental.daysLeft, 1) : '–' })} />
          {rental.liquidatable && <div class="warn small">{t('tron.rent.ending')}</div>}
        </Box>
      )}
      <Box
        title={t('tron.rent.do')}
        actions={<Btn loading={busy === 'rent'} disabled={!q || txFee == null || terms?.paused || !!rental} onClick={doRent}>{rental ? t('tron.rent.oneAtATime') : q ? t('tron.rent.confirm', { amount: TRX(q.prepay, 1) }) : t('tron.rent.do')}</Btn>}
        hint={t('tron.rent.how')}
      >
        <div class="tr-q"><span class="tr-q-label">{t('tron.rent.howMany')}</span><div class="pills" style={{ '--n': PER_DAY.length }}>{PER_DAY.map((n) => <button class={`pill ${perDay === n ? 'active' : ''}`} onClick={() => setPerDay(n)}>{n}</button>)}</div></div>
        <div class="tr-q"><span class="tr-q-label">{t('tron.rent.forHowLong')}</span><div class="pills" style={{ '--n': DAYS.length }}>{DAYS.map((n) => <button class={`pill ${days === n ? 'active' : ''}`} onClick={() => setDays(n)}>{tn('tron.rent.days', n)}</button>)}</div></div>
        <div class="tr-compare">
          <div class={`tr-compare-col ${saves != null && saves > 0n ? 'win' : ''}`}>
            <span class="tiny muted">{t('tron.rent.renting')}</span>
            <b>{total != null ? TRX(total, 1) : <Spinner />}</b>
          </div>
          <div class={`tr-compare-col ${saves != null && saves <= 0n ? 'win' : ''}`}>
            <span class="tiny muted">{t('tron.rent.burning')}</span>
            <b>{q ? TRX(q.burn, 1) : <Spinner />}</b>
          </div>
        </div>
        {saves != null && (saves > 0n
          ? <div class="tr-verdict good"><Icon name="check" size={14} /> {t('tron.rent.saves', { amount: TRX(saves, 1) })}</div>
          : <div class="tr-verdict"><Icon name="warn" size={14} /> {t('tron.rent.notWorth')}</div>)}
        {q && (
          <details class="tr-details">
            <summary class="tiny">{t('tron.rent.detailsTitle')}</summary>
            <div class="tiny muted">{t('tron.rent.details', { trx: TRX(q.amount, 0), perDay: TRX(q.rentPerDay), fee: TRX(q.fee), tx: txFee != null ? TRX(txFee) : '–', prepay: TRX(q.prepay) })}</div>
          </details>
        )}
        {terms?.paused && <div class="warn small">{t('tron.rent.paused')}</div>}
        {err && <div class="error small">{err}</div>}
      </Box>
    </div>
  );
}

// ------------------------------------------------------------ votes
function VotePanel({ chain, stake, address, run, setSheet }) {
  const [reward, setReward] = useState(null);
  const [srs, setSrs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => { rewards(chain, address).then(setReward).catch(() => setReward(0n)); superReps(chain).then(setSrs).catch(() => setSrs([])); }, [address, tick]);
  const name = (a) => srs?.find((s) => s.address === a)?.name || shortAddr(a);
  const claim = async () => { setErr(''); setBusy(true); try { await run(claimTx(address), { title: t('tron.vote.claim'), done: t('tron.vote.claimed') }); setTick((x) => x + 1); } catch (e) { if (!e.cancelled) setErr(e.message); } setBusy(false); };
  const power = stake.power.total;
  return (
    <div class="tr-panel">
      <Box
        title={t('tron.vote.box')}
        actions={(reward > 0n || power > 0) && <>
          {reward > 0n && <Btn kind="secondary" loading={busy} onClick={claim}><Icon name="trophy" size={16} /> {t('tron.vote.claim')}</Btn>}
          {power > 0 && <Btn onClick={() => setSheet({ kind: 'vote' })}><Icon name="vote" size={16} /> {stake.votes.length ? t('tron.vote.change') : t('tron.vote.do')}</Btn>}
        </>}
        hint={power > 0 ? t('tron.vote.how') : t('tron.vote.needStake')}
      >
        <div class="tr-stats">
          <Stat label={t('tron.vote.power')} value={fmtNum(power, 0)} sub={t('tron.vote.used', { used: fmtNum(stake.power.used, 0) })} />
          <Stat label={t('tron.vote.rewardsShort')} value={reward != null ? TRX(reward) : '…'} sub={t('tron.vote.toClaim')} tone={reward > 0n ? 'green' : ''} />
        </div>
        {stake.votes.length > 0 && <>
          <div class="tr-sub">{t('tron.vote.yours')}</div>
          {stake.votes.map((v) => <Line icon="landmark" title={name(v.address)} value={fmtNum(v.count, 0)} />)}
        </>}
        {err && <div class="error small">{err}</div>}
      </Box>
    </div>
  );
}

function VoteSheet({ chain, params, stake, address, run, onClose }) {
  const [srs, setSrs] = useState(null);
  const [aprs, setAprs] = useState({});
  const [pick, setPick] = useState(stake.votes[0]?.address || null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    superReps(chain).then(async (list) => {
      if (!alive) return;
      const top = list.slice(0, 30);
      setSrs(top);
      setPick((p) => p || top[0]?.address);
      for (const s of top) { // one at a time: TronGrid without a key allows few requests a second
        const b = await brokerage(chain, s.address);
        if (!alive) return;
        setAprs((m) => ({ ...m, [s.address]: voteApr(s, list, params, b) }));
      }
    }).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, []);
  const power = stake.power.total;
  const sel = srs?.find((s) => s.address === pick);
  const apr = sel ? aprs[sel.address] : null;
  const go = async () => { setErr(''); setBusy(true); try { await run(voteTx(address, [{ address: pick, count: power }]), { title: t('tron.vote.do'), done: t('tron.vote.done') }); onClose(); } catch (e) { if (!e.cancelled) setErr(e.message); setBusy(false); } };
  return (
    <Sheet title={t('tron.vote.title')} onClose={onClose}>
      <div class="small muted">{t('tron.vote.pick', { n: fmtNum(power, 0) })}</div>
      {srs && <div class="tr-srs-head"><span>{t('tron.vote.colSr')}</span><span>{t('tron.vote.colApr')}</span></div>}
      {!srs ? <div class="empty"><Spinner /></div> : (
        <div class="list tr-srs">
          {srs.map((s) => (
            <button class={`item ${s.address === pick ? 'sel' : ''}`} onClick={() => setPick(s.address)}>
              <span class="tr-rank">{s.rank}</span>
              <span class="grow" style={{ minWidth: 0 }}><b class="small ellipsis">{s.name}</b><span class="tiny muted">{tn('tron.vote.votes', s.votes, { n: compact(s.votes) })}{s.producing ? ` · ${t('tron.vote.sr')}` : ''}</span></span>
              <span class="small green">{aprs[s.address] != null ? `${fmtNum(aprs[s.address] * 100, 2)}%` : '…'}</span>
            </button>
          ))}
        </div>
      )}
      {sel && <div class="tr-preview"><Icon name="trophy" size={18} /><span class="grow"><b>{apr != null ? t('tron.vote.yearly', { amount: fmtNum(power * apr, power * apr >= 100 ? 0 : 1), pct: fmtNum(apr * 100, 2) }) : '…'}</b><span class="tiny">{t('tron.vote.estimate')}</span></span></div>}
      {stake.votes.length > 0 && <Notes items={[['refresh', t('tron.vote.replaces')]]} />}
      {err && <div class="error">{err}</div>}
      <Btn loading={busy} disabled={!pick || !power} onClick={go}>{t('tron.vote.confirm', { name: sel?.name || '' })}</Btn>
    </Sheet>
  );
}

// ------------------------------------------------------------ delegate
function DelegatePanel({ chain, address, run, setSheet, res }) {
  const { state } = useApp();
  const tronMap = useTronAccounts();
  const [list, setList] = useState(null);
  const [can, setCan] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => { delegations(chain, address).then(setList).catch((e) => setErr(e.message)); canDelegate(chain, address).then(setCan).catch(() => setCan(null)); }, [address, tick]);
  const own = (a) => { const id = Object.entries(tronMap || {}).find(([, w]) => w.address === a)?.[0]; return id ? state.accounts.find((x) => x.address === id)?.name : null; };
  const revoke = async (d, resource) => {
    setErr(''); setBusy(`${d.address}:${resource}`);
    try { await run(undelegateTx(address, d.address, resource === 'ENERGY' ? d.energy : d.bandwidth, resource), { title: t('tron.del.revoke'), done: t('tron.del.revoked') }); setTick((x) => x + 1); } catch (e) { if (!e.cancelled) setErr(e.message); }
    setBusy('');
  };
  const row = (d, resource, inbound) => {
    const sun = resource === 'ENERGY' ? d.energy : d.bandwidth;
    if (!sun) return null;
    const lock = resource === 'ENERGY' ? d.energyLock : d.bandwidthLock;
    const locked = lock > Date.now();
    const per = resource === 'ENERGY' ? res.perTrx.energy : res.perTrx.bandwidth;
    return (
      <Line
        icon={resource === 'ENERGY' ? 'flash' : 'signal'} title={own(d.address) || shortAddr(d.address, 5)} sub={`${TRX(sun, 0)} · ≈ ${compact(trxOf(sun) * per)}/${t('tron.res.day')}`}
        value={inbound ? null : locked ? <span class="badge amber">{t('tron.del.lockedUntil', { when: inTime(lock) })}</span>
          : <Btn kind="secondary" class="sm" loading={busy === `${d.address}:${resource}`} onClick={() => revoke(d, resource)}>{t('tron.del.revoke')}</Btn>}
      />
    );
  };
  const none = list && list.out.length + list.in.length === 0;
  return (
    <div class="tr-panel">
      <Box
        title={t('tron.del.box')}
        actions={<Btn disabled={!can || !(can.ENERGY + can.BANDWIDTH)} onClick={() => setSheet({ kind: 'delegate' })}><Icon name="share" size={16} /> {t('tron.del.do')}</Btn>}
        hint={t('tron.del.how')}
      >
        <div class="tr-stats">
          <Stat label={t('tron.res.energy')} value={can ? TRX(can.ENERGY, 0) : '…'} sub={t('tron.del.canSub')} />
          <Stat label={t('tron.res.bandwidth')} value={can ? TRX(can.BANDWIDTH, 0) : '…'} sub={t('tron.del.canSub')} />
        </div>
        {!list && !err && <div class="row small muted"><Spinner /></div>}
        {none && <p class="tr-box-empty">{t('tron.del.empty')}</p>}
        {list?.out.length > 0 && <><div class="tr-sub">{t('tron.del.out')}</div>{list.out.map((d) => [row(d, 'ENERGY'), row(d, 'BANDWIDTH')])}</>}
        {list?.in.length > 0 && <><div class="tr-sub">{t('tron.del.in')}</div>{list.in.map((d) => [row(d, 'ENERGY', true), row(d, 'BANDWIDTH', true)])}</>}
        {err && <div class="error small">{err}</div>}
      </Box>
    </div>
  );
}

function DelegateSheet({ chain, res, address, run, onClose }) {
  const { state } = useApp();
  const tronMap = useTronAccounts();
  const [to, setTo] = useState('');
  const [resource, setResource] = useState('ENERGY');
  const [amount, setAmount] = useState('');
  const [lock, setLock] = useState(false);
  const [can, setCan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { canDelegate(chain, address).then(setCan).catch(() => setCan(null)); }, []);
  const mine = Object.entries(tronMap || {}).filter(([, w]) => w.address !== address).map(([id, w]) => ({ address: w.address, name: state.accounts.find((a) => a.address === id)?.name }));
  const sun = toSun(amount);
  const max = can ? can[resource] : null;
  const per = resource === 'ENERGY' ? res.perTrx.energy : res.perTrx.bandwidth;
  const bad = !isAddress(to.trim()) ? t('tron.send.badAddress') : to.trim() === address ? t('tron.del.self') : !sun || sun < 1_000_000n ? t('tron.stake.min') : max != null && sun > max ? t('tron.del.tooMuch') : null;
  const go = async () => { setErr(''); setBusy(true); try { await run(delegateTx(address, to.trim(), sun, resource, lock ? 3 : 0), { title: t('tron.del.do'), done: t('tron.del.done') }); onClose(); } catch (e) { if (!e.cancelled) setErr(e.message); setBusy(false); } };
  return (
    <Sheet title={t('tron.del.title')} onClose={onClose}>
      <div class="field">
        <label>{t('tron.del.to')}</label>
        <input class="input mono" value={to} placeholder={t('tron.send.placeholder')} spellcheck={false} autocapitalize="off" onInput={(e) => setTo(e.target.value)} />
        {mine.length > 0 && <div class="pills">{mine.map((m) => <button class={`pill ${to === m.address ? 'active' : ''}`} onClick={() => setTo(m.address)}>{m.name || shortAddr(m.address)}</button>)}</div>}
      </div>
      <ResourceSeg value={resource} onChange={setResource} />
      <AmountField label={t('tron.del.amount', { amount: max != null ? TRX(max, 0) : '…' })} value={amount} onInput={setAmount} max={max} />
      <div class="tr-preview">
        <Icon name={resource === 'ENERGY' ? 'flash' : 'signal'} size={18} />
        <span class="grow"><b>{t(resource === 'ENERGY' ? 'tron.del.getsEnergy' : 'tron.del.getsBw', { n: compact(sun ? trxOf(sun) * per : 0) })}</b><span class="tiny">{t('tron.del.stillYours')}</span></span>
      </div>
      <label class="row small" style={{ gap: '.5rem' }}><input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> {t('tron.del.lock')}</label>
      {to && sun > 0n && bad && <div class="warn small">{bad}</div>}
      {err && <div class="error">{err}</div>}
      <Btn loading={busy} disabled={!!bad} onClick={go}>{t('tron.del.confirm')}</Btn>
    </Sheet>
  );
}

// ------------------------------------------------------------ security
/** Who can move the account's funds: only its own key (every new account), or others too (a scam took it over). */
function SecurityCard({ acc, address }) {
  const p = permissionsOf(acc, address);
  if (p.safe) return <div class="tr-sec safe"><Icon name="shield" size={16} /><span>{t('tron.sec.safe')}</span></div>;
  return (
    <div class="card tr-sec alarm">
      <div class="row" style={{ gap: '.5rem' }}><Icon name="warn" size={18} /><b class="small">{t('tron.sec.alarmTitle')}</b></div>
      <div class="small">{t('tron.sec.alarmBody')}</div>
      {p.others.map((a) => <div class="mono tiny">{a}</div>)}
      <div class="small">{t('tron.sec.alarmWhat')}</div>
    </div>
  );
}
