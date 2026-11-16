// NFTs of the account on the current network: a small gallery under the tokens on the home screen, and a page of
// their own for each piece (artwork first, then its label: collection, title, description, traits, details), so an
// NFT reads as a work, not as a row in a list. Possible spam is hidden behind a toggle and its images are never
// loaded (an image link is a way to learn who opened it). Values: the floor price of the collection
// (src/shared/nftPrices.js), on a price tag in the gallery, under the title on the page, and over time in a chart.
import { useState, useEffect, useMemo } from 'preact/hooks';
import { Icon, ChainIcon, Avatar, Guilloche, Btn, cardStyle, useApp } from '../components.jsx';
import { LineChart } from '../chart.jsx';
import { driverFor } from '../chains/index.js';
import { bg } from '../../shared/ext.js';
import { shortAddr, fmtNum, fmtUsd, fmtUsdShort } from '../../shared/format.js';
import { nftFloor, nftSales, floorLog, salesSource } from '../../shared/nftPrices.js';
import { t, tn } from '../../shared/i18n.js';

const FIRST = 6;

/**
 * The artwork: the image, or (none, failed, spam) a guilloche drawn from the NFT's own key, in the app's style.
 * glow: a blurred copy behind it, the piece's own colours as its shadow.
 */
function Art({ nft, glow = false, onLoad, onClick }) {
  const [failed, setFailed] = useState(false);
  const src = !nft.spam && !failed ? nft.image : null;
  return (
    <span class={`nft-art ${src ? '' : 'ph'}`} onClick={onClick}>
      {src && glow && <img class="nft-glow" src={src} alt="" aria-hidden="true" referrerpolicy="no-referrer" />}
      {src
        ? <img class="nft-img" src={src} alt={nft.name} loading="lazy" decoding="async" referrerpolicy="no-referrer" onError={() => setFailed(true)} onLoad={onLoad} />
        : <span class="nft-ph" style={cardStyle(nft.key)}><Guilloche seed={nft.key} /></span>}
    </span>
  );
}

/** The floor price, short: on the tag (USD when known, else in the collection's currency). */
const shortPrice = (p) => (p?.usd != null ? fmtUsdShort(p.usd) : p?.native ? `${fmtNum(p.native, 3)} ${p.symbol}` : null);

/** items: the NFTs (useNfts); priceOf(nft): their collection's floor price (useNftPrices). */
export function NftSection({ items: all0, priceOf }) {
  const { nav } = useApp();
  const [all, setAll] = useState(false);
  const [showSpam, setShowSpam] = useState(false);
  const items = all0 || [];
  const good = items.filter((x) => !x.spam), spam = items.filter((x) => x.spam);
  if (!good.length && !spam.length) return null;
  const shown = all ? good : good.slice(0, FIRST);
  const open = (nft) => nav('nft', { nft, price: priceOf?.(nft) ?? null });
  return (
    <section class="nft-section">
      <div class="nft-head">
        <span class="section-title">{t('nft.title')}</span>
        <span class="nft-count">{good.length}</span>
      </div>
      {shown.length > 0 && (
        <div class="nft-grid">
          {shown.map((n, i) => (
            <button class="nft-tile" style={{ '--i': i }} onClick={() => open(n)} aria-label={n.name}>
              <span class="nft-art-wrap">
                <Art nft={n} glow />
                {shortPrice(priceOf?.(n)) && <span class="nft-tag" title={t('nft.floor')}><i aria-hidden="true" />{shortPrice(priceOf(n))}</span>}
              </span>
              <span class="nft-cap">
                <span class="nft-name">{n.name}</span>
                {n.collection && <span class="nft-col">{n.collection}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {good.length > FIRST && <button class="nft-more" onClick={() => setAll(!all)}>{all ? t('nft.less') : t('nft.all', { n: good.length })}</button>}
      {spam.length > 0 && (
        <>
          <button class="nft-more muted" onClick={() => setShowSpam(!showSpam)}>{showSpam ? t('nft.spamHide') : tn('nft.spamShow', spam.length)}</button>
          {showSpam && (
            <div class="card list" style={{ padding: '0.375rem' }}>
              <div class="warn small">{t('nft.spamHint')}</div>
              {spam.map((n) => (
                <button class="item" onClick={() => open(n)}>
                  <span class="nft-mini"><Art nft={n} /></span>
                  <div class="grow" style={{ minWidth: 0 }}><div class="bold ellipsis">{n.name}</div><div class="tiny muted ellipsis">{n.collection}</div></div>
                  <span class="badge red">{t('history.spam')}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The page of one NFT (wallet screen 'nft'). */
export function NftDetail({ nft, price: given }) {
  const { chain, account, back, toast, state } = useApp();
  const [price, setPrice] = useState(given);
  useEffect(() => { if (nft && !nft.spam) nftFloor(chain, nft, state.settings).then((v) => v && setPrice(v)).catch(() => {}); }, [nft?.key, state.settings.openseaKey, state.settings.nftHistory, state.settings.getgemsKey]);
  const [full, setFull] = useState(false);
  const [more, setMore] = useState(false);
  const [ready, setReady] = useState(false);
  const [scrolled, setScrolled] = useState(false); // past the title: the bar gets a background and the name
  if (!nft) return null;
  const drv = driverFor(chain);
  const explorer = drv.explorerNft?.(chain, nft);
  const collectionUrl = nft.collection ? drv.explorerToken?.(chain, nft.contract) : null;
  const copy = (v) => { navigator.clipboard.writeText(v); toast(t('common.copied')); };
  const id = nft.tokenId && nft.tokenId.length > 14 ? `${nft.tokenId.slice(0, 6)}…${nft.tokenId.slice(-4)}` : nft.tokenId;
  const longDesc = (nft.description || '').length > 220;
  const contract = nft.address || nft.contract;
  const backdrop = !nft.spam && nft.image;
  const idInName = nft.tokenId !== '' && nft.name.includes(`#${nft.tokenId}`); // "Fox #77": no "#77" again below
  return (
    <div class="screen nftd">
      <div class={`nftd-bar ${scrolled ? 'solid' : ''}`}>
        <button class="nftd-round" onClick={back} title={t('common.back')}><Icon name="back" /></button>
        <span class="nftd-bar-title">{nft.name}</span>
        {explorer ? <a class="nftd-round" href={explorer} target="_blank" rel="noopener" title={t('nft.explorer')}><Icon name="external" size={18} /></a> : <span class="nftd-gap" />}
      </div>
      <div class="content nftd-content" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 380)}>
        {backdrop
          ? <div class="nftd-ambient" aria-hidden="true"><img src={nft.image} alt="" referrerpolicy="no-referrer" /></div>
          : <div class="nftd-ambient ph" style={cardStyle(nft.key)} aria-hidden="true" />}
        <figure class={`nftd-frame ${ready || !backdrop ? 'in' : ''}`}>
          <Art nft={nft} onLoad={() => setReady(true)} onClick={() => backdrop && setFull(true)} />
        </figure>

        <header class="nftd-label">
          {nft.collection && <span class="nftd-kicker">{nft.collection}</span>}
          <h1 class="nftd-title">{nft.name}</h1>
          <span class="nftd-meta">
            {nft.tokenId !== '' && !idInName && <span>#{id}</span>}
            <span>{nft.standard}</span>
            <span class="nftd-net"><ChainIcon chain={chain} size={14} />{chain.name}</span>
          </span>
        </header>

        {price && !nft.spam && (
          <div class="nftd-price">
            <span class="k">{t('nft.floor')}</span>
            <span class="v">{fmtNum(price.native, 4)} <small>{price.symbol}</small></span>
            {price.usd != null && <span class="usd">≈ {fmtUsd(price.usd)}</span>}
          </div>
        )}
        {nft.spam && <div class="warn small">{t('nft.spamHint')}</div>}
        {nft.description && !nft.spam && (
          <div class="nftd-desc">
            <p class={longDesc && !more ? 'clamp' : ''}>{nft.description}</p>
            {longDesc && <button class="link small" onClick={() => setMore(!more)}>{more ? t('nft.readLess') : t('nft.readMore')}</button>}
          </div>
        )}

        {nft.traits?.length > 0 && !nft.spam && (
          <section class="nftd-block">
            <h2 class="nftd-h">{t('nft.traits')}</h2>
            <div class="nftd-traits">
              {nft.traits.map((x) => (
                <div class="nftd-trait">
                  {x.trait && <span class="k">{x.trait}</span>}
                  <span class="v">{x.value}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {!nft.spam && !chain.testnet && <NftChart chain={chain} nft={nft} price={price} />}

        <section class="nftd-block">
          <h2 class="nftd-h">{t('nft.details')}</h2>
          <div class="card kv nftd-kv">
            <span class="k">{t('nft.owner')}</span>
            <span class="v"><span class="nftd-owner"><Avatar address={account.address} />{account.name}</span></span>
            {nft.amount !== '1' && <><span class="k">{t('nft.amount')}</span><span class="v">{nft.amount}</span></>}
            <span class="k">{t('nft.contract')}</span>
            <span class="v"><button class="link mono small" onClick={() => copy(contract)}>{shortAddr(contract, 6)} <Icon name="copy" size={12} /></button></span>
            {nft.tokenId !== '' && <><span class="k">{t('nft.id')}</span><span class="v"><button class="link mono small" onClick={() => copy(nft.tokenId)}>{id} <Icon name="copy" size={12} /></button></span></>}
            {nft.onSale && <><span class="k">{t('nft.status')}</span><span class="v">{t('nft.onSale')}</span></>}
          </div>
        </section>

        <div class="nftd-actions">
          {explorer && <a class="btn secondary" href={explorer} target="_blank" rel="noopener"><Icon name="external" size={16} /> {t('nft.explorer')}</a>}
          {collectionUrl && <a class="link small nftd-collink" href={collectionUrl} target="_blank" rel="noopener">{t('nft.collectionLink', { name: nft.collection })}</a>}
        </div>
      </div>

      {full && (
        <div class="nftd-full" onClick={() => setFull(false)} role="dialog" aria-label={nft.name}>
          <img src={nft.image} alt={nft.name} referrerpolicy="no-referrer" />
          <button class="nftd-round close" title={t('common.close')}><Icon name="close" /></button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- price over time
const RANGES = [30, 90, 365]; // days
/** Sales grouped by period (day / week): the median of each, so one odd sale doesn't make a spike. */
export function bucketMedian(points, ms) {
  const groups = new Map();
  for (const x of points) { const k = Math.floor(x.t / ms); (groups.get(k) || groups.set(k, []).get(k)).push(x.p); }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([k, ps]) => {
    ps.sort((a, b) => a - b);
    const m = ps.length % 2 ? ps[(ps.length - 1) / 2] : (ps[ps.length / 2 - 1] + ps[ps.length / 2]) / 2;
    return { t: k * ms + ms / 2, p: m, n: ps.length };
  });
}

/**
 * Price of the collection over time: its sales (OpenSea / Getgems, with a key), else the floor prices this device
 * has read. The first time on EVM, before any choice: how to get the sales (automatic key, own key, device only).
 */
function NftChart({ chain, nft, price }) {
  const { state, refresh, nav } = useApp();
  const s = state.settings;
  const source = salesSource(chain, s);
  const ask = chain.kind !== 'ton' && !s.openseaKey?.trim() && s.nftHistory == null && salesSource(chain, { nftHistory: 'auto' });
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null); // { points, symbol, kind: 'sales' | 'device' }
  const [hover, setHover] = useState(null);
  const [busy, setBusy] = useState(false);
  const choose = async (mode) => {
    setBusy(true);
    await bg('saveSettings', { settings: { nftHistory: mode } }).catch(() => {});
    await refresh(); setBusy(false);
    if (mode === 'own') nav('settings');
  };
  useEffect(() => {
    if (ask) return undefined;
    let alive = true; setData(null); setHover(null);
    const device = async () => {
      const log = await floorLog(chain, nft);
      const since = Date.now() - days * 86400e3;
      return { points: log.filter((x) => x.t >= since).map((x) => ({ t: x.t, p: x.p })), symbol: log[log.length - 1]?.symbol || price?.symbol || chain.native.symbol, kind: 'device' };
    };
    (async () => {
      let r = null;
      if (source) {
        const sales = await nftSales(chain, nft, s, days).catch(() => null);
        if (sales?.points.length >= 2) r = { points: bucketMedian(sales.points, (days > 120 ? 7 : 1) * 86400e3), symbol: sales.symbol, kind: 'sales', source: sales.source };
      }
      r ??= await device();
      if (alive) setData(r);
    })();
    return () => { alive = false; };
  }, [nft.key, days, source, ask]);

  if (ask) {
    return (
      <section class="nftd-block">
        <h2 class="nftd-h">{t('nft.chart.title')}</h2>
        <div class="card nftd-ask">
          <span class="nftd-ask-ic"><Icon name="chart" size={20} /></span>
          <b>{t('nft.chart.ask.title')}</b>
          <p class="small muted">{t('nft.chart.ask.text')}</p>
          <Btn loading={busy} onClick={() => choose('auto')}>{t('nft.chart.ask.auto')}</Btn>
          <Btn kind="secondary" disabled={busy} onClick={() => choose('own')}>{t('nft.chart.ask.own')}</Btn>
          <button class="link small" disabled={busy} onClick={() => choose('local')}>{t('nft.chart.ask.local')}</button>
          <p class="tiny muted">{t('nft.chart.ask.privacy')}</p>
        </div>
      </section>
    );
  }

  const pts = data?.points || [];
  const unitMatches = price && data && String(price.symbol).toUpperCase() === String(data.symbol).toUpperCase();
  const now = unitMatches ? price.native : pts[pts.length - 1]?.p; // the current floor (as above), the chart's last point otherwise
  const shown = hover ? hover.p : now;
  const first = pts[0]?.p;
  const change = first && shown != null && pts.length > 1 ? ((shown - first) / first) * 100 : null;
  const unit = data?.symbol || '';
  const fmt = (v) => `${fmtNum(v, 4)} ${unit}`;
  const note = data?.kind === 'sales' ? t(data.source === 'getgems' ? 'nft.chart.salesGetgems' : 'nft.chart.salesOpensea')
    : chain.kind === 'ton' ? t('nft.chart.deviceTon')
      : s.nftHistory === 'own' && !s.openseaKey?.trim() ? t('nft.chart.deviceOwn') : t('nft.chart.device');
  return (
    <section class="nftd-block">
      <h2 class="nftd-h">{t('nft.chart.title')}</h2>
      <div class="card tk-chart nftd-chart">
        <div class="tk-chart-head">
          <span class="tk-chart-price">{shown != null ? fmt(shown) : '—'}</span>
          {change != null && Math.abs(change) >= 0.005 && <span class={`tk-chart-chg ${change > 0 ? 'up' : 'down'}`}>{change > 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}%</span>}
          <span class="tiny muted tk-chart-when">{hover ? new Date(hover.t).toLocaleDateString() : ''}</span>
        </div>
        {data === null ? <div class="pm-chart pm-chart-sk"><span class="skeleton" /></div>
          : pts.length < 2 ? <div class="pm-chart pm-chart-empty small muted">{t('nft.chart.empty')}</div>
            : <LineChart kind="price" points={pts} onHover={setHover} label={t('nft.chart.title')} fmtY={(v) => fmtNum(v, 3)} tipValue={fmt} />}
        <div class="tabs pm-intervals">
          {RANGES.map((d) => <button class={`tab ${days === d ? 'active' : ''}`} onClick={() => setDays(d)}>{t(`nft.chart.d${d}`)}</button>)}
        </div>
        <span class="tiny muted nftd-chart-note">{note}</span>
      </div>
    </section>
  );
}
