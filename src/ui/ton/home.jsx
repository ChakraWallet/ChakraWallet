// TON wallet home (Android app): the account's card with the total, actions, GRAM + jettons, latest activity.
// Same layout as the EVM home; the TON address is the selected account's (from its recovery phrase, or a TON account).
import { useState } from 'preact/hooks';
import { bg } from '../../shared/ext.js';
import { fmtUsd, fmtNum, shortAddr, fmtTime, fmtDateGroup } from '../../shared/format.js';
import { Icon, Avatar, TokenIcon, ChainIcon, Spinner, Btn, useApp, Guilloche, useCountUp, cardStyle } from '../components.jsx';
import { NetworkSheet } from '../screens/home.jsx';
import { t } from '../../shared/i18n.js';
import { useTonWallet, useTonPortfolio, useTonHistory } from './hooks.js';
import { TonTxDetail, tonTitle } from './detail.jsx';

export const units = (raw, decimals) => Number(raw) / 10 ** decimals;
const short = (a) => (a && a.length > 20 ? shortAddr(a, 4) : a || '—');

export function TonTopBar() {
  const { state, account, nav, refresh, chain } = useApp();
  const [sheet, setSheet] = useState(false);
  return (
    <div class="topbar">
      <button class="account-btn grow" onClick={() => nav('accounts')}>
        <Avatar address={account.address} />
        <div style={{ textAlign: 'left', minWidth: 0 }}>
          <div class="bold ellipsis" style={{ fontSize: '0.875rem' }}>{account.name}</div>
          <div class="tiny muted ellipsis" style={{ whiteSpace: 'nowrap' }}>{state.wallets.length > 1 ? `${state.wallets.find((w) => w.id === state.activeWallet)?.name} · ` : ''}{chain.name}</div>
        </div>
        <span class="muted"><Icon name="chevron" size={14} /></span>
      </button>
      <button class="chip" title={t('home.network.chip', { name: chain.name })} onClick={() => setSheet(true)}>
        <ChainIcon chain={chain} size={22} /><Icon name="chevron" size={12} />
      </button>
      <button class="iconbtn" title={t('home.settings')} onClick={() => nav('settings')}><Icon name="settings" /></button>
      <button class="iconbtn" title={t('home.lock')} onClick={async () => { await bg('lock'); refresh(); }}><Icon name="lock" /></button>
      {sheet && <NetworkSheet onClose={() => setSheet(false)} />}
    </div>
  );
}

/** One line of TON history. */
export function TonActivityRow({ r, chain, onOpen }) {
  const amt = (x) => `${fmtNum(units(x.amount, x.decimals))} ${x.symbol}`;
  const glyph = r.kind === 'swap'
    ? <span class="glyph pair"><TokenIcon symbol={r.swap.in.symbol} icon={r.swap.in.image} /><TokenIcon symbol={r.swap.out.symbol} icon={r.swap.out.image} /></span>
    : r.kind === 'other' ? <div class="tx-icon round" style={{ background: 'var(--card-2)', color: 'var(--muted)' }}><Icon name="contract" size={18} /></div>
      : <span class="glyph"><TokenIcon symbol={r.symbol} icon={r.image} color={r.symbol === chain.native.symbol ? chain.color : undefined} /><span class={`dir-badge ${r.kind === 'out' ? 'send' : 'receive'}`}><Icon name={r.kind === 'out' ? 'send' : 'receive'} size={10} stroke={3} /></span></span>;
  return (
    <button class="item hist-item" onClick={() => onOpen(r)}>
      {glyph}
      <div class="grow" style={{ minWidth: 0 }}>
        <div class="bold ellipsis">{tonTitle(r)}</div>
        <div class="small muted ellipsis hist-sub">{fmtTime(r.time)}{r.counterparty && r.kind !== 'swap' ? ` · ${short(r.counterparty)}` : ''}{r.comment ? ` · “${r.comment}”` : ''}</div>
      </div>
      <div class="right hist-amts">
        {r.kind === 'swap' && <><div class="small bold muted ellipsis">−{amt(r.swap.in)}</div><div class="small bold green ellipsis">+{amt(r.swap.out)}</div></>}
        {r.kind === 'out' && <div class="small bold ellipsis">−{amt(r)}</div>}
        {r.kind === 'in' && <div class="small bold green ellipsis">+{amt(r)}</div>}
        {!r.ok && <span class="badge red">{t('history.failed')}</span>}
        {r.spam && <span class="badge red">{t('history.spam')}</span>}
      </div>
    </button>
  );
}

/** History grouped by day; spam (small incoming transfers with ads) hidden behind a toggle. */
export function TonActivity({ chain, raw, limit = 20 }) {
  const h = useTonHistory(chain, raw, limit);
  const [spam, setSpam] = useState(false);
  const [open, setOpen] = useState(null);
  if (!h.rows) return <div class="card" style={{ padding: '1rem', display: 'flex', justifyContent: 'center' }}><Spinner /></div>;
  const list = h.rows.filter((r) => spam || !r.spam);
  const hidden = h.rows.length - h.rows.filter((r) => !r.spam).length;
  let day = '';
  return (
    <div class="card" style={{ padding: '0.375rem' }}>
      {h.error && <div class="error small">{t('ton.loadError')}</div>}
      {!list.length && !h.error && <div class="empty">{t('ton.hist.empty')}</div>}
      {list.map((r) => {
        const d = fmtDateGroup(r.time);
        const head = d !== day ? (day = d, <div class="group-title">{d}</div>) : null;
        return <>{head}<TonActivityRow r={r} chain={chain} onOpen={setOpen} /></>;
      })}
      <div class="row between" style={{ padding: '0.375rem' }}>
        {hidden > 0 ? <button class="link tiny" onClick={() => setSpam(!spam)}>{spam ? t('ton.hist.hideSpam') : t('ton.hist.showSpam', { n: hidden })}</button> : <span />}
        {h.more && <button class="link tiny" disabled={h.busy} onClick={h.more}>{h.busy ? <Spinner /> : t('ton.hist.more')}</button>}
      </div>
      {open && <TonTxDetail r={open} chain={chain} wallet={raw} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function TonHome() {
  const { state, chain, account, nav, toast } = useApp();
  const w = useTonWallet();
  const { data, loading, error, reload } = useTonPortfolio(chain, w?.raw);
  const [tab, setTab] = useState('tokens');
  const [hiddenOpen, setHiddenOpen] = useState(state.settings.showUnpriced);
  const shown = useCountUp(data ? (chain.testnet ? data.gram.amount : data.totalUsd) : null);
  const priced = data?.jettons.filter((j) => j.price != null) || [];
  const unpriced = data?.jettons.filter((j) => j.price == null) || [];

  if (w === null) {
    return (
      <div class="screen">
        <TonTopBar />
        <div class="content">
          <div class="card col" style={{ gap: '.5rem' }}>
            <b>{t('ton.noKey.title')}</b>
            <span class="small muted">{t('ton.noKey.body')}</span>
            <Btn kind="secondary" onClick={() => nav('accounts')}>{t('ton.noKey.accounts')}</Btn>
          </div>
        </div>
      </div>
    );
  }

  const Row = ({ j }) => (
    <button class="item" onClick={() => nav('token', { jetton: j.master })}>
      <TokenIcon symbol={j.symbol} icon={j.image} />
      <div class="grow">
        <div class="bold ellipsis">{j.symbol}</div>
        <div class="small muted ellipsis">{j.price != null ? fmtUsd(j.price) : j.name}</div>
      </div>
      <div class="right">
        <div class="bold">{j.usd != null ? fmtUsd(j.usd) : '—'}</div>
        <div class="small muted">{fmtNum(j.amount)} {j.symbol}</div>
      </div>
    </button>
  );

  return (
    <div class="screen">
      <TonTopBar />
      <div class="content">
        <div class="hero" style={cardStyle(account.address)}>
          <Guilloche seed={account.address} draw key={account.address} />
          <div class="row between">
            <span class="label">{t('home.totalBalance', { network: chain.name })}</span>
            <button class="iconbtn hero-btn" title={t('home.refresh')} onClick={reload}>{loading ? <Spinner /> : <Icon name="refresh" size={15} />}</button>
          </div>
          <div class="total">{data ? (chain.testnet ? `${fmtNum(shown)} ${chain.native.symbol}` : fmtUsd(shown)) : <span class="skeleton" style={{ display: 'inline-block', width: '8.75rem', height: '2.25rem', opacity: .3 }} />}</div>
          <div class="row between hero-foot">
            <button class="addr" onClick={async () => { if (!w) return; await navigator.clipboard.writeText(w.address); toast(t('home.addressCopied')); }}>
              {w ? shortAddr(w.address, 6) : '…'} <Icon name="copy" size={13} />
            </button>
            {data && <span class="small num" style={{ opacity: .85 }}>{fmtNum(data.gram.amount)} {chain.native.symbol}</span>}
          </div>
        </div>

        <div class="actions">
          <button class="action" onClick={() => nav('send')}><span class="ic"><Icon name="send" /></span>{t('home.send')}</button>
          <button class="action" onClick={() => nav('receive')}><span class="ic"><Icon name="receive" /></span>{t('home.receive')}</button>
          <button class="action" onClick={() => nav('swap')} disabled={chain.testnet}><span class="ic"><Icon name="swap" /></span>{t('home.swap')}</button>
          <button class="action" onClick={() => nav('bridge')} disabled={chain.testnet}><span class="ic"><Icon name="route" /></span>{t('home.bridge')}</button>
        </div>

        {data && data.status !== 'active' && data.gram.balance > 0n && <div class="info small">{t('ton.notDeployed')}</div>}

        <div class="tabs">
          <button class={`tab ${tab === 'tokens' ? 'active' : ''}`} onClick={() => setTab('tokens')}>{t('home.tabTokens')}</button>
          <button class={`tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>{t('home.tabActivity')}</button>
        </div>

        {tab === 'tokens' && (
          <div class="card" style={{ padding: '0.375rem' }}>
            {error && !data && <div class="error small">{t('ton.loadError')} <button class="link" onClick={reload}>{t('home.retry')}</button></div>}
            {!data && !error && <div style={{ padding: '1rem', display: 'flex', justifyContent: 'center' }}><Spinner /></div>}
            {data && (
              <>
                <button class="item" onClick={() => nav('token', { jetton: null })}>
                  <TokenIcon symbol={chain.native.symbol} color={chain.color} />
                  <div class="grow"><div class="bold">{chain.native.symbol}</div><div class="small muted">{data.gram.price != null ? fmtUsd(data.gram.price) : chain.native.name}</div></div>
                  <div class="right"><div class="bold">{data.gram.usd != null ? fmtUsd(data.gram.usd) : '—'}</div><div class="small muted">{fmtNum(data.gram.amount)} {chain.native.symbol}</div></div>
                </button>
                {priced.map((j) => <Row j={j} />)}
                {unpriced.length > 0 && <button class="link tiny" style={{ padding: '0.5rem' }} onClick={() => setHiddenOpen(!hiddenOpen)}>{hiddenOpen ? t('ton.hideUnpriced') : t('ton.showUnpriced', { n: unpriced.length })}</button>}
                {hiddenOpen && unpriced.map((j) => <Row j={j} />)}
              </>
            )}
          </div>
        )}
        {tab === 'activity' && w && <TonActivity chain={chain} raw={w.raw} />}
      </div>
    </div>
  );
}

export function TonHistory() {
  const { chain } = useApp();
  const w = useTonWallet();
  return (
    <div class="screen">
      <div class="topbar"><BackBtn /><h1>{t('ton.hist.title')}</h1></div>
      <div class="content">{w ? <TonActivity chain={chain} raw={w.raw} limit={40} /> : <Spinner />}</div>
    </div>
  );
}

export function BackBtn() {
  const { back } = useApp();
  return <button class="iconbtn" onClick={back} title={t('common.back')}><Icon name="back" /></button>;
}
