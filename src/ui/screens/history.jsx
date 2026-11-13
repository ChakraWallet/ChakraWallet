import { useEffect, useState, useMemo } from 'preact/hooks';
import { local } from '../../shared/ext.js';
import { loadHistory } from '../../shared/history.js';
import { reportScanError } from '../hooks.js';
import { fmtAmount, fmtUsd, toFloat, fmtDateGroup, fmtTime, fmtDateTime, shortAddr } from '../../shared/format.js';
import { TopBar, Icon, Spinner, Sheet, Empty, AddressLabel, CopyBtn, explorerTx, useApp, Avatar, ChainIcon, TokenIcon } from '../components.jsx';
import { BUILTIN_CHAINS, getChain } from '../../shared/chains.js';
import { POPULAR_TOKENS } from '../../shared/tokens.js';
import { lookupBridge } from '../../shared/bridge.js';
import { useNativePrice } from '../hooks.js';
import { t, tn } from '../../shared/i18n.js';

// labels are i18n keys
export const KIND = {
  send: { label: 'history.kind.send', icon: 'send', color: 'var(--red)', bg: 'var(--red-soft)' },
  receive: { label: 'history.kind.receive', icon: 'receive', color: 'var(--green)', bg: 'var(--green-soft)' },
  swap: { label: 'history.kind.swap', icon: 'swap', color: 'var(--primary)', bg: 'var(--primary-soft)' },
  approve: { label: 'history.kind.approve', icon: 'approve', color: 'var(--amber)', bg: 'var(--amber-soft)' },
  contract: { label: 'history.kind.contract', icon: 'contract', color: 'var(--muted)', bg: 'var(--card-2)' },
  self: { label: 'history.kind.self', icon: 'refresh', color: 'var(--muted)', bg: 'var(--card-2)' },
};
const FILTERS = [['all', 'history.filter.all'], ['send', 'history.filter.send'], ['receive', 'history.filter.receive'], ['swap', 'history.filter.swap'], ['other', 'history.filter.other']]; // i18n keys

const amt = (t) => `${fmtAmount(t.amount, t.decimals, 6)} ${t.symbol}`;

// bridges sent from the app, by source tx hash (to show them as "Bridge A → B" with their status)
const BRIDGE_CHAIN = (id) => BUILTIN_CHAINS.find((c) => c.id === id) || getChain(id); // also TON (Android app)
const tokenIcon = (chainId, x) => x.icon || (POPULAR_TOKENS[chainId] || []).find((p) => p.address === x.token)?.icon || '';
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
const provider = (it) => { const m = it.appTitle || it.method; return (m && /\(([^)]+)\)\s*$/.exec(m)?.[1]) || null; }; // "Swap … (KyberSwap)", the app's own title

function title(it, bridge) {
  const outs = it.transfers.filter((x) => x.dir === 'out'), ins = it.transfers.filter((x) => x.dir === 'in');
  if (bridge) {
    const from = BRIDGE_CHAIN(bridge.fromChainId)?.name || `#${bridge.fromChainId}`;
    const to = bridge.toChainId ? BRIDGE_CHAIN(bridge.toChainId)?.name || `#${bridge.toChainId}` : null;
    return to ? t('history.titleBridge', { from, to }) : t('history.titleBridgeFrom', { from });
  }
  if (it.kind === 'swap') return t('history.titleSwap', { from: outs[0].symbol, to: ins[0].symbol });
  if (it.kind === 'send') return t('history.titleSent', { symbol: outs[0].symbol });
  if (it.kind === 'receive') return t('history.titleReceived', { symbol: ins[0].symbol });
  if (it.kind === 'approve') {
    const sym = (POPULAR_TOKENS[it.chainId] || []).find((p) => p.address === String(it.to).toLowerCase())?.symbol;
    return sym ? t('history.titleApproveToken', { symbol: sym }) : t('history.titleApprove');
  }
  if (it.local && it.method) return it.method;
  return it.method ? t('history.titleContract', { method: it.method }) : t(KIND[it.kind].label);
}

/** Left glyph: two chains for a bridge, two tokens for a swap, the token with a direction badge for transfers. */
function Glyph({ it, k, bridge, chain }) {
  const outs = it.transfers.filter((x) => x.dir === 'out'), ins = it.transfers.filter((x) => x.dir === 'in');
  const tok = (x) => <TokenIcon symbol={x.symbol} icon={tokenIcon(chain.id, x)} color={x.native ? chain.color : undefined} />;
  if (bridge) {
    const fc = BRIDGE_CHAIN(bridge.fromChainId), tc = BRIDGE_CHAIN(bridge.toChainId);
    if (fc && tc) return <span class="glyph pair"><ChainIcon chain={fc} size={28} /><ChainIcon chain={tc} size={28} /></span>;
    return <div class="tx-icon" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}><Icon name="route" /></div>;
  }
  if (it.kind === 'swap' && outs[0] && ins[0]) return <span class="glyph pair">{tok(outs[0])}{tok(ins[0])}</span>;
  if ((it.kind === 'send' || it.kind === 'receive') && (outs[0] || ins[0])) {
    return <span class="glyph">{tok(outs[0] || ins[0])}<span class={`dir-badge ${it.kind}`}><Icon name={it.kind === 'send' ? 'send' : 'receive'} size={10} stroke={3} /></span></span>;
  }
  if (it.kind === 'approve') { // the approved token with a shield badge
    const p = (POPULAR_TOKENS[chain.id] || []).find((q) => q.address === String(it.to).toLowerCase());
    if (p) return <span class="glyph"><TokenIcon symbol={p.symbol} icon={p.icon} /><span class="dir-badge approve"><Icon name="approve" size={10} stroke={2.6} /></span></span>;
  }
  return <div class="tx-icon round" style={{ background: k.bg, color: k.color }}><Icon name={k.icon} size={18} /></div>;
}

function HistoryItem({ it, onOpen, bridge }) {
  const { chain } = useApp();
  const k = KIND[it.kind];
  const outs = it.transfers.filter((x) => x.dir === 'out'), ins = it.transfers.filter((x) => x.dir === 'in');
  // transactions made in the app have its name as origin, the ones of sites their URL
  const via = provider(it) || (it.origin && /^https?:\/\//.test(it.origin) ? hostOf(it.origin) : null);
  let sub;
  if (bridge && bridge.status !== 'unknown') sub = <><span class={`badge ${{ pending: 'amber', done: 'green', refunded: 'primary', failed: 'red' }[bridge.status]}`}>{t(`bridge.badge.${bridge.status}`)}</span>{bridge.provider ? ` ${t('history.via', { name: bridge.provider })}` : ''}</>;
  else if (bridge) sub = via || it.toName || null;
  else if (it.kind === 'swap') sub = via ? t('history.via', { name: via }) : null;
  else if (it.counterparty && (it.kind === 'send' || it.kind === 'receive')) sub = <>{t(it.kind === 'receive' ? 'history.from' : 'history.to')} <AddressLabel address={it.counterparty} /></>;
  else if (via) sub = via;
  return (
    <button class="item hist-item" onClick={() => onOpen(it)}>
      <Glyph it={it} k={k} bridge={bridge} chain={chain} />
      <div class="grow" style={{ minWidth: 0 }}>
        <div class="bold ellipsis">{title({ ...it, chainId: chain.id }, bridge)}</div>
        <div class="small muted ellipsis hist-sub">{fmtTime(it.time)}{sub ? <> · {sub}</> : null}</div>
      </div>
      <div class="right hist-amts">
        {outs.map((x) => <div class={`small bold ellipsis ${it.kind === 'swap' ? 'muted' : ''}`}>−{amt(x)}</div>)}
        {ins.map((x) => <div class="small bold green ellipsis">+{amt(x)}</div>)}
        {it.status === 'failed' && <span class="badge red">{t('history.failed')}</span>}
        {it.status === 'pending' && <span class="badge amber">{t('history.pending')}</span>}
        {it.spam && <span class="badge red">{t('history.spam')}</span>}
      </div>
    </button>
  );
}

/** Header of the details sheet: what happened, drawn with the real tokens / networks involved. */
function TxHead({ it, k, bridge, chain, status }) {
  const outs = it.transfers.filter((x) => x.dir === 'out'), ins = it.transfers.filter((x) => x.dir === 'in');
  const tok = (x) => <TokenIcon symbol={x.symbol} icon={tokenIcon(chain.id, x)} color={x.native ? chain.color : undefined} />;
  const fc = bridge && BRIDGE_CHAIN(bridge.fromChainId), tc = bridge && bridge.toChainId && BRIDGE_CHAIN(bridge.toChainId);
  let visual, amounts = null;
  if (bridge && fc) {
    visual = (
      <div class="head-route">
        <div class="head-node"><ChainIcon chain={fc} size={44} /><span>{fc.name}</span></div>
        <div class="head-path">{outs[0] ? <span class="head-path-tok">{tok(outs[0])}</span> : <Icon name="route" size={18} />}</div>
        <div class="head-node">{tc ? <ChainIcon chain={tc} size={44} /> : <span class="head-q">?</span>}<span>{tc ? tc.name : '…'}</span></div>
      </div>
    );
    amounts = outs[0] && <div class="tx-hero-amt">{amt(outs[0])}</div>;
  } else if (it.kind === 'swap' && outs[0] && ins[0]) {
    visual = (
      <div class="head-route swap">
        <div class="head-node">{tok(outs[0])}<span class="muted">−{amt(outs[0])}</span></div>
        <div class="head-arrow"><Icon name="forward" size={18} /></div>
        <div class="head-node">{tok(ins[0])}<span class="green">+{amt(ins[0])}</span></div>
      </div>
    );
  } else if ((it.kind === 'send' || it.kind === 'receive') && (outs[0] || ins[0])) {
    const x = outs[0] || ins[0];
    visual = <span class="head-tok">{tok(x)}<span class={`dir-badge ${it.kind}`}><Icon name={it.kind === 'send' ? 'send' : 'receive'} size={13} stroke={3} /></span></span>;
    amounts = it.transfers.map((y) => <div class={`tx-hero-amt ${y.dir === 'in' ? 'green' : ''}`}>{y.dir === 'in' ? '+' : '−'}{amt(y)}</div>);
  } else if (it.kind === 'approve') {
    const p = (POPULAR_TOKENS[chain.id] || []).find((q) => q.address === String(it.to).toLowerCase());
    visual = <span class="head-tok">{p ? <TokenIcon symbol={p.symbol} icon={p.icon} /> : <span class="tx-hero-ic round" style={{ background: k.bg, color: k.color }}><Icon name="approve" size={26} /></span>}{p && <span class="dir-badge approve"><Icon name="approve" size={12} stroke={2.6} /></span>}</span>;
  } else {
    visual = <div class="tx-hero-ic round" style={{ background: k.bg, color: k.color }}><Icon name={k.icon} size={26} /></div>;
    amounts = it.transfers.map((y) => <div class={`tx-hero-amt ${y.dir === 'in' ? 'green' : ''}`}>{y.dir === 'in' ? '+' : '−'}{amt(y)}</div>);
  }
  return (
    <div class="tx-head" style={{ '--tint': bridge ? 'var(--primary-soft)' : k.bg }}>
      {visual}
      <div class="tx-hero-title">{title({ ...it, chainId: chain.id }, bridge)}</div>
      {amounts}
      <div class="row" style={{ gap: '0.375rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        {!bridge && <span class="badge" style={{ background: k.bg, color: k.color }}>{t(k.label)}</span>}
        {bridge && bridge.status !== 'unknown' && <span class={`badge ${{ pending: 'amber', done: 'green', refunded: 'primary', failed: 'red' }[bridge.status]}`}>{t(`bridge.badge.${bridge.status}`)}</span>}
        {status && <span class={`badge ${status[0]}`}>{t(status[1])}</span>}
      </div>
      <div class="small muted">{fmtDateTime(it.time)}</div>
    </div>
  );
}

function Detail({ it, onClose, nativePrice, bridge }) {
  const { chain } = useApp();
  const k = KIND[it.kind];
  const feeUsd = it.fee != null && nativePrice != null ? toFloat(it.fee, chain.native.decimals) * nativePrice : null;
  const link = explorerTx(chain, it.hash);
  const status = it.status === 'ok' ? ['green', 'history.confirmed'] : it.status === 'failed' ? ['red', 'history.failed'] : it.status === 'pending' ? ['amber', 'history.pending'] : null;
  const Who = ({ address }) => (address ? <span class="who"><Avatar address={address} /><span class="ellipsis"><AddressLabel address={address} /></span></span> : '—');
  return (
    <Sheet title={t('history.details')} onClose={onClose}>
      <TxHead it={it} k={k} bridge={bridge} chain={chain} status={status} />

      <div class="card flat tx-rows">
        <div class="tx-row"><span class="k">{t('history.fromLabel')}</span><span class="v"><Who address={it.from} /></span></div>
        <div class="tx-row"><span class="k">{t('history.toLabel')}</span><span class="v"><Who address={it.to} /></span></div>
        {it.transfers.filter((x) => x.counterparty && x.counterparty !== it.to && x.counterparty !== it.from).map((x) => (
          <div class="tx-row"><span class="k">{t(x.dir === 'in' ? 'history.from' : 'history.to')} {x.symbol}</span><span class="v"><Who address={x.counterparty} /></span></div>
        ))}
        <div class="tx-row"><span class="k">{t('history.network')}</span><span class="v"><ChainIcon chain={chain} size={16} /><span class="ellipsis">{chain.name}</span></span></div>
        {bridge && bridge.toChainId && BRIDGE_CHAIN(bridge.toChainId) && <div class="tx-row"><span class="k">{t('history.bridgeTo')}</span><span class="v"><ChainIcon chain={BRIDGE_CHAIN(bridge.toChainId)} size={16} /><span class="ellipsis">{BRIDGE_CHAIN(bridge.toChainId).name}</span><span class={`badge ${{ pending: 'amber', done: 'green', refunded: 'primary', failed: 'red' }[bridge.status]}`}>{t(`bridge.badge.${bridge.status}`)}</span></span></div>}
        {bridge?.provider && <div class="tx-row"><span class="k">{t('bridge.via')}</span><span class="v"><span class="ellipsis">{bridge.provider}{bridge.tool && bridge.tool !== bridge.provider ? ` · ${bridge.tool}` : ''}</span></span></div>}
        {it.method && <div class="tx-row"><span class="k">{t('history.method')}</span><span class="v"><span class="method-pill ellipsis">{it.method}</span></span></div>}
        {it.origin && <div class="tx-row"><span class="k">{t('history.origin')}</span><span class="v"><span class="ellipsis">{it.origin}</span></span></div>}
        <div class="tx-row"><span class="k">{t('history.feePaid')}</span>
          <span class="v col-v">{it.fee != null ? <><span>{fmtAmount(it.fee, chain.native.decimals, 8)} {chain.native.symbol}</span>{feeUsd != null && <span class="tx-sub">≈ {fmtUsd(feeUsd)}</span>}</> : <span class="muted">{it.sentByMe ? '—' : t('history.feeBySender')}</span>}</span>
        </div>
        <div class="tx-row"><span class="k">{t('history.hash')}</span><span class="v"><span class="mono-s">{shortAddr(it.hash, 6)}</span><CopyBtn text={it.hash} /></span></div>
      </div>

      {link && <a class="btn secondary block" href={link} target="_blank"><Icon name="external" size={16} /> {t('history.viewExplorer')}</a>}
      {bridge?.destTxHash && BRIDGE_CHAIN(bridge.toChainId) && explorerTx(BRIDGE_CHAIN(bridge.toChainId), bridge.destTxHash) && (
        <a class="btn secondary block" href={explorerTx(BRIDGE_CHAIN(bridge.toChainId), bridge.destTxHash)} target="_blank"><Icon name="external" size={16} /> {t('history.viewArrival', { chain: BRIDGE_CHAIN(bridge.toChainId).name })}</a>
      )}
    </Sheet>
  );
}

export function HistoryList({ limit, filter = 'all' }) {
  const { chain, account, state } = useApp();
  const nativePrice = useNativePrice(chain);
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [open, setOpen] = useState(null);
  const [showSpam, setShowSpam] = useState(false);
  // bridges: the ones sent from the app + any other bridge transaction recognised in the history, whose
  // destination is asked once to Relay / LI.FI / deBridge (only the tx hash is sent) and remembered
  const [bridges, setBridges] = useState(new Map());
  useEffect(() => {
    let alive = true;
    (async () => {
      const [mine, info] = await Promise.all([local.get('bridges', []), local.get('bridgeInfo', {})]);
      const map = new Map([...Object.entries(info).map(([h, b]) => [h, b]), ...mine.map((b) => [b.txHash.toLowerCase(), b])]);
      if (alive) setBridges(new Map(map));
      const todo = (items || []).filter((x) => x.bridgeLike && (!map.has(x.hash.toLowerCase()) || (map.get(x.hash.toLowerCase()).status === 'pending' && Date.now() - (map.get(x.hash.toLowerCase()).checked || 0) > 60000))).slice(0, 6);
      for (const x of todo) {
        const r = await lookupBridge(chain.id, x.hash).catch(() => null);
        const h = x.hash.toLowerCase();
        const entry = r ? { ...r, txHash: h, checked: Date.now() } : { unknown: true, fromChainId: chain.id, txHash: h, checked: Date.now(), status: 'unknown' };
        await local.update('bridgeInfo', {}, (m) => Object.fromEntries(Object.entries({ ...m, [h]: entry }).slice(-200)));
        map.set(h, entry);
        if (alive) setBridges(new Map(map));
      }
    })();
    return () => { alive = false; };
  }, [items]);

  const load = async (cursor) => {
    setLoading(true);
    const log = (await local.get('txlog', {}))[`${chain.id}:${account.address.toLowerCase()}`] || [];
    const r = await loadHistory(chain, account.address, cursor, { etherscanKey: state.settings.etherscanKey, localLog: log });
    setItems((prev) => {
      const map = new Map((cursor ? prev || [] : []).map((x) => [x.hash, x]));
      for (const x of r.items) if (!map.has(x.hash)) map.set(x.hash, x);
      return [...map.values()].sort((a, b) => b.time - a.time);
    });
    setNext(r.next); setErr(r.error || ''); setUnsupported(r.unsupported);
    if (r.error) reportScanError({ chain: chain.name, what: 'history', error: r.error });
    setLoading(false);
  };
  useEffect(() => { setItems(null); load(); }, [chain.id, account.address]);

  const filtered = useMemo(() => {
    let l = (items || []).filter((x) => showSpam || !x.spam);
    if (filter === 'other') l = l.filter((x) => !['send', 'receive', 'swap'].includes(x.kind));
    else if (filter !== 'all') l = l.filter((x) => x.kind === filter);
    return limit ? l.slice(0, limit) : l;
  }, [items, filter, limit, showSpam]);
  const spamCount = (items || []).filter((x) => x.spam).length;

  const groups = useMemo(() => {
    const g = [];
    for (const it of filtered) {
      const label = fmtDateGroup(it.time);
      if (!g.length || g[g.length - 1].label !== label) g.push({ label, items: [] });
      g[g.length - 1].items.push(it);
    }
    return g;
  }, [filtered]);

  return (
    <div class="list">
      {unsupported && <div class="info small" style={{ margin: '0.375rem' }}>{t(chain.indexer?.needsKey ? 'history.unsupported' : 'history.unsupportedNoIndexer', { network: chain.name })}</div>}
      {err && <div class="stale-note" title={err}><Icon name="wifiOff" size={14} /><span class="grow">{t('history.loadFailed')}</span></div>}
      {!items && <div class="empty"><Spinner /></div>}
      {items && !filtered.length && <Empty>{t('history.empty')}</Empty>}
      {groups.map((g) => (
        <>
          <div class="group-title">{g.label}</div>
          {g.items.map((it) => <HistoryItem it={it} onOpen={setOpen} bridge={bridges.get(it.hash.toLowerCase()) || (it.bridgeLike ? { fromChainId: chain.id, status: 'unknown' } : null)} />)}
        </>
      ))}
      {spamCount > 0 && (
        <button class="item small muted" style={{ justifyContent: 'center' }} onClick={() => setShowSpam(!showSpam)}>
          {showSpam ? tn('history.spamHide', spamCount) : tn('history.spamShow', spamCount)}
        </button>
      )}
      {!limit && next && (
        <button class="item" style={{ justifyContent: 'center' }} onClick={() => load(next)} disabled={loading}>
          {loading ? <Spinner /> : <span class="link">{t('history.loadMore')}</span>}
        </button>
      )}
      {open && <Detail it={open} onClose={() => setOpen(null)} nativePrice={nativePrice} bridge={bridges.get(open.hash.toLowerCase()) || (open.bridgeLike ? { fromChainId: chain.id, status: 'unknown' } : null)} />}
    </div>
  );
}

export function History() {
  const { chain, account } = useApp();
  const [filter, setFilter] = useState('all');
  return (
    <div class="screen">
      <TopBar title={t('history.title')} />
      <div class="content">
        <div class="small muted">{account.name} · {chain.name}</div>
        <div class="pills">
          {FILTERS.map(([k, l]) => <button class={`pill ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{t(l)}</button>)}
        </div>
        <div class="card" style={{ padding: '0.375rem' }}>
          <HistoryList filter={filter} />
        </div>
      </div>
    </div>
  );
}
