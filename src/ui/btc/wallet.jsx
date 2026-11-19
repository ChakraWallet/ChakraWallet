// The Bitcoin account's own page (from the home's card): its addresses (used, given out, change; a full search for
// funds again), its coins (the ones that may carry inscriptions or runes, protected; freeze, allow, choose the coins
// of the next send) and the export of its public keys (output descriptors, to follow it watch-only in another wallet).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Icon, Btn, TopBar, Spinner, CopyBtn, QR, useApp } from '../components.jsx';
import { useChainAddress } from '../hooks.js';
import { t } from '../../shared/i18n.js';
import { fmtAmount, shortAddr } from '../../shared/format.js';
import { TYPES, branchDescriptor, toNetworkXpub } from '../../shared/btc/keys.js';
import { decodeAccount, loadState, scanAccount, listAddresses } from '../../shared/btc/account.js';
import { setCoinPref, outpoint } from '../../shared/btc/coins.js';
import { unisatReady } from '../../shared/btc/unisat.js';
import { accountContext } from './plan.js';
import { useCoinsForNextSend } from './driver.js';

const btc = (sats, chain) => `${fmtAmount(sats, 8, 8)} ${chain.native.symbol}`;

/** The home's card: what is on its way in, how many addresses, the page with addresses and coins. */
export function BtcHomeExtra({ chain, data }) {
  const { nav } = useApp();
  const b = data?.btc;
  if (!b) return null;
  const pending = BigInt(b.pending || 0);
  return (
    <button class="card btc-card" onClick={() => nav('btcWallet')}>
      <div class="row" style={{ justifyContent: 'space-between' }}><b>{t('btc.wallet.title')}</b><span class="muted"><Icon name="forward" size={15} /></span></div>
      <div class="small muted">{t('btc.wallet.cardSub', { n: b.addresses })}</div>
      {pending !== 0n && <div class="small"><span class="badge amber">{t('history.pending')}</span> {pending > 0n ? '+' : ''}{btc(pending, chain)}</div>}
    </button>
  );
}

const TABS = [['addresses', 'btc.wallet.addresses'], ['coins', 'btc.coins.title'], ['export', 'btc.export.title']];

export function BtcWallet({ tab: initial = 'addresses' }) {
  const [tab, setTab] = useState(initial);
  return (
    <div class="screen">
      <TopBar title={t('btc.wallet.title')} />
      <div class="content">
        <div class="seg seg-full" role="tablist">{TABS.map(([k, l]) => <button class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(l)}</button>)}</div>
        {tab === 'addresses' && <Addresses />}
        {tab === 'coins' && <Coins />}
        {tab === 'export' && <Export />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ addresses
function Addresses() {
  const { chain, toast } = useApp();
  const addr = useChainAddress();
  const a = addr.raw ? decodeAccount(addr.raw) : null;
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState('receive');
  useEffect(() => { if (a) loadState(chain, a).then((s) => setList(listAddresses(chain, a, s))); }, [addr.raw]);
  const rescan = async () => {
    setBusy(true);
    try { const s = await scanAccount(chain, a, { full: true }); setList(listAddresses(chain, a, s)); toast(t('btc.wallet.rescanned')); } catch (e) { toast(e.message, 'warn'); }
    setBusy(false);
  };
  if (!a || !list) return <div class="empty"><Spinner /></div>;
  const rows = list.filter((x) => (show === 'receive' ? x.c === 0 : x.c === 1));
  return (
    <>
      <div class="seg" role="tablist">
        <button class={show === 'receive' ? 'on' : ''} onClick={() => setShow('receive')}>{t('btc.wallet.receiving')}</button>
        <button class={show === 'change' ? 'on' : ''} onClick={() => setShow('change')}>{t('btc.wallet.change')}</button>
      </div>
      <div class="list">
        {rows.map((x) => (
          <div class="item">
            <div class="grow" style={{ minWidth: 0 }}>
              <div class="mono small ellipsis">{x.address}</div>
              <div class="tiny muted">{TYPES[x.type]?.label} · {a.branches[x.b].single ? t('btc.wallet.singleKey') : `${a.branches[x.b].path}/${x.c}/${x.i}`}</div>
            </div>
            <div class="right">
              {x.used ? <div class="small bold">{btc(x.balance + x.pending, chain)}</div> : <span class="badge green">{t('btc.wallet.unused')}</span>}
              {x.used && <div class="tiny muted">{t('btc.wallet.txs', { n: x.txs })}</div>}
            </div>
            <CopyBtn text={x.address} />
          </div>
        ))}
        {!rows.length && <div class="empty small muted">{t('btc.wallet.none')}</div>}
      </div>
      <Btn kind="secondary" loading={busy} onClick={rescan}>{t('btc.wallet.rescan')}</Btn>
    </>
  );
}

// ------------------------------------------------------------ coins
const PROTECT = { inscription: 'btc.coins.inscription', runes: 'btc.coins.runes', small: 'btc.coins.small', unknown: 'btc.coins.unknown' };

function Coins() {
  const { chain, nav, toast } = useApp();
  const addr = useChainAddress();
  const [ctx, setCtx] = useState(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!addr.raw) return;
    accountContext(chain, addr.raw).then(setCtx, (e) => setErr(e.message));
  }, [addr.raw, tick]);
  const total = useMemo(() => (ctx ? ctx.coins.filter((c) => picked.has(outpoint(c))).reduce((s, c) => s + c.value, 0n) : 0n), [ctx, picked]);
  if (err) return <div class="error">{err}</div>;
  if (!ctx) return <div class="empty"><Spinner /></div>;
  const toggle = (c) => setPicked((p) => { const n = new Set(p); const k = outpoint(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const pref = async (c, p) => { await setCoinPref(chain, ctx.a, outpoint(c), p); setTick((x) => x + 1); };
  const send = () => { useCoinsForNextSend(addr.raw, [...picked]); toast(t('btc.coins.chosen', { n: picked.size })); nav('send'); };
  return (
    <>
      <div class="info small">{unisatReady(chain) ? (ctx.precise ? t('btc.coins.preciseOn') : t('btc.coins.precisePartial')) : t('btc.coins.preciseOff')}</div>
      <div class="list">
        {ctx.coins.map((c) => (
          <div class={`item ${c.frozen ? 'muted' : ''}`}>
            <input type="checkbox" checked={picked.has(outpoint(c))} disabled={c.frozen} onChange={() => toggle(c)} />
            <div class="grow" style={{ minWidth: 0 }}>
              <div class="bold small">{btc(c.value, chain)}</div>
              <div class="tiny muted ellipsis mono">{shortAddr(c.address, 6)} · {shortAddr(c.txid, 4)}:{c.vout}</div>
              <div class="row" style={{ gap: '0.25rem', flexWrap: 'wrap' }}>
                {!c.confirmed && <span class="badge amber">{t('history.pending')}</span>}
                {c.protect && <span class="badge">{t(PROTECT[c.protect])}</span>}
                {c.inscriptions.length > 0 && <span class="badge primary">{t('btc.coins.nInscriptions', { n: c.inscriptions.length })}</span>}
                {c.runes.map((r) => <span class="badge primary">{r.id}</span>)}
                {c.frozen && <span class="badge red">{t('btc.coins.frozen')}</span>}
                {c.allowed && <span class="badge green">{t('btc.coins.allowed')}</span>}
              </div>
            </div>
            <div class="col" style={{ gap: '0.25rem' }}>
              <button class="link small" onClick={() => pref(c, c.frozen ? null : 'frozen')}>{t(c.frozen ? 'btc.coins.unfreeze' : 'btc.coins.freeze')}</button>
              {c.protect && !c.frozen && <button class="link small" onClick={() => pref(c, c.allowed ? null : 'allowed')}>{t(c.allowed ? 'btc.coins.disallow' : 'btc.coins.allow')}</button>}
            </div>
          </div>
        ))}
        {!ctx.coins.length && <div class="empty small muted">{t('btc.coins.none')}</div>}
      </div>
      {picked.size > 0 && <Btn onClick={send}>{t('btc.coins.sendWith', { n: picked.size, amount: btc(total, chain) })}</Btn>}
    </>
  );
}

// ------------------------------------------------------------ export (watch-only elsewhere)
function Export() {
  const { chain } = useApp();
  const addr = useChainAddress();
  const a = addr.raw ? decodeAccount(addr.raw) : null;
  const [open, setOpen] = useState(null);
  if (!a) return <div class="empty"><Spinner /></div>;
  if (!a.fp && a.branches.every((b) => b.single)) return <div class="info small">{t('btc.export.single')}</div>;
  const branches = a.branches.filter((b) => !b.single && (a.receive.includes(b.type) || a.kind !== 'hd'));
  return (
    <>
      <div class="warn small">{t('btc.export.privacy')}</div>
      {branches.map((b) => {
        const desc = branchDescriptor(b, a.fp, !!chain.testnet);
        const xpub = toNetworkXpub(b.xpub, !!chain.testnet);
        return (
          <div class="card col" style={{ gap: '0.5rem' }}>
            <div class="row" style={{ justifyContent: 'space-between' }}><b>{TYPES[b.type].label}</b><span class="tiny muted mono">{b.path}</span></div>
            <div class="tiny muted">{t('btc.export.descriptor')}</div>
            <div class="mono tiny" style={{ wordBreak: 'break-all' }}>{desc}</div>
            <div class="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              <CopyBtn text={desc} label={t('btc.export.copyDescriptor')} />
              <CopyBtn text={xpub} label={t('btc.export.copyXpub')} />
              <button class="btn secondary sm" onClick={() => setOpen(open === b.type ? null : b.type)}>QR</button>
            </div>
            {open === b.type && <div class="qr-wrap" style={{ alignSelf: 'center' }}><QR text={desc} size={240} /></div>}
          </div>
        );
      })}
      <div class="tiny muted">{t('btc.export.how')}</div>
    </>
  );
}
