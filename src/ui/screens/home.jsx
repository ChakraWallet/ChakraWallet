import { useState, useMemo, useEffect } from 'preact/hooks';
import { bg, ext, local } from '../../shared/ext.js';
import { allChains, NATIVE, isChainEnabled } from '../../shared/chains.js';
import { fmtUsd, fmtNum, shortAddr, fmtTime } from '../../shared/format.js';
import { Icon, Avatar, TokenIcon, ChainIcon, ExpandBtn, Sheet, Btn, Spinner, useApp, Empty, Guilloche, useCountUp, cardStyle, richText, usePrivacy, PrivacyBtn } from '../components.jsx';
import { usePortfolio, useChainAddress, useNfts, useNftPrices, useNftVisibility } from '../hooks.js';
import { driverFor, accountFamily, familyOf, isEvmAccount } from '../chains/index.js';
import { usePolyFunds, POLY_CHAIN } from '../polyBalance.js';
import { HistoryList } from './history.jsx';
import { t, tn } from '../../shared/i18n.js';
import { NftSection, AddNftSheet } from './nfts.jsx';
import { useMmCard, MmCardFace, HeroStack, CardActions, CardOps } from './mmcard.jsx';
import { ConnectQrButton } from '../connectQr.jsx';

// the card in front on the home (the balance card or the MetaMask Card): kept while moving between screens
let lastFace = 'wallet';

/**
 * Network list. Without onPick it switches the wallet's network; with onPick (current, onPick) it only picks one.
 * only(chain): which networks to list (e.g. EVM only for the Contracts tab).
 */
export function NetworkSheet({ onClose, current, onPick, only }) {
  const { state, chain, toast, nav, account } = useApp();
  const sel = allChains(state.customChains).find((c) => c.id === (current ?? chain.id)) || chain;
  const [showTest, setShowTest] = useState(!!sel.testnet);
  const chains = allChains(state.customChains).filter((c) => (showTest || !c.testnet) && (isChainEnabled(c.id, state.settings) || c.id === sel.id) && (!only || only(c)));
  const switchTo = async (c) => {
    // an account of one family only (e.g. imported from a TON app) has no address elsewhere: use an account that has one
    const fam = accountFamily(account);
    if (fam !== 'evm' && fam !== familyOf(c)) {
      const other = state.accounts.find(isEvmAccount);
      if (!other) { toast(t('accounts.needEvm'), 'warn'); return; }
      await bg('selectAccount', { address: other.address });
    }
    await bg('setChain', { chainId: c.id }); toast(t('home.network.switched', { name: c.name })); onClose();
  };
  return (
    <Sheet title={t('home.network.title')} onClose={onClose}>
      <div class="list">
        {chains.map((c) => (
          <button class="item" onClick={onPick ? () => { onPick(c.id); onClose(); } : () => switchTo(c)}>
            <ChainIcon chain={c} />
            <div class="grow"><div class="bold">{c.name}</div><div class="small muted">{c.native.symbol}{c.custom ? ` · ${t('home.network.custom')}` : ''}</div></div>
            {c.id === sel.id && <span class="green"><Icon name="check" /></span>}
          </button>
        ))}
      </div>
      <div class="row between">
        <label class="row small muted"><input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} /> {t('home.network.showTest')}</label>
        <button class="link" onClick={() => { onClose(); nav('settings', { section: 'networks' }); }}>{t('home.network.add')}</button>
      </div>
    </Sheet>
  );
}

function AddTokenSheet({ onClose, onAdded }) {
  const { chain, toast } = useApp();
  const [addr, setAddr] = useState('');
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const lookup = async (v) => {
    setAddr(v); setInfo(null); setErr('');
    if (!/^0x[0-9a-fA-F]{40}$/.test(v.trim())) return;
    setLoading(true);
    try { setInfo(await driverFor(chain).tokenInfo(chain, v.trim())); } catch (e) { setErr(e.message); }
    setLoading(false);
  };
  const add = async () => {
    await local.update('customTokens', {}, (all) => ({ ...all, [chain.id]: [...(all[chain.id] || []).filter((t) => t.address !== info.address), info] }));
    await local.update('hiddenTokens', {}, (all) => ({ ...all, [chain.id]: (all[chain.id] || []).filter((a) => a !== info.address) }));
    toast(t('home.addToken.added', { symbol: info.symbol })); onAdded(); onClose();
  };
  return (
    <Sheet title={t('home.addToken.title', { network: chain.name })} onClose={onClose}>
      <div class="field">
        <label>{t('home.addToken.contract')}</label>
        <input class="input mono" placeholder="0x…" value={addr} onInput={(e) => lookup(e.target.value)} autoFocus />
      </div>
      {loading && <Spinner />}
      {info && <div class="card flat row"><TokenIcon symbol={info.symbol} /><div><div class="bold">{info.symbol}</div><div class="small muted">{info.name} · {tn('home.addToken.decimals', info.decimals)}</div></div></div>}
      {err && <div class="error">{err}</div>}
      <Btn disabled={!info} onClick={add}>{t('home.addToken.add')}</Btn>
    </Sheet>
  );
}

/** Polymarket in the token list (Polygon): cash on the Polymarket account + open positions; opens the portfolio. */
function PolyRow({ funds, onOpen }) {
  const { m } = usePrivacy();
  const Tag = onOpen ? 'button' : 'div';
  return (
    <Tag class="item" onClick={onOpen || undefined}>
      <span class="poly-ic"><Icon name="predict" size={20} /></span>
      <div class="grow">
        <div class="bold ellipsis">Polymarket</div>
        <div class="small muted ellipsis">{t('home.poly.sub')}</div>
      </div>
      <div class="right">
        <div class="bold">{m(fmtUsd(funds.total))}</div>
        <div class="small muted">{funds.positions >= 0.01 ? t('home.poly.inPositions', { v: m(fmtUsd(funds.positions)) }) : t('home.poly.cash')}</div>
      </div>
    </Tag>
  );
}

export function Home() {
  const { state, chain, account, nav, refresh, toast, mode, openPredict } = useApp();
  const { m } = usePrivacy();
  const { data, loading, error, reload } = usePortfolio();
  const addr = useChainAddress(); // the account's address on this network (TON: its TON wallet)
  const drv = driverFor(chain);
  const notice = drv.homeNotice?.(chain, data); // e.g. TON: the wallet contract is deployed with its first transfer
  // Polymarket funds of this account: only on Polygon, where they live (the accounts screen shows them on any network)
  const [polyTick, setPolyTick] = useState(0);
  const poly = usePolyFunds(account.address, { enabled: chain.id === POLY_CHAIN, tick: polyTick });
  const reloadAll = () => { reload(); setPolyTick((x) => x + 1); };
  const [tab, setTab] = useState('tokens');
  const [sheet, setSheet] = useState(null);
  const [showUnpriced, setShowUnpriced] = useState(state.settings.showUnpriced);
  const [showHidden, setShowHidden] = useState(false);
  // MetaMask Card (Linea): when the account is linked to one, its card sits behind the balance card
  const card = useMmCard();
  const linked = !!card.data?.linked;
  const [face, setFaceState] = useState(lastFace);
  const setFace = (f) => { lastFace = f; setFaceState(f); };
  const [cardTab, setCardTab] = useState('ops');
  const onCard = linked && face === 'card';
  useEffect(() => { if (card.data && !linked && face !== 'wallet') setFace('wallet'); }, [linked, !!card.data]);

  const priced = data?.tokens.filter((t) => t.price != null || t.custom) || [];
  const unpriced = data?.tokens.filter((t) => t.price == null && !t.custom) || [];

  // NFTs: shown under the tokens; their collections' floor prices count in the total
  const nfts = useNfts(true);
  const nftVisibility = useNftVisibility(); // the user's own show / hide choices, over the automatic spam check
  const nftItems = useMemo(() => nftVisibility.apply(nfts.data?.items), [nfts.data, nftVisibility.apply]);
  const nftValue = useNftPrices(nftItems);
  const shown = useCountUp(data ? (chain.testnet ? data.native.amount : data.totalUsd + (poly?.total || 0) + nftValue.total) : null);
  // the Polymarket row sits among the tokens by value
  const polyAt = poly ? priced.filter((x) => (x.usd ?? 0) >= poly.total).length : -1;


  const nativeToken = { address: NATIVE, symbol: chain.native.symbol, name: chain.native.name, decimals: chain.native.decimals, native: true, balance: data?.native.balance, amount: data?.native.amount, price: data?.native.price, usd: data?.native.usd };

  const TokenRow = ({ t }) => (
    <button class="item" onClick={() => nav('token', { token: t })}>
      <TokenIcon symbol={t.symbol} icon={t.icon} color={t.native ? chain.color : undefined} />
      <div class="grow">
        <div class="bold ellipsis">{t.symbol}</div>
        <div class="small muted ellipsis">{t.price != null ? fmtUsd(t.price) : t.name}</div>
      </div>
      <div class="right">
        <div class="bold">{t.usd != null ? m(fmtUsd(t.usd)) : '—'}</div>
        <div class="small muted">{m(fmtNum(t.amount ?? 0))} {t.symbol}</div>
      </div>
    </button>
  );

  return (
    <div class="screen">
      <div class="topbar">
        <button class="account-btn grow" onClick={() => nav('accounts')}>
          <Avatar address={account.address} />
          <div style={{ textAlign: 'left', minWidth: 0 }}>
            <div class="bold ellipsis" style={{ fontSize: '0.875rem' }}>{account.name}</div>
            <div class="tiny muted ellipsis" style={{ whiteSpace: 'nowrap' }}>{state.wallets.length > 1 ? `${state.wallets.find((w) => w.id === state.activeWallet)?.name} · ` : ''}{addr.address ? shortAddr(addr.address) : chain.name}</div>
          </div>
          <span class="muted"><Icon name="chevron" size={14} /></span>
        </button>
        <button class="chip" title={t('home.network.chip', { name: chain.name })} onClick={() => setSheet('network')}>
          <ChainIcon chain={chain} size={22} /><Icon name="chevron" size={12} />
        </button>
        <ExpandBtn />
        <button class="iconbtn" title={t('home.settings')} onClick={() => nav('settings')}><Icon name="settings" /></button>
        <button class="iconbtn" title={t('home.lock')} onClick={async () => { await bg('lock'); refresh(); }}><Icon name="lock" /></button>
      </div>

      <div class="content">
        {addr.missing && ( // an account without a TON key (e.g. an imported Ethereum private key) on a TON network
          <div class="card col" style={{ gap: '.5rem' }}>
            <b>{t('chain.noKey.title', { network: chain.name })}</b>
            <span class="small muted">{t('chain.noKey.body', { network: chain.name })}</span>
            <Btn kind="secondary" onClick={() => nav('accounts')}>{t('chain.noKey.accounts')}</Btn>
          </div>
        )}
        {!addr.missing && <>
        {state.pending > 0 && (
          <button class="warn row" onClick={() => nav('approvals')}>
            <Icon name="warn" /><span class="grow" style={{ textAlign: 'left' }}>{richText(tn('home.pending', state.pending, { n: '{n}' }), { n: <b>{state.pending}</b> })}</span><Icon name="forward" />
          </button>
        )}

        {(() => {
          const walletHero = (
          <div class="hero" style={cardStyle(account.address)}>
            <Guilloche seed={account.address} draw key={account.address} />
            <div class="row between">
              <span class="label">{t('home.totalBalance', { network: chain.name })}</span>
              <span class="hero-tools"><ConnectQrButton /><PrivacyBtn />
              <button class="iconbtn hero-btn" title={t('home.refresh')} onClick={reloadAll}>
                {loading ? <Spinner /> : <Icon name="refresh" size={15} />}
              </button></span>
            </div>
            <div class="total">{data ? m(chain.testnet ? `${fmtNum(shown)} ${chain.native.symbol}` : fmtUsd(shown)) : <span class="skeleton" style={{ display: 'inline-block', width: '8.75rem', height: '2.25rem', opacity: .3 }} />}</div>
            <div class="row between hero-foot">
              <button class="addr" onClick={async () => { if (!addr.address) return; await navigator.clipboard.writeText(addr.address); toast(t('home.addressCopied')); }}>
                {addr.address ? shortAddr(addr.address, 6) : '…'} <Icon name="copy" size={13} />
              </button>
              {data && <span class="small num" style={{ opacity: .85 }}>{m(fmtNum(data.native.amount))} {chain.native.symbol}</span>}
            </div>
            {linked && <span class="hs-peek"><Icon name="wallet" size={12} /> {t('mmcard.peekWallet')}</span>}
          </div>
          );
          if (!linked) return walletHero;
          return <HeroStack face={face} setFace={setFace} wallet={walletHero} card={<MmCardFace card={card} onRefresh={card.reload} peek={<><Icon name="card" size={12} /> MetaMask Card</>} />} />;
        })()}

        {onCard && <CardActions card={card} />}
        {!onCard && <div class="actions">
          <button class="action" onClick={() => nav('send')}><span class="ic"><Icon name="send" /></span>{t('home.send')}</button>
          <button class="action" onClick={() => nav('receive')}><span class="ic"><Icon name="receive" /></span>{t('home.receive')}</button>
          <button class="action" onClick={() => nav('swap')} disabled={!drv.swapSupported?.(chain)}><span class="ic"><Icon name="swap" /></span>{t('home.swap')}</button>
          <button class="action" onClick={() => nav('bridge')} disabled={chain.testnet}><span class="ic"><Icon name="route" /></span>{t('home.bridge')}</button>
        </div>}

        {notice && <div class="info small">{t(notice)}</div>}

        {onCard && <>
          <div class="tabs">
            <button class={`tab ${cardTab === 'ops' ? 'active' : ''}`} onClick={() => setCardTab('ops')}>{t('mmcard.tabOps')}</button>
            <button class={`tab ${cardTab === 'activity' ? 'active' : ''}`} onClick={() => setCardTab('activity')}>{t('mmcard.tabActivity')}</button>
          </div>
          {cardTab === 'ops' && <CardOps card={card} />}
          {cardTab === 'activity' && (
            <div class="card" style={{ padding: '0.375rem' }}>
              <HistoryList filter="card" emptyText={t('mmcard.noPayments')} />
            </div>
          )}
        </>}

        {!onCard && <>
        <div class="tabs">
          <button class={`tab ${tab === 'tokens' ? 'active' : ''}`} onClick={() => setTab('tokens')}>{t('home.tabTokens')}</button>
          <button class={`tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>{t('home.tabActivity')}</button>
        </div>

        {tab === 'tokens' && (
          <div class="card" style={{ padding: '0.375rem' }}>
            {error && data && (
              <button class="stale-note" onClick={reload}>
                <Icon name="wifiOff" size={14} />
                <span class="grow">{t('home.stale', { time: fmtTime(data.updated) })}</span>
                <span class="link">{t('home.retry')}</span>
              </button>
            )}
            {error && !data && (
              <div class="load-fail">
                <Icon name="wifiOff" size={26} />
                <div class="bold">{navigator.onLine === false ? t('home.offlineTitle') : t('home.failTitle')}</div>
                <div class="small muted">{t('home.failText')}</div>
                <Btn kind="secondary" class="sm" onClick={reload}><Icon name="refresh" size={14} /> {t('home.retry')}</Btn>
              </div>
            )}
            {!data && !error && [1, 2, 3].map(() => <div class="item"><div class="token-icon skeleton" /><div class="grow col"><div class="skeleton" style={{ width: '40%' }} /><div class="skeleton" style={{ width: '25%' }} /></div></div>)}
            {data && (
              <div class="list">
                <TokenRow t={nativeToken} />
                {priced.slice(0, Math.max(0, polyAt)).map((t) => <TokenRow t={t} />)}
                {poly && <PolyRow funds={poly} onOpen={openPredict ? () => openPredict('portfolio') : null} />}
                {priced.slice(Math.max(0, polyAt)).map((t) => <TokenRow t={t} />)}
                {unpriced.length > 0 && (
                  <button class="item small muted" onClick={() => setShowUnpriced(!showUnpriced)} style={{ justifyContent: 'center' }}>
                    {showUnpriced ? tn('home.unpricedHide', unpriced.length) : tn('home.unpricedShow', unpriced.length)}
                  </button>
                )}
                {showUnpriced && unpriced.map((t) => <TokenRow t={t} />)}
                {data.hidden?.length > 0 && ( // tokens the user hid: here to be opened and shown again
                  <button class="item small muted" onClick={() => setShowHidden(!showHidden)} style={{ justifyContent: 'center' }}>
                    {showHidden ? t('home.hiddenTokensHide') : tn('home.hiddenTokensShow', data.hidden.length)}
                  </button>
                )}
                {showHidden && data.hidden?.map((t) => <TokenRow t={t} />)}
              </div>
            )}
            {data?.noIndexer && <div class="tiny muted" style={{ padding: '0.375rem' }}>{t(chain.indexer?.needsKey ? 'home.noIndexerKey' : 'home.noIndexer', { network: chain.name })}{chain.indexer?.needsKey && <> <button class="link tiny" onClick={() => nav('settings', { section: 'keys', focus: 'etherscanKey' })}>{t('keys.addKey')}</button></>}</div>}
            {drv.features.customTokens && <button class="item" style={{ justifyContent: 'center' }} onClick={() => setSheet('token')}><span class="link">{t('home.addCustomToken')}</span></button>}
          </div>
        )}
        {tab === 'tokens' && data && <NftSection items={nftItems} priceOf={nftValue.priceOf} onAdd={drv.features.customTokens ? () => setSheet('nft') : null} />}

        {tab === 'activity' && (
          <div class="card" style={{ padding: '0.375rem' }}>
            <HistoryList limit={8} />
            <button class="item" style={{ justifyContent: 'center' }} onClick={() => nav('history')}><span class="link">{t('home.seeAllHistory')}</span></button>
          </div>
        )}
        </>}
        {data?.stale && loading && <div class="tiny muted center">{t('home.updating')}</div>}
        {!data && !error && !loading && <Empty>{t('home.noData')}</Empty>}
        </>}
      </div>

      {sheet === 'network' && <NetworkSheet onClose={() => setSheet(null)} />}
      {sheet === 'token' && <AddTokenSheet onClose={() => setSheet(null)} onAdded={reload} />}
      {sheet === 'nft' && <AddNftSheet onClose={() => setSheet(null)} onAdded={nfts.reload} />}
    </div>
  );
}
