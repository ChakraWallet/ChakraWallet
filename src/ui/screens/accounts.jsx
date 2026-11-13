import { useState } from 'preact/hooks';
import { bg } from '../../shared/ext.js';
import { shortAddr, fmtNum, fmtUsd } from '../../shared/format.js';
import { TopBar, Avatar, Icon, Btn, Sheet, QR, CopyBtn, useApp, explorerAddr, TokenIcon, Spinner, SecureScreen, ChainIcon, WalletMark } from '../components.jsx';
import { useMultichainPortfolios, summarize } from '../hooks.js';
import { t, tn } from '../../shared/i18n.js';
import { VanityAccount } from './vanity.jsx';
import { usePolyFundsMany, POLY_COLOR } from '../polyBalance.js';

const TYPE = { hd: 'accounts.type.hd', imported: 'accounts.type.imported', generated: 'accounts.type.generated', ton: 'accounts.type.ton' };

const TonImport = (p) => { const C = globalThis.__CK_TON__?.ImportTon; return C ? <C {...p} /> : null; };
/** TON balances for the summary (Android app); the same answer every render, so the hooks keep their order. */
const useTonSummaries = () => { const h = globalThis.__CK_TON__?.useSummaries; return h ? h() : null; };
const shownAddress = (a) => (a.type === 'ton' ? globalThis.__CK_TON__?.friendly(a.address) || a.address : a.address);

function AddSheet({ onClose }) {
  const { refresh, toast, back, state } = useApp();
  const wallet = state.wallets.find((w) => w.id === state.activeWallet);
  const [mode, setMode] = useState(null);
  const [name, setName] = useState('');
  const [pk, setPk] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const go = async (m) => {
    setLoading(true); setErr('');
    try {
      const acc = await bg('addAccount', { mode: m, name: name.trim() || undefined, privateKey: pk });
      await refresh(); toast(t('accounts.created', { name: acc.name })); onClose(); back();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };
  if (mode === 'vanity') {
    return (
      <Sheet title={t('vanity.title')} onClose={onClose}>
        <VanityAccount onBack={() => setMode(null)} onCreated={async (acc) => { await refresh(); toast(t('accounts.created', { name: acc.name })); onClose(); back(); }} />
      </Sheet>
    );
  }
  return (
    <Sheet title={t('accounts.add.title', { name: wallet?.name })} onClose={onClose}>
      {!mode && (
        <div class="list">
          {wallet?.hasSeed && <button class="item" onClick={() => setMode('hd')}><div class="tx-icon" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}><Icon name="plus" /></div>
            <div><div class="bold">{t('accounts.add.hd')}</div><div class="small muted">{t('accounts.add.hd.sub')}</div></div></button>}
          <button class="item" onClick={() => setMode('random')}><div class="tx-icon" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}><Icon name="key" /></div>
            <div><div class="bold">{t('accounts.add.random')}</div><div class="small muted">{t('accounts.add.random.sub')}</div></div></button>
          <button class="item" onClick={() => setMode('vanity')}><div class="tx-icon" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}><Icon name="sparkle" /></div>
            <div><div class="bold">{t('accounts.add.vanity')}</div><div class="small muted">{t('accounts.add.vanity.sub')}</div></div></button>
          <button class="item" onClick={() => setMode('import')}><div class="tx-icon" style={{ background: 'var(--amber-soft)', color: 'var(--amber)' }}><Icon name="receive" /></div>
            <div><div class="bold">{t('accounts.add.import')}</div><div class="small muted">{t('accounts.add.import.sub')}</div></div></button>
          {globalThis.__CK_TON__ && ( // Android: a wallet from another TON app
            <button class="item" onClick={() => setMode('ton')}><div class="tx-icon" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}><Icon name="wallet" /></div>
              <div><div class="bold">{t('accounts.add.ton')}</div><div class="small muted">{t('accounts.add.ton.sub')}</div></div></button>
          )}
        </div>
      )}
      {mode === 'ton' && <TonImport onBack={() => setMode(null)} onDone={(acc) => { toast(t('accounts.created', { name: acc.name })); onClose(); back(); }} />}
      {mode && mode !== 'ton' && (
        <>
          <div class="field"><label>{t('common.nameOptional')}</label><input class="input" value={name} onInput={(e) => setName(e.target.value)} placeholder={t('accounts.add.namePlaceholder')} /></div>
          {mode === 'import' && <div class="field"><label>{t('accounts.privateKey')}</label><input class="input mono" type="password" value={pk} onInput={(e) => setPk(e.target.value)} placeholder="0x…" /></div>}
          {mode === 'random' && <div class="warn small">{t('accounts.add.randomWarn')}</div>}
          {err && <div class="error">{err}</div>}
          <div class="row"><Btn kind="secondary" class="grow" onClick={() => setMode(null)}>{t('common.back')}</Btn><Btn class="grow" loading={loading} disabled={mode === 'import' && !pk} onClick={() => go(mode)}>{t('common.create')}</Btn></div>
        </>
      )}
    </Sheet>
  );
}

/** Token/coin icon with the small badge of its network */
function HoldingIcon({ h, sm }) {
  return (
    <span class="hold-ic">
      <TokenIcon sm={sm} symbol={h.symbol} icon={h.icon} color={h.native ? h.chain.color : undefined} />
      <span class="hold-net"><ChainIcon chain={h.chain} size={sm ? 11 : 14} /></span>
    </span>
  );
}

const valueOf = (x) => (x.usd != null ? fmtUsd(x.usd) : '');

function AccountCard({ a, sum, poly, selected, showUnpriced, onSelect, onChain, onPoly, onDetails }) {
  const [open, setOpen] = useState(false);
  const top = sum.holdings.slice(0, 3);
  const rest = sum.holdings.slice(3);
  const loading = sum.loaded < sum.total || sum.pending > 0;
  return (
    <div class={`acc-card mc ${selected ? 'sel' : ''}`}>
      <button class="row acc-head" onClick={onSelect}>
        <Avatar address={a.address} />
        <div class="grow" style={{ minWidth: 0 }}>
          <div class="bold ellipsis">{a.name}</div>
          <div class="tiny muted">{shortAddr(shownAddress(a))} · {t(TYPE_SHORT[a.type])}</div>
        </div>
        <div class="right">
          <div class="acc-total">{sum.loaded ? fmtUsd(sum.usd + (poly?.total || 0)) : <span class="skeleton" style={{ display: 'inline-block', width: '4rem' }} />}</div>
          {loading && <div class="tiny muted row" style={{ justifyContent: 'flex-end', gap: '0.25rem' }}><Spinner />{t('accounts.mc.checking', { done: sum.total - sum.pending, total: sum.total })}</div>}
        </div>
      </button>

      {(sum.nets.length > 0 || poly) && (
        <div class="chain-chips">
          {sum.nets.map((n) => (
            <button class="chain-chip" onClick={() => onChain(n.chain)} title={t('accounts.mc.openOn', { chain: n.chain.name })}>
              <ChainIcon chain={n.chain} size={16} />
              <span>{n.usd >= 0.01 ? fmtUsd(n.usd) : `${fmtNum(n.native.amount)} ${n.native.symbol}`}</span>
            </button>
          ))}
          {/* funds on Polymarket: here on any network, so an account's forgotten Polymarket balance shows up */}
          {poly && (onPoly ? (
            <button class="chain-chip" onClick={onPoly} title={t('accounts.mc.polymarket')}>
              <span class="poly-ic sm"><Icon name="predict" size={11} /></span><span>{fmtUsd(poly.total)}</span>
            </button>
          ) : ( // browser extension: no Predictions to open
            <span class="chain-chip" title="Polymarket"><span class="poly-ic sm"><Icon name="predict" size={11} /></span><span>{fmtUsd(poly.total)}</span></span>
          ))}
        </div>
      )}
      {!loading && !sum.nets.length && !poly && <div class="small muted acc-empty">{t('accounts.mc.noFunds')}</div>}

      {top.length > 0 && (
        <div class="acc-bal">
          {top.map((h) => (
            <div class="acc-line">
              <HoldingIcon h={h} sm />
              <span class="bold ellipsis">{fmtNum(h.amount)} {h.symbol}</span>
              <span class="spacer" />
              <span class="muted">{valueOf(h)}</span>
            </div>
          ))}
          {(rest.length > 0 || (showUnpriced && sum.unpriced > 0)) && (
            <div class="acc-line muted small">
              {rest.length > 0 && <span>{tn('accounts.mc.more', rest.length)}</span>}
              {showUnpriced && sum.unpriced > 0 && <span>{rest.length > 0 ? ' · ' : ''}{tn('accounts.mc.unpriced', sum.unpriced)}</span>}
            </div>
          )}
        </div>
      )}

      <div class="acc-foot">
        {sum.nets.length > 0 && (
          <button class="link small row" onClick={() => setOpen(!open)} style={{ gap: '0.25rem' }}>
            {open ? t('accounts.mc.hideDetails') : t('accounts.mc.details')}
            <span class={`chev ${open ? 'up' : ''}`}><Icon name="chevron" size={14} /></span>
          </button>
        )}
        <span class="spacer" />
        <button class="iconbtn" title={t('accounts.detailsQr')} onClick={onDetails}><Icon name="qr" size={16} /></button>
      </div>

      {open && (
        <div class="net-details">
          {sum.nets.map((n) => (
            <div class="net-block">
              <button class="net-head" onClick={() => onChain(n.chain)}>
                <ChainIcon chain={n.chain} size={18} />
                <span class="bold grow ellipsis">{n.chain.name}</span>
                <span class="bold">{n.usd >= 0.01 ? fmtUsd(n.usd) : ''}</span>
                <Icon name="forward" size={14} />
              </button>
              {[...(n.native.amount > 0 ? [n.native] : []), ...n.priced, ...(showUnpriced ? n.noPrice : [])].map((h) => (
                <div class={`acc-line ${h.unpriced ? 'muted' : ''}`}>
                  <TokenIcon sm symbol={h.symbol} icon={h.icon} color={h.native ? n.chain.color : undefined} />
                  <span class="ellipsis">{fmtNum(h.amount)} {h.symbol}</span>
                  <span class="spacer" />
                  <span class="muted">{h.unpriced ? t('accounts.mc.noPrice') : valueOf(h)}</span>
                </div>
              ))}
              {n.chain.indexer?.needsKey && <div class="tiny muted">{t('accounts.mc.needsKey')}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TYPE_SHORT = { hd: 'accounts.short.hd', imported: 'accounts.short.imported', generated: 'accounts.short.generated', ton: 'accounts.short.ton' }; // i18n keys

export function Accounts() {
  const { state, nav, back, refresh, reset, openPredict } = useApp();
  const [add, setAdd] = useState(false);
  const { chains, get, busy, reload } = useMultichainPortfolios();
  const [polyTick, setPolyTick] = useState(0);
  const polys = usePolyFundsMany(state.accounts.filter((a) => a.type !== 'ton').map((a) => a.address), polyTick);
  const showUnpriced = !!state.settings.showUnpriced;
  const ton = useTonSummaries(); // TON next to the EVM networks, when the account has a TON address
  const perOf = (a) => [...(a.type === 'ton' ? [] : get(a.address)), ...(ton?.per[a.address] ? [ton.per[a.address]] : [])];
  const sums = state.accounts.map((a) => summarize(perOf(a), showUnpriced));
  const polyTotal = state.accounts.reduce((s, a) => s + (polys[a.address]?.total || 0), 0);
  const total = sums.reduce((s, x) => s + x.usd, 0) + polyTotal;
  // wallet total per network, for the bar (Polymarket as one more segment)
  const byChain = new Map();
  for (const sm of sums) for (const n of sm.nets) byChain.set(n.chain.id, { chain: n.chain, usd: (byChain.get(n.chain.id)?.usd || 0) + n.usd });
  const segs = [...byChain.values(), { chain: { id: 'polymarket', name: 'Polymarket', color: POLY_COLOR }, usd: polyTotal }].filter((x) => x.usd > 0).sort((a, b) => b.usd - a.usd);
  const fundedNets = byChain.size;
  const anyLoaded = sums.some((x) => x.loaded);

  const select = async (a) => { await bg('selectAccount', { address: a.address }); await refresh(); back(); };
  const openPoly = async (a) => {
    await bg('selectAccount', { address: a.address });
    await refresh();
    reset('home');
    openPredict('portfolio');
  };
  const openOn = async (a, c) => {
    await bg('selectAccount', { address: a.address });
    await bg('setChain', { chainId: c.id });
    await refresh();
    reset('home');
  };

  return (
    <div class="screen">
      <TopBar title={t('accounts.title')} right={<>
        <button class="iconbtn" title={t('accounts.refresh')} onClick={() => { reload(); ton?.reload(); setPolyTick((x) => x + 1); }}>{busy || ton?.busy ? <Spinner /> : <Icon name="refresh" />}</button>
        <button class="iconbtn" title={t('common.add')} onClick={() => setAdd(true)}><Icon name="plus" /></button>
      </>} />
      <div class="content">
        <button class="card row between" style={{ textAlign: 'left' }} onClick={() => nav('wallets')}>
          <div class="row" style={{ minWidth: 0 }}>
            <WalletMark id={state.activeWallet} />
            <div style={{ minWidth: 0 }}><div class="tiny muted">{t('accounts.activeWallet')}</div><div class="bold ellipsis">{state.wallets.find((w) => w.id === state.activeWallet)?.name}</div></div>
          </div>
          <span class="small muted row">{state.wallets.length > 1 ? tn('accounts.walletCount', state.wallets.length) : t('accounts.manage')}<Icon name="forward" size={14} /></span>
        </button>

        <div class="card mc-summary">
          <div class="row between">
            <div>
              <div class="small muted">{t('accounts.mc.total')}</div>
              <div class="mc-total">{anyLoaded ? fmtUsd(total) : <span class="skeleton" style={{ display: 'inline-block', width: '7rem', height: '1.75rem' }} />}</div>
            </div>
            <div class="right small muted">
              {tn('accounts.count', state.accounts.length)}
              <div>{tn('accounts.mc.fundsOn', fundedNets)}</div>
            </div>
          </div>
          {segs.length > 0 && (
            <>
              <div class="mc-bar">{segs.map((x) => <span style={{ flexGrow: x.usd, background: x.chain.color }} title={x.chain.name} />)}</div>
              <div class="mc-legend">
                {segs.slice(0, 5).map((x) => <span class="row"><span class="dot" style={{ background: x.chain.color }} />{x.chain.name} <b>{Math.round((x.usd / total) * 100)}%</b></span>)}
              </div>
            </>
          )}
        </div>

        <div class="col" style={{ gap: '0.5rem' }}>
          {state.accounts.map((a, i) => (
            <AccountCard a={a} sum={sums[i]} poly={polys[a.address]} selected={a.address === state.selected} showUnpriced={showUnpriced}
              onSelect={() => select(a)} onChain={(c) => openOn(a, c)} onPoly={openPredict && a.type !== 'ton' ? () => openPoly(a) : null} onDetails={() => nav('account', { address: a.address })} />
          ))}
        </div>
        <div class="tiny muted center">{tn('accounts.mc.footer', chains.length + (ton ? 1 : 0))}</div>
        <Btn kind="secondary" onClick={() => setAdd(true)}><Icon name="plus" /> {t('accounts.add')}</Btn>
      </div>
      {add && <AddSheet onClose={() => setAdd(false)} />}
    </div>
  );
}

export function AccountDetails({ address }) {
  const { state, chain, refresh, toast, back } = useApp();
  const acc = state.accounts.find((a) => a.address === address);
  const [name, setName] = useState(acc?.name || '');
  const [sheet, setSheet] = useState(null);
  const [pw, setPw] = useState('');
  const [pk, setPk] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  if (!acc) return null;
  const isTon = acc.type === 'ton';
  const shown = isTon ? globalThis.__CK_TON__?.friendly(address) || address : address; // TON accounts: UQ… address

  const reveal = async () => {
    setLoading(true); setErr('');
    try { setPk(await bg('exportPrivateKey', { address, password: pw })); } catch (e) { setErr(e.message); }
    setLoading(false);
  };
  const remove = async () => {
    setLoading(true); setErr('');
    try { await bg('removeAccount', { address, password: pw }); await refresh(); toast(t('accounts.removed')); back(); } catch (e) { setErr(e.message); setLoading(false); }
  };
  const closeSheet = () => { setSheet(null); setPk(''); setPw(''); setErr(''); };

  return (
    <div class="screen">
      <TopBar title={t('accounts.details')} />
      <div class="content" style={{ alignItems: 'center', textAlign: 'center' }}>
        <Avatar address={address} lg />
        <div class="row" style={{ width: '100%' }}>
          <input class="input" value={name} onInput={(e) => setName(e.target.value)} style={{ textAlign: 'center', fontWeight: 650 }} />
          {name !== acc.name && name.trim() && <Btn class="sm" onClick={async () => { await bg('renameAccount', { address, name: name.trim() }); await refresh(); toast(t('common.nameUpdated')); }}>{t('common.save')}</Btn>}
        </div>
        <span class="badge">{t(TYPE[acc.type])}{acc.type === 'hd' ? ` · m/44'/60'/0'/0/${acc.index}` : ''}</span>
        <div class="small muted">{t(isTon ? 'accounts.tonAddress' : 'accounts.publicKey')}</div>
        <QR text={shown} size={180} />
        <div class="mono">{shown}</div>
        <div class="row">
          <CopyBtn text={shown} label={t('common.copy')} />
          {!isTon && explorerAddr(chain, address) && <a class="btn secondary sm" href={explorerAddr(chain, address)} target="_blank"><Icon name="external" size={14} /> {t('common.explorer')}</a>}
        </div>
        <Btn kind="secondary" class="block" onClick={() => setSheet('pk')}><Icon name="key" /> {t('accounts.showPk')}</Btn>
        <button class="btn ghost red" onClick={() => setSheet('remove')}><Icon name="trash" size={16} /> {t('accounts.removeAccount')}</button>
      </div>

      {sheet === 'pk' && (
        <Sheet title={t('accounts.privateKey')} onClose={closeSheet}>
          {!pk ? (
            <>
              <div class="error small"><b>{t('accounts.pk.warnBold')}</b> {t('accounts.pk.warn')}</div>
              <div class="field"><label>{t('common.confirmWithPassword')}</label><input class="input" type="password" value={pw} onInput={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && reveal()} autoFocus /></div>
              {err && <div class="error">{err}</div>}
              <Btn loading={loading} disabled={!pw} onClick={reveal}>{t('common.show')}</Btn>
            </>
          ) : (
            <div class="col" style={{ alignItems: 'center', gap: '0.625rem', textAlign: 'center' }}>
              <SecureScreen />
              <QR text={pk} size={180} />
              <div class="card flat mono" style={{ width: '100%' }}>{pk}</div>
              <CopyBtn text={pk} label={t('accounts.pk.copy')} />
              <div class="warn small">{t('accounts.pk.closeWhenDone')}</div>
            </div>
          )}
        </Sheet>
      )}
      {sheet === 'remove' && (
        <Sheet title={t('accounts.remove.title')} onClose={closeSheet}>
          <div class="warn small">
            {t('accounts.remove.body')}
            {' '}{acc.type === 'hd' ? t('accounts.remove.hd') : t('accounts.remove.key')}
          </div>
          <div class="field"><label>{t('common.confirmWithPassword')}</label><input class="input" type="password" value={pw} onInput={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && remove()} autoFocus /></div>
          {err && <div class="error">{err}</div>}
          <div class="row"><Btn kind="secondary" class="grow" onClick={closeSheet}>{t('common.cancel')}</Btn><Btn kind="danger" class="grow" loading={loading} disabled={!pw} onClick={remove}>{t('common.remove')}</Btn></div>
        </Sheet>
      )}
    </div>
  );
}
